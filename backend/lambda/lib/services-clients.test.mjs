// Tests for services-clients.mjs. Focus on read-side queries (list,
// search, isFrequent...) plus the table-list/table-settings
// normalizers — those are the security-sensitive bits (phone fan-out
// for CRM search, frequent-table disable logic, reschedule-credit
// expiry display).
//
// Skipped (lower-leverage): create/update mutations with TransactWrite
// lock handling — the patterns are well-covered by the events tests
// and would mostly duplicate setup.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createClientsService } from "./services-clients.mjs";

const FIXED_NOW = 1_700_000_000;

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

// ---------------------------------------------------------------------------
// Phone helper stubs (deps that the service expects)
// ---------------------------------------------------------------------------

function normalizePhone(phone) {
  return String(phone ?? "").replace(/\D/g, "");
}
function normalizePhoneE164(phone, country) {
  const digits = normalizePhone(phone);
  if (!digits) return "";
  if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
  if (digits.startsWith("52") && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return country === "MX" ? `+52${digits}` : `+1${digits}`;
  return digits.startsWith("+") ? digits : `+${digits}`;
}
function normalizePhoneCountry(c) {
  return c === "MX" ? "MX" : "US";
}
function detectPhoneCountryFromE164(phone) {
  const p = String(phone ?? "");
  if (p.startsWith("+52")) return "MX";
  if (p.startsWith("+1")) return "US";
  return null;
}
function buildPhoneSearchCandidates(query) {
  const digits = normalizePhone(query);
  if (!digits) return [];
  // Mock: 10-digit US default → fan-out to digits + 1+digits
  if (digits.length === 10) return [digits, `1${digits}`];
  return [digits];
}

// ---------------------------------------------------------------------------
// Fake DDB
// ---------------------------------------------------------------------------

function makeFakeDdb({
  getResponses = [],
  queryResponses = [],
  scanResponses = [],
  throwOnCommand,
} = {}) {
  let getIdx = 0;
  let qIdx = 0;
  let sIdx = 0;
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (throwOnCommand?.[name]) throw throwOnCommand[name];
      if (name === "GetCommand") return getResponses[getIdx++] ?? { Item: null };
      if (name === "QueryCommand") return queryResponses[qIdx++] ?? { Items: [] };
      if (name === "ScanCommand") return scanResponses[sIdx++] ?? { Items: [] };
      return {};
    },
  };
}

// Real impl from core-utils — kept inline to avoid coupling tests to imports.
function normalizeNameForSearch(name) {
  if (name === null || name === undefined) return "";
  return String(name)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildService(overrides = {}) {
  const ddb = overrides.ddb ?? makeFakeDdb();
  const svc = createClientsService({
    ddb,
    tableNames: {
      FREQUENT_CLIENTS_TABLE: "ff-frequent-clients",
      CLIENTS_TABLE: "ff-clients",
      HOLDS_TABLE: "ff-table-holds",
      RES_TABLE: "ff-reservations",
    },
    requiredEnv: (n, v) => v,
    normalizePhone,
    normalizePhoneE164,
    normalizePhoneCountry,
    detectPhoneCountryFromE164,
    buildPhoneSearchCandidates,
    normalizeNameForSearch,
    nowEpoch: () => FIXED_NOW,
    httpError,
    addDaysToIsoDate: (date, n) => {
      const [y, m, d] = String(date).split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + Number(n));
      return dt.toISOString().slice(0, 10);
    },
    getTablePriceForEvent: (event, tableId) => event?.tablePrices?.[tableId] ?? null,
  });
  return { ddb, svc };
}

// ---------------------------------------------------------------------------
// normalizeTableList
// ---------------------------------------------------------------------------

