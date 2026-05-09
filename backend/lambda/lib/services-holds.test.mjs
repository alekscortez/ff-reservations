// Tests for services-holds.mjs (PR #7). Verifies the createHold ->
// PutCommand wiring with conditional expressions, releaseHold semantics,
// and the createHold pre-checks (event existence, disabled-table guard,
// invalid input handling).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createHoldsService } from "./services-holds.mjs";

const FIXED_NOW = 1_700_000_000;

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function makeFakeDdb({ throwOnPut } = {}) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (name === "PutCommand" && throwOnPut) throw throwOnPut;
      if (name === "QueryCommand") return { Items: [] };
      return {};
    },
  };
}

function makeFakeShared() {
  return {
    getRuntimeSettings: async () => null,
    resolveHoldTtlSeconds: () => 300,
  };
}

function buildHolds(overrides = {}) {
  const ddb = overrides.ddb ?? makeFakeDdb();
  const releaseOverdueReservationsForEventDate =
    overrides.releaseOverdueReservationsForEventDate ?? (async () => ({ released: 0 }));
  return {
    ddb,
    releaseCalls: [],
    svc: createHoldsService(
      {
        ddb,
        tableNames: { HOLDS_TABLE: "ff-table-holds" },
        requiredEnv: (n, v) => v,
        httpError,
        nowEpoch: () => FIXED_NOW,
        randomUUID: () => "fake-hold-uuid",
        normalizePhoneCountry: (c) => (c === "MX" ? "MX" : "US"),
        normalizePhoneE164: (p) => (p ? String(p).replace(/[^\d+]/g, "") : ""),
        detectPhoneCountryFromE164: (p) => (String(p).startsWith("+52") ? "MX" : "US"),
        getEventByDate: overrides.getEventByDate ?? (async () => ({ eventId: "e1", disabledTables: [] })),
        getDisabledTablesFromFrequent: overrides.getDisabledTablesFromFrequent ?? (async () => new Set()),
      },
      makeFakeShared(),
      { releaseOverdueReservationsForEventDate }
    ),
  };
}

describe("listTableLocks", () => {
  it("queries with the correct PK + TABLE# SK prefix", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildHolds({ ddb });
    await svc.listTableLocks("2026-05-09");
    const q = ddb.calls[0];
    assert.equal(q.name, "QueryCommand");
    assert.equal(q.input.TableName, "ff-table-holds");
    assert.equal(q.input.ExpressionAttributeValues[":pk"], "EVENTDATE#2026-05-09");
    assert.equal(q.input.ExpressionAttributeValues[":sk"], "TABLE#");
  });
});

describe("listHolds", () => {
  it("delegates to listTableLocks", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildHolds({ ddb });
    await svc.listHolds("2026-05-09");
    assert.equal(ddb.calls.length, 1);
    assert.equal(ddb.calls[0].name, "QueryCommand");
  });
});

describe("releaseHold", () => {
  it("issues a Delete with HOLD lockType ConditionExpression", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildHolds({ ddb });
    await svc.releaseHold("2026-05-09", "T1");
    assert.equal(ddb.calls.length, 1);
    const d = ddb.calls[0];
    assert.equal(d.name, "DeleteCommand");
    assert.equal(d.input.Key.PK, "EVENTDATE#2026-05-09");
    assert.equal(d.input.Key.SK, "TABLE#T1");
    assert.equal(d.input.ConditionExpression, "lockType = :hold");
  });
});