describe("normalizeTableList", () => {
  it("returns [] for null / undefined / empty", () => {
    const { svc } = buildService();
    assert.deepEqual(svc.normalizeTableList(null), []);
    assert.deepEqual(svc.normalizeTableList(undefined), []);
    assert.deepEqual(svc.normalizeTableList(""), []);
  });
  it("splits comma-separated strings and trims whitespace", () => {
    const { svc } = buildService();
    assert.deepEqual(svc.normalizeTableList("A1, A2,B1"), ["A1", "A2", "B1"]);
    assert.deepEqual(svc.normalizeTableList("  A1 ,  , B2 "), ["A1", "B2"]);
  });
  it("trims arrays and drops empty strings (NOTE: null becomes literal 'null' string due to String(null) coercion — latent quirk)", () => {
    const { svc } = buildService();
    // Empty strings are dropped (filter(Boolean)), but String(null) === "null"
    // which is truthy. Real-world data shouldn't include nulls in the array,
    // so this isn't a fix-blocker — documented to catch regressions if the
    // implementation ever changes.
    assert.deepEqual(svc.normalizeTableList(["A1", " A2 ", "", "B1"]), [
      "A1",
      "A2",
      "B1",
    ]);
    assert.deepEqual(svc.normalizeTableList([null, undefined]), ["null", "undefined"]);
  });
  it("returns [] for unsupported input types", () => {
    const { svc } = buildService();
    assert.deepEqual(svc.normalizeTableList({ a: 1 }), []);
    assert.deepEqual(svc.normalizeTableList(123), []);
  });
});

// ---------------------------------------------------------------------------
// normalizeTableSettings
// ---------------------------------------------------------------------------

describe("normalizeTableSettings", () => {
  it("returns [] for null / non-array", () => {
    const { svc } = buildService();
    assert.deepEqual(svc.normalizeTableSettings(null), []);
    assert.deepEqual(svc.normalizeTableSettings("not array"), []);
  });
  it("normalizes shape + drops entries without tableId", () => {
    const { svc } = buildService();
    const out = svc.normalizeTableSettings([
      { tableId: "A1", paymentStatus: "paid", amountDue: "100", amountPaid: "100" },
      { tableId: "  ", paymentStatus: "PARTIAL" }, // empty tableId after trim → dropped
      { tableId: "B1" }, // missing fields → defaults
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].tableId, "A1");
    assert.equal(out[0].paymentStatus, "PAID"); // upper-cased
    assert.equal(out[0].amountDue, 100); // coerced to number
    assert.equal(out[0].amountPaid, 100);
    assert.equal(out[1].tableId, "B1");
    assert.equal(out[1].paymentStatus, "PENDING"); // default
    assert.equal(out[1].amountDue, 0);
    assert.equal(out[1].amountPaid, 0);
    assert.equal(out[1].paymentDeadlineTime, "00:00");
    assert.equal(out[1].paymentDeadlineTz, "America/Chicago");
  });
});

// ---------------------------------------------------------------------------
// getFrequentClientById
// ---------------------------------------------------------------------------

describe("getFrequentClientById", () => {
  it("returns null when not found", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({ ddb });
    assert.equal(await svc.getFrequentClientById("c1"), null);
  });

  it("normalizes defaultTableIds (string-form) + tableSettings", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: {
            clientId: "c1",
            name: "Alice",
            defaultTableIds: "A1, A2",
            tableSettings: [{ tableId: "A1", paymentStatus: "paid" }],
          },
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.getFrequentClientById("c1");
    assert.deepEqual(out.defaultTableIds, ["A1", "A2"]);
    assert.equal(out.tableSettings[0].paymentStatus, "PAID");
    // Verify Get key shape
    assert.equal(ddb.calls[0].input.Key.PK, "CLIENT");
    assert.equal(ddb.calls[0].input.Key.SK, "CLIENT#c1");
  });

  it("falls back to legacy defaultTableId field", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: { clientId: "c1", defaultTableId: "A1" } }],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.getFrequentClientById("c1");
    assert.deepEqual(out.defaultTableIds, ["A1"]);
  });
});

// ---------------------------------------------------------------------------
// listFrequentClients
// ---------------------------------------------------------------------------

describe("listFrequentClients", () => {
  it("queries with CLIENT# SK prefix + normalizes table fields per item", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            { clientId: "c1", defaultTableIds: "A1, A2" },
            { clientId: "c2", defaultTableId: "B1", tableSettings: [{ tableId: "B1" }] },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.listFrequentClients();
    assert.equal(ddb.calls[0].input.ExpressionAttributeValues[":pk"], "CLIENT");
    assert.equal(ddb.calls[0].input.ExpressionAttributeValues[":sk"], "CLIENT#");
    assert.deepEqual(out[0].defaultTableIds, ["A1", "A2"]);
    assert.deepEqual(out[1].defaultTableIds, ["B1"]);
    assert.equal(out[1].tableSettings[0].tableId, "B1");
  });
});

// ---------------------------------------------------------------------------
// searchCrmClients (phone fan-out + dedup)
// ---------------------------------------------------------------------------

describe("searchCrmClients", () => {
  it("returns [] for empty / unparseable phone (no DDB calls)", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb });
    assert.deepEqual(await svc.searchCrmClients(""), []);
    assert.deepEqual(await svc.searchCrmClients("---"), []);
    assert.equal(ddb.calls.length, 0);
  });

  it("issues one Query per phone candidate with PHONE# SK prefix", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        { Items: [{ SK: "PHONE#2025550100", name: "Alice", lastReservationAt: 100 }] },
        { Items: [{ SK: "PHONE#12025550100", name: "Alice", lastReservationAt: 100 }] },
      ],
    });
    const { svc } = buildService({ ddb });
    await svc.searchCrmClients("2025550100");

    const queries = ddb.calls.filter((c) => c.name === "QueryCommand");
    assert.equal(queries.length, 2);
    assert.match(
      queries[0].input.ExpressionAttributeValues[":sk"],
      /^PHONE#2025550100/
    );
    assert.match(
      queries[1].input.ExpressionAttributeValues[":sk"],
      /^PHONE#12025550100/
    );
    // Per-query Limit + descending scan (newest first)
    assert.equal(queries[0].input.Limit, 10);
    assert.equal(queries[0].input.ScanIndexForward, false);
  });

  it("dedups results across multiple candidates by SK", async () => {
    const sameItem = {
      SK: "PHONE#12025550100",
      name: "Alice",
      phone: "+12025550100",
      lastReservationAt: 1000,
    };
    const ddb = makeFakeDdb({
      queryResponses: [
        { Items: [sameItem] },
        { Items: [sameItem] }, // duplicate from different candidate
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients("2025550100");
    assert.equal(out.length, 1, "dedups by SK");
  });

  it("sorts by lastReservationAt descending", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            { SK: "PHONE#1", name: "Older", lastReservationAt: 100 },
            { SK: "PHONE#2", name: "Newer", lastReservationAt: 1000 },
          ],
        },
        { Items: [] },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients("2025550100");
    assert.equal(out[0].name, "Newer");
    assert.equal(out[1].name, "Older");
  });

  it("strips internal DDB attributes from output (no SK/PK leak)", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            {
              PK: "CLIENT",
              SK: "PHONE#12025550100",
              name: "Alice",
              phone: "+12025550100",
              phoneCountry: "US",
              lastReservationAt: 100,
              internalSecret: "should-not-leak",
            },
          ],
        },
        { Items: [] },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients("2025550100");
    assert.equal(out[0].PK, undefined);
    assert.equal(out[0].SK, undefined);
    assert.equal(out[0].internalSecret, undefined);
    assert.equal(out[0].name, "Alice");
  });
});

// ---------------------------------------------------------------------------
// listCrmClients
// ---------------------------------------------------------------------------

describe("listCrmClients", () => {
  it("queries CLIENTS_TABLE with PHONE# SK prefix + sorts by lastReservationAt desc", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            { name: "A", lastReservationAt: 100 },
            { name: "B", lastReservationAt: 1000 },
            { name: "C", lastReservationAt: 500 },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.listCrmClients();
    assert.equal(ddb.calls[0].input.TableName, "ff-clients");
    assert.equal(ddb.calls[0].input.ExpressionAttributeValues[":sk"], "PHONE#");
    assert.deepEqual(
      out.map((c) => c.name),
      ["B", "C", "A"]
    );
  });

  it("strips internal attributes (no PK/SK in response)", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            {
              PK: "CLIENT",
              SK: "PHONE#1",
              name: "A",
              phone: "+1",
              internalSecret: "x",
            },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const [out] = await svc.listCrmClients();
    assert.equal(out.PK, undefined);
    assert.equal(out.SK, undefined);
    assert.equal(out.internalSecret, undefined);
  });
});

// ---------------------------------------------------------------------------
// listRescheduleCreditsByPhone
// ---------------------------------------------------------------------------