describe("createHold validation", () => {
  it("throws 400 on invalid eventDate", async () => {
    const { svc } = buildHolds();
    await assert.rejects(
      () => svc.createHold({ eventDate: "garbage", tableId: "T1" }, "u"),
      (err) => err?.statusCode === 400
    );
  });

  it("throws 400 when tableId is missing", async () => {
    const { svc } = buildHolds();
    await assert.rejects(
      () => svc.createHold({ eventDate: "2026-05-09" }, "u"),
      (err) => err?.statusCode === 400
    );
  });

  it("throws 404 when the event doesn't exist", async () => {
    const { svc } = buildHolds({ getEventByDate: async () => null });
    await assert.rejects(
      () => svc.createHold({ eventDate: "2026-05-09", tableId: "T1" }, "u"),
      (err) => err?.statusCode === 404
    );
  });

  it("throws 409 when the table is in eventRecord.disabledTables", async () => {
    const { svc } = buildHolds({
      getEventByDate: async () => ({ eventId: "e1", disabledTables: ["T1"] }),
    });
    await assert.rejects(
      () => svc.createHold({ eventDate: "2026-05-09", tableId: "T1" }, "u"),
      (err) => err?.statusCode === 409
    );
  });

  it("throws 409 when the table is disabled-from-frequent", async () => {
    const { svc } = buildHolds({
      getDisabledTablesFromFrequent: async () => new Set(["T1"]),
    });
    await assert.rejects(
      () => svc.createHold({ eventDate: "2026-05-09", tableId: "T1" }, "u"),
      (err) => err?.statusCode === 409
    );
  });
});

describe("createHold happy path", () => {
  it("kicks an overdue sweep before allocating, then writes the hold row", async () => {
    let releaseCalls = 0;
    const ddb = makeFakeDdb();
    const { svc } = buildHolds({
      ddb,
      releaseOverdueReservationsForEventDate: async () => {
        releaseCalls += 1;
        return { released: 0 };
      },
    });
    const item = await svc.createHold(
      { eventDate: "2026-05-09", tableId: "T1", customerName: "Alice", phone: "+12025550100" },
      "staff@example.com"
    );
    assert.equal(releaseCalls, 1, "overdue sweep ran exactly once");
    assert.equal(item.PK, "EVENTDATE#2026-05-09");
    assert.equal(item.SK, "TABLE#T1");
    assert.equal(item.lockType, "HOLD");
    assert.equal(item.holdId, "fake-hold-uuid");
    assert.equal(item.expiresAt, FIXED_NOW + 300);
    assert.equal(item.createdAt, FIXED_NOW);
    assert.equal(item.createdBy, "staff@example.com");
    assert.equal(item.customerName, "Alice");
    assert.equal(item.phone, "+12025550100");
    assert.equal(item.phoneCountry, "US");

    // Last DDB call should be the Put with the conditional expression.
    const put = ddb.calls[ddb.calls.length - 1];
    assert.equal(put.name, "PutCommand");
    assert.equal(put.input.TableName, "ff-table-holds");
    assert.match(
      put.input.ConditionExpression,
      /attribute_not_exists\(PK\) AND attribute_not_exists\(SK\) OR \(lockType = :hold AND expiresAt < :now\)/
    );
    assert.equal(put.input.ExpressionAttributeValues[":hold"], "HOLD");
    assert.equal(put.input.ExpressionAttributeValues[":now"], FIXED_NOW);
  });

  it("translates ConditionalCheckFailedException to a 409", async () => {
    const ccfe = new Error("table is taken");
    ccfe.name = "ConditionalCheckFailedException";
    const ddb = makeFakeDdb({ throwOnPut: ccfe });
    const { svc } = buildHolds({ ddb });
    await assert.rejects(
      () => svc.createHold({ eventDate: "2026-05-09", tableId: "T1" }, "u"),
      (err) => err?.statusCode === 409
    );
  });

  it("propagates non-CCFE errors from the Put", async () => {
    const otherErr = new Error("ProvisionedThroughputExceededException");
    otherErr.name = "ProvisionedThroughputExceededException";
    const ddb = makeFakeDdb({ throwOnPut: otherErr });
    const { svc } = buildHolds({ ddb });
    await assert.rejects(
      () => svc.createHold({ eventDate: "2026-05-09", tableId: "T1" }, "u"),
      (err) => err?.name === "ProvisionedThroughputExceededException"
    );
  });

  it("falls through to MX phone country when phone is +52", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildHolds({ ddb });
    const item = await svc.createHold(
      { eventDate: "2026-05-09", tableId: "T1", phone: "+528991054670", phoneCountry: "MX" },
      "u"
    );
    assert.equal(item.phoneCountry, "MX");
  });

  it("leaves phoneCountry null when no phone is provided", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildHolds({ ddb });
    const item = await svc.createHold(
      { eventDate: "2026-05-09", tableId: "T1" },
      "u"
    );
    assert.equal(item.phone, null);
    assert.equal(item.phoneCountry, null);
  });
});