describe("listRescheduleCreditsByPhone", () => {
  it("400 when phone is invalid", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.listRescheduleCreditsByPhone("---"),
      (err) => err?.statusCode === 400
    );
  });

  it("filters non-RESCHEDULE_CREDIT entityType silently", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            { entityType: "RESCHEDULE_CREDIT", creditId: "c1", amountRemaining: 50 },
            { entityType: "OTHER", creditId: "c2" },
            { entityType: "reschedule_credit", creditId: "c3", amountRemaining: 30 },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.listRescheduleCreditsByPhone("2025550100");
    // Both c1 and c3 (case-insensitive entityType match)
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((c) => c.creditId).sort(),
      ["c1", "c3"]
    );
  });

  it("flips ACTIVE+expired-date credit to EXPIRED status (read-time only)", async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            {
              entityType: "RESCHEDULE_CREDIT",
              creditId: "c-expired",
              status: "ACTIVE",
              expiresAt: yesterday,
              amountRemaining: 50,
            },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const [out] = await svc.listRescheduleCreditsByPhone("2025550100");
    assert.equal(out.status, "EXPIRED");
  });

  it("preserves non-ACTIVE statuses unchanged regardless of expiry", async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            {
              entityType: "RESCHEDULE_CREDIT",
              creditId: "c-used",
              status: "USED",
              expiresAt: yesterday,
            },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const [out] = await svc.listRescheduleCreditsByPhone("2025550100");
    assert.equal(out.status, "USED");
  });

  it("sorts by status (ACTIVE → EXPIRED → USED → REVOKED) then issuedAt desc", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            { entityType: "RESCHEDULE_CREDIT", creditId: "c-revoked", status: "REVOKED", issuedAt: 1000 },
            { entityType: "RESCHEDULE_CREDIT", creditId: "c-active1", status: "ACTIVE", issuedAt: 500 },
            { entityType: "RESCHEDULE_CREDIT", creditId: "c-used", status: "USED", issuedAt: 1000 },
            { entityType: "RESCHEDULE_CREDIT", creditId: "c-active2", status: "ACTIVE", issuedAt: 1000 },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.listRescheduleCreditsByPhone("2025550100");
    assert.deepEqual(
      out.map((c) => c.creditId),
      ["c-active2", "c-active1", "c-used", "c-revoked"]
    );
  });

  it("queries with CREDIT#PHONE# SK prefix on the CLIENTS_TABLE", async () => {
    const ddb = makeFakeDdb({ queryResponses: [{ Items: [] }] });
    const { svc } = buildService({ ddb });
    await svc.listRescheduleCreditsByPhone("2025550100", "US");
    const q = ddb.calls[0];
    assert.equal(q.name, "QueryCommand");
    assert.equal(q.input.TableName, "ff-clients");
    assert.match(q.input.ExpressionAttributeValues[":sk"], /^CREDIT#PHONE#/);
  });
});

// ---------------------------------------------------------------------------
// isFrequentReservationByPhoneAndTable
// ---------------------------------------------------------------------------

describe("isFrequentReservationByPhoneAndTable", () => {
  it("returns false when table or phone is missing", async () => {
    const { svc } = buildService();
    assert.equal(
      await svc.isFrequentReservationByPhoneAndTable({ phone: "", tableId: "A1" }),
      false
    );
    assert.equal(
      await svc.isFrequentReservationByPhoneAndTable({ phone: "+12025550100", tableId: "" }),
      false
    );
  });

  it("returns false when no frequent client matches the phone", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            { clientId: "c1", phone: "+15555555555", phoneCountry: "US", status: "ACTIVE", defaultTableIds: "A1" },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.isFrequentReservationByPhoneAndTable({
      phone: "+12025550100",
      phoneCountry: "US",
      tableId: "A1",
    });
    assert.equal(out, false);
  });

  it("ignores INACTIVE / DISABLED clients (status filter)", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            { clientId: "c1", phone: "+12025550100", phoneCountry: "US", status: "DISABLED", defaultTableIds: "A1" },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.isFrequentReservationByPhoneAndTable({
      phone: "+12025550100",
      phoneCountry: "US",
      tableId: "A1",
    });
    assert.equal(out, false);
  });

  it("returns true when phone + table match (via tableSettings)", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            {
              clientId: "c1",
              phone: "+12025550100",
              phoneCountry: "US",
              status: "ACTIVE",
              tableSettings: [{ tableId: "A1" }, { tableId: "A2" }],
            },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.isFrequentReservationByPhoneAndTable({
      phone: "+12025550100",
      phoneCountry: "US",
      tableId: "A1",
    });
    assert.equal(out, true);
  });

  it("returns true when phone + table match (via defaultTableIds string)", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            {
              clientId: "c1",
              phone: "+12025550100",
              phoneCountry: "US",
              status: "ACTIVE",
              defaultTableIds: "A1, A2",
            },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.isFrequentReservationByPhoneAndTable({
      phone: "+12025550100",
      phoneCountry: "US",
      tableId: "A2",
    });
    assert.equal(out, true);
  });

  it("returns true (phone-match-only) when phone matches but table doesn't (auto-frequent semantics)", async () => {
    // Note: per the implementation, phone match alone returns true if no table match
    // is found across any matching client. This is the security-sensitive bit:
    // a phone match is enough to mark the reservation as frequent, even if the
    // specific table isn't in the client's default set.
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            {
              clientId: "c1",
              phone: "+12025550100",
              phoneCountry: "US",
              status: "ACTIVE",
              defaultTableIds: "B1",
            },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.isFrequentReservationByPhoneAndTable({
      phone: "+12025550100",
      phoneCountry: "US",
      tableId: "A1",
    });
    assert.equal(out, true);
  });
});

// ---------------------------------------------------------------------------
// getDisabledTablesFromFrequent
// ---------------------------------------------------------------------------

describe("getDisabledTablesFromFrequent", () => {
  it("returns empty Set when no clients", async () => {
    const ddb = makeFakeDdb({ queryResponses: [{ Items: [] }] });
    const { svc } = buildService({ ddb });
    const out = await svc.getDisabledTablesFromFrequent({});
    assert.equal(out.size, 0);
  });

  it("collects all default table IDs from ACTIVE clients into the disabled set", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            { clientId: "c1", status: "ACTIVE", defaultTableIds: "A1,A2" },
            { clientId: "c2", status: "ACTIVE", tableSettings: [{ tableId: "B1" }] },
            { clientId: "c3", status: "DISABLED", defaultTableIds: "C1" }, // skipped
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.getDisabledTablesFromFrequent({});
    assert.deepEqual([...out].sort(), ["A1", "A2", "B1"]);
  });

  it("respects eventRecord.disabledClients (per-event opt-out for a frequent client)", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            { clientId: "c1", status: "ACTIVE", defaultTableIds: "A1" },
            { clientId: "c2", status: "ACTIVE", defaultTableIds: "A2" },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.getDisabledTablesFromFrequent({ disabledClients: ["c1"] });
    assert.deepEqual([...out], ["A2"]);
  });

  it("respects eventRecord.frequentReleasedTables (table re-released to public after auto-cancel)", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        {
          Items: [
            { clientId: "c1", status: "ACTIVE", defaultTableIds: "A1,A2" },
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.getDisabledTablesFromFrequent({
      frequentReleasedTables: ["A1"],
    });
    // A1 was released, so only A2 is still disabled
    assert.deepEqual([...out], ["A2"]);
  });
});

// ---------------------------------------------------------------------------
// deleteFrequentClient
// ---------------------------------------------------------------------------

describe("deleteFrequentClient", () => {
  it("issues a Delete with PK=CLIENT, SK=CLIENT#<id> on FREQUENT_CLIENTS_TABLE", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildService({ ddb });
    await svc.deleteFrequentClient("c1");
    assert.equal(ddb.calls[0].name, "DeleteCommand");
    assert.equal(ddb.calls[0].input.TableName, "ff-frequent-clients");
    assert.equal(ddb.calls[0].input.Key.PK, "CLIENT");
    assert.equal(ddb.calls[0].input.Key.SK, "CLIENT#c1");
  });
});

// ---------------------------------------------------------------------------
// bulkImportCrmClients
// ---------------------------------------------------------------------------

// Custom DDB fake for bulk import — supports per-Put outcomes (ok / conditional /
// throw). Tracks each Put's Item + ConditionExpression so we can assert on the
// idempotency clause too.
function makeBulkDdb({ outcomes = {} } = {}) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (name !== "PutCommand") return {};
      const sk = cmd.input?.Item?.SK;
      const outcome = outcomes[sk];
      if (outcome === "conditional") {
        const err = new Error("conditional check failed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      if (outcome === "throw") {
        throw new Error("ddb is angry");
      }
      return {};
    },
  };
}

describe("bulkImportCrmClients", () => {
  it("rejects when payload is not an array", async () => {
    const { svc } = buildService();
    await assert.rejects(svc.bulkImportCrmClients({}, "u"), /contacts must be an array/);
    await assert.rejects(svc.bulkImportCrmClients({ contacts: "no" }, "u"), /contacts must be an array/);
  });

  it("returns all-zero summary on empty array (no DDB calls)", async () => {
    const ddb = makeBulkDdb();
    const { svc } = buildService({ ddb });
    const out = await svc.bulkImportCrmClients({ contacts: [] }, "u");
    assert.deepEqual(out, {
      imported: 0,
      skipped: 0,
      invalid: 0,
      errors: 0,
      invalidDetails: [],
      errorDetails: [],
    });
    assert.equal(ddb.calls.length, 0);
  });

  it("rejects batches over 500 entries", async () => {
    const { svc } = buildService();
    const contacts = Array.from({ length: 501 }, (_, i) => ({
      name: `n${i}`,
      phone: `956000${String(i).padStart(4, "0")}`,
    }));
    await assert.rejects(svc.bulkImportCrmClients({ contacts }, "u"), /at most 500/);
  });

  it("imports a fresh contact: PutItem with conditional, computes lastReservationAt from lastEventDate", async () => {
    const ddb = makeBulkDdb();
    const { svc } = buildService({ ddb });
    const out = await svc.bulkImportCrmClients(
      {
        contacts: [
          {
            name: "Miriam Olivares",
            phone: "9566014675",
            phoneCountry: "US",
            totalReservations: 93,
            totalSpend: 3440,
            lastEventDate: "2026-05-16",
          },
        ],
      },
      "import-tool"
    );
    assert.equal(out.imported, 1);
    assert.equal(out.skipped, 0);
    assert.equal(out.invalid, 0);
    assert.equal(out.errors, 0);

    assert.equal(ddb.calls.length, 1);
    const put = ddb.calls[0];
    assert.equal(put.name, "PutCommand");
    assert.equal(put.input.TableName, "ff-clients");
    assert.equal(
      put.input.ConditionExpression,
      "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    );
    const item = put.input.Item;
    assert.equal(item.PK, "CLIENT");
    assert.equal(item.SK, "PHONE#19566014675");
    assert.equal(item.name, "Miriam Olivares");
    assert.equal(item.phone, "+19566014675");
    assert.equal(item.phoneCountry, "US");
    assert.equal(item.totalReservations, 93);
    assert.equal(item.totalSpend, 3440);
    assert.equal(item.lastEventDate, "2026-05-16");
    // 2026-05-16T00:00:00Z = 1779235200 epoch seconds
    assert.equal(item.lastReservationAt, Date.UTC(2026, 4, 16) / 1000);
    assert.equal(item.importedBy, "import-tool");
    assert.equal(item.updatedBy, "import-tool");
    assert.equal(typeof item.importedAt, "number");
  });

  it("counts skipped when DDB throws ConditionalCheckFailedException (row already exists)", async () => {
    const ddb = makeBulkDdb({
      outcomes: { "PHONE#19566014675": "conditional" },
    });
    const { svc } = buildService({ ddb });
    const out = await svc.bulkImportCrmClients(
      {
        contacts: [
          { name: "Miriam", phone: "9566014675" },
          { name: "Daniel", phone: "9562237227" },
        ],
      },
      "u"
    );
    assert.equal(out.imported, 1);
    assert.equal(out.skipped, 1);
    assert.equal(out.invalid, 0);
    assert.equal(out.errors, 0);
  });

  it("flags invalid rows: missing name, unparseable phone", async () => {
    const ddb = makeBulkDdb();
    const { svc } = buildService({ ddb });
    const out = await svc.bulkImportCrmClients(
      {
        contacts: [
          { name: "", phone: "9566014675" },         // no name
          { name: "Bob", phone: "" },                 // no phone
          { name: "Eve", phone: "garbage" },          // unparseable
          { name: "OK", phone: "9562237227" },        // valid
        ],
      },
      "u"
    );
    assert.equal(out.imported, 1);
    assert.equal(out.invalid, 3);
    assert.equal(out.errors, 0);
    assert.equal(out.invalidDetails.length, 3);
    assert.deepEqual(
      out.invalidDetails.map((d) => d.index),
      [0, 1, 2]
    );
    assert.match(out.invalidDetails[0].reason, /name/);
    assert.match(out.invalidDetails[1].reason, /phone/);
    assert.match(out.invalidDetails[2].reason, /phone/);
    // Only the valid row should hit DDB
    assert.equal(ddb.calls.length, 1);
  });

  it("captures unexpected DDB errors in errorDetails (does not throw)", async () => {
    const ddb = makeBulkDdb({
      outcomes: { "PHONE#19566014675": "throw" },
    });
    const { svc } = buildService({ ddb });
    const out = await svc.bulkImportCrmClients(
      {
        contacts: [
          { name: "Miriam", phone: "9566014675" },
          { name: "Daniel", phone: "9562237227" },
        ],
      },
      "u"
    );
    assert.equal(out.imported, 1);
    assert.equal(out.skipped, 0);
    assert.equal(out.errors, 1);
    assert.equal(out.errorDetails.length, 1);
    assert.equal(out.errorDetails[0].phone, "+19566014675");
    assert.match(out.errorDetails[0].error, /angry/);
  });

  it("defaults numeric fields to 0 when missing or non-finite, lastEventDate is nullable", async () => {
    const ddb = makeBulkDdb();
    const { svc } = buildService({ ddb });
    await svc.bulkImportCrmClients(
      {
        contacts: [
          {
            name: "Sparse",
            phone: "9566014675",
            // no totalReservations, totalSpend, lastEventDate
          },
          {
            name: "Garbage Numbers",
            phone: "9562237227",
            totalReservations: "not a number",
            totalSpend: NaN,
            lastEventDate: "not-a-date",
          },
        ],
      },
      "u"
    );
    const items = ddb.calls.map((c) => c.input.Item);
    assert.equal(items[0].totalReservations, 0);
    assert.equal(items[0].totalSpend, 0);
    assert.equal(items[0].lastReservationAt, null);
    assert.equal(items[0].lastEventDate, null);
    assert.equal(items[1].totalReservations, 0);
    assert.equal(items[1].totalSpend, 0);
    assert.equal(items[1].lastReservationAt, null);
  });

  it("processes a mixed batch end-to-end with concurrency", async () => {
    const ddb = makeBulkDdb({
      outcomes: {
        // mark a few as already-exists
        "PHONE#19566014675": "conditional",
        "PHONE#19562237227": "conditional",
        // mark one as a hard error
        "PHONE#19565992701": "throw",
      },
    });
    const { svc } = buildService({ ddb });
    const contacts = [
      { name: "Miriam", phone: "9566014675" },     // skipped
      { name: "Daniel", phone: "9562237227" },     // skipped
      { name: "Angel", phone: "9565992701" },      // error
      { name: "Magaly", phone: "9562703640" },     // imported
      { name: "Dulce", phone: "9565030722" },      // imported
      { name: "", phone: "9568442112" },            // invalid (no name)
      { name: "Olga", phone: "9566480310" },       // imported
    ];
    const out = await svc.bulkImportCrmClients({ contacts }, "u");
    assert.equal(out.imported, 3);
    assert.equal(out.skipped, 2);
    assert.equal(out.errors, 1);
    assert.equal(out.invalid, 1);
    // Invalid entry never reached DDB — 6 entries had a Put attempted
    const putCalls = ddb.calls.filter((c) => c.name === "PutCommand");
    assert.equal(putCalls.length, 6);
  });
});

// ---------------------------------------------------------------------------
// searchCrmClients (phone + q)
// ---------------------------------------------------------------------------

describe("searchCrmClients", () => {
  function makeRow(name, phone, lastReservationAt = 0) {
    return {
      PK: "CLIENT",
      SK: `PHONE#${phone.replace(/\D/g, "")}`,
      name,
      phone,
      phoneCountry: "US",
      totalSpend: 100,
      totalReservations: 1,
      lastReservationAt,
      lastEventDate: "2026-05-01",
      lastTableId: "A1",
      updatedBy: "Legacy",
    };
  }

  it("backwards-compatible: passing a string runs phone search", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [
        { Items: [makeRow("Julio Torres", "+19564147489")] },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients("9564147489");
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "Julio Torres");
    // Did not call Scan
    assert.equal(ddb.calls.filter((c) => c.name === "ScanCommand").length, 0);
  });

  it("phone only via {phone}: same as backwards-compat path", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [{ Items: [makeRow("Julio Torres", "+19564147489")] }],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients({ phone: "9564147489" });
    assert.equal(out.length, 1);
  });

  it("q only: scans CLIENTS_TABLE, filters by accent-insensitive substring", async () => {
    const ddb = makeFakeDdb({
      scanResponses: [
        {
          Items: [
            makeRow("Julián García", "+12025550101", 100),
            makeRow("Pedro García", "+12025550102", 200),
            makeRow("Some Other Person", "+12025550103", 300),
          ],
        },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients({ q: "garcia" });
    // Both García rows match (accent-insensitive)
    assert.equal(out.length, 2);
    // Sorted by lastReservationAt desc — Pedro (200) first, Julián (100) second
    assert.equal(out[0].name, "Pedro García");
    assert.equal(out[1].name, "Julián García");

    // The Scan should target PK=CLIENT + SK begins_with PHONE# (so it doesn't
    // pick up CREDIT# rows that share the same partition).
    const scanCall = ddb.calls.find((c) => c.name === "ScanCommand");
    assert.ok(scanCall, "expected a ScanCommand");
    assert.match(scanCall.input.FilterExpression, /PK = :pk AND begins_with\(SK, :sk\)/);
    assert.equal(scanCall.input.ExpressionAttributeValues[":pk"], "CLIENT");
    assert.equal(scanCall.input.ExpressionAttributeValues[":sk"], "PHONE#");
  });

  it("q is case-insensitive", async () => {
    const ddb = makeFakeDdb({
      scanResponses: [
        { Items: [makeRow("JULIO TORRES", "+19564147489")] },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients({ q: "julio" });
    assert.equal(out.length, 1);
  });

  it("q ignored when shorter than 2 chars (avoids returning whole table)", async () => {
    const ddb = makeFakeDdb({
      scanResponses: [{ Items: [makeRow("Anyone", "+19999999999")] }],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients({ q: "j" });
    assert.equal(out.length, 0);
    assert.equal(ddb.calls.filter((c) => c.name === "ScanCommand").length, 0);
  });

  it("phone + q combined: results are deduped by SK", async () => {
    const julioRow = makeRow("Julio Torres", "+19564147489", 500);
    const ddb = makeFakeDdb({
      queryResponses: [{ Items: [julioRow] }],
      scanResponses: [
        { Items: [julioRow, makeRow("Other Julio", "+19567802470", 200)] },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients({ phone: "9564147489", q: "julio" });
    // 2 unique results, not 3
    assert.equal(out.length, 2);
    const names = out.map((x) => x.name);
    assert.ok(names.includes("Julio Torres"));
    assert.ok(names.includes("Other Julio"));
  });

  it("sorts by lastReservationAt desc, caps at 10", async () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      makeRow(`Person ${i}`, `+1202555${String(i).padStart(4, "0")}`, i * 10)
    );
    const ddb = makeFakeDdb({ scanResponses: [{ Items: items }] });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients({ q: "person" });
    assert.equal(out.length, 10);
    assert.equal(out[0].name, "Person 14"); // highest lastReservationAt
    assert.equal(out[9].name, "Person 5");
  });

  it("paginates Scan when LastEvaluatedKey is returned", async () => {
    const ddb = makeFakeDdb({
      scanResponses: [
        {
          Items: [makeRow("Page 1 Match", "+12025550001")],
          LastEvaluatedKey: { PK: "CLIENT", SK: "PHONE#x" },
        },
        { Items: [makeRow("Page 2 Match", "+12025550002")] },
      ],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients({ q: "page" });
    assert.equal(out.length, 2);
    assert.equal(ddb.calls.filter((c) => c.name === "ScanCommand").length, 2);
  });

  it("returns [] when neither phone nor q matches", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [{ Items: [] }],
      scanResponses: [{ Items: [] }],
    });
    const { svc } = buildService({ ddb });
    const out = await svc.searchCrmClients({ phone: "9999999999", q: "nobody" });
    assert.deepEqual(out, []);
  });
});
