// Tests for services-reservations.mjs (PR #8 / final slice of the
// audit-refactor split). Exercises the full reservation lifecycle
// surface: read, create (incl. idempotent replay), cancel
// (3 resolution paths), and the cron sweep that auto-cancels overdue
// reservations.
//
// Strategy:
// - Fake DocumentClient that records every send() call by command name
// - Per-test response queues for GetCommand and QueryCommand
// - `defaultShared` / `defaultPaymentRecording` provide sensible
//   no-op stubs for the 17+ shared methods + the two payment-recording
//   methods used during cancel
// - Each describe block overrides only what it needs to exercise
//   that specific path

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createReservationsService } from "./services-reservations.mjs";

const FIXED_NOW = 1_700_000_000;
const NOW_LOCAL_ISO = "2026-05-09T12:00:00";
const TODAY_LOCAL_DATE = "2026-05-09";

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeDdb({
  getResponses = [],
  queryResponses = [],
  respond,
  throwOnCommand,
} = {}) {
  let getIdx = 0;
  let qIdx = 0;
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      const input = cmd?.input;
      calls.push({ name, input });
      if (throwOnCommand?.[name]) throw throwOnCommand[name];
      if (respond?.[name]) return respond[name](input, calls.length, name);
      if (name === "GetCommand") {
        return getResponses[getIdx++] ?? { Item: null };
      }
      if (name === "QueryCommand") {
        return queryResponses[qIdx++] ?? { Items: [] };
      }
      if (name === "UpdateCommand") {
        const baseline = input?.ExpressionAttributeValues ?? {};
        return { Attributes: { ...baseline, _updateEcho: true } };
      }
      return {};
    },
  };
}

function defaultShared(overrides = {}) {
  const historyCalls = [];
  const checkInCalls = [];
  const smsCalls = [];
  const base = {
    roundMoney: (n) => Math.round(Number(n ?? 0) * 100) / 100,
    toRescheduleCreditSk: (phone, id) => `CREDIT#PHONE#${phone}#${id}`,
    historySourceFromActor: (user) => {
      const v = String(user ?? "");
      if (v.startsWith("system:")) return "system";
      if (v.startsWith("customer:")) return "customer";
      return "staff";
    },
    toTwelveHourLabel: (h, m) =>
      `${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`,
    normalizeDeadlineLocalIso: (s) => {
      if (!s) return null;
      const str = String(s);
      // accept "YYYY-MM-DDTHH:mm" or "YYYY-MM-DDTHH:mm:ss"
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(str)) {
        return str.length === 16 ? `${str}:00` : str;
      }
      return null;
    },
    nowInTimeZoneLocalIso: () => NOW_LOCAL_ISO,
    addMinutesToLocalIso: (iso, mins) => {
      // Mirror the real impl just enough for tests: parse YYYY-MM-DDTHH:mm:ss,
      // add minutes via Date.UTC math, format back. Exact behavior of the
      // real fn (in services-reservations-shared.mjs:355).
      const m = String(iso ?? "").match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/
      );
      if (!m) return null;
      const [, y, mo, d, h, mi, se] = m;
      const dt = new Date(
        Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se))
      );
      dt.setUTCMinutes(dt.getUTCMinutes() + Number(mins || 0));
      const pad = (n) => String(n).padStart(2, "0");
      return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
    },
    isOverdueReservation: (r) => Boolean(r?._overdue),
    isFrequentAutoReservation: () => false,
    getRuntimeSettings: async () => ({}),
    resolveDefaultPaymentDeadlineTz: () => "America/Chicago",
    resolveDefaultPaymentDeadlineHour: () => 18,
    resolveDefaultPaymentDeadlineMinute: () => 0,
    resolveRescheduleCutoffHour: () => 17,
    resolveRescheduleCutoffMinute: () => 0,
    appendReservationHistory: async (entry) => {
      historyCalls.push(entry);
    },
    tryEnsureCheckInPass: async (reservation, actor) => {
      checkInCalls.push({ reservation, actor });
      return null;
    },
    trySendCheckInPassSms: async (reservation, pass, actor) => {
      smsCalls.push({ reservation, pass, actor });
    },
    queryReservationsForEventDate: async () => [],
    getReservationById: async () => null,
  };
  return {
    historyCalls,
    checkInCalls,
    smsCalls,
    shared: { ...base, ...overrides },
  };
}

function defaultPaymentRecording(overrides = {}) {
  const revokeCalls = [];
  const markInactiveCalls = [];
  return {
    revokeCalls,
    markInactiveCalls,
    paymentRecording: {
      revokeReservationCashAppLinkSession: async (args) => {
        revokeCalls.push(args);
        return null;
      },
      markReservationPaymentLinkInactive: async (args) => {
        markInactiveCalls.push(args);
        return null;
      },
      ...overrides,
    },
  };
}

function buildReservations(overrides = {}) {
  const ddb = overrides.ddb ?? makeFakeDdb();
  const sharedHarness = defaultShared(overrides.shared ?? {});
  const prHarness = defaultPaymentRecording(overrides.paymentRecording ?? {});
  const deactivateCalls = [];
  const refundCalls = [];
  const expiredSmsCalls = [];

  const deps = {
    ddb,
    tableNames: {
      EVENTS_TABLE: "ff-events",
      HOLDS_TABLE: "ff-table-holds",
      RES_TABLE: "ff-reservations",
      CLIENTS_TABLE: "ff-clients",
    },
    requiredEnv: (n, v) => v,
    httpError,
    nowEpoch: () => FIXED_NOW,
    addDaysToIsoDate: (date, n) => {
      // Dirt-simple: parse YYYY-MM-DD, add days, format back.
      // Good enough for spec deterministic-ness.
      const [y, m, d] = String(date).split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + Number(n));
      return dt.toISOString().slice(0, 10);
    },
    randomUUID: (() => {
      let i = 0;
      return () => `uuid-${++i}`;
    })(),
    normalizePhone: (phone, country) => (phone ? `${country}:${phone}` : ""),
    normalizePhoneE164: (phone) => (phone ? String(phone) : ""),
    normalizePhoneCountry: (c) => (c === "MX" ? "MX" : "US"),
    detectPhoneCountryFromE164: (p) => (String(p).startsWith("+52") ? "MX" : "US"),
    getEventByDate: overrides.getEventByDate ?? (async () => ({
      eventId: "ev1",
      eventDate: TODAY_LOCAL_DATE,
      minDeposit: 0,
      tablePrices: { T1: 100, T2: 200 },
      frequentReleasedTables: [],
    })),
    // Use Object.hasOwn so an explicit `undefined` override (used by the
     // "listEvents dependency is not configured" test) survives instead of
     // being clobbered by the default.
    listEvents: Object.hasOwn(overrides, "listEvents")
      ? overrides.listEvents
      : async () => [],
    getTablePriceForEvent: overrides.getTablePriceForEvent ?? ((event, tableId) =>
      event?.tablePrices?.[tableId] ?? null),
    deactivateSquarePaymentLink: overrides.deactivateSquarePaymentLink
      ?? (async (args) => {
        deactivateCalls.push(args);
        return { alreadyGone: false };
      }),
    refundSquarePayment: overrides.refundSquarePayment, // optional by default
    sendPaymentLinkExpiredSms: overrides.sendPaymentLinkExpiredSms
      ?? (async (args) => {
        expiredSmsCalls.push(args);
        return { to: args.phone, messageId: "msg-1", provider: "sns" };
      }),
  };

  const svc = createReservationsService(deps, sharedHarness.shared, prHarness.paymentRecording);

  return {
    ddb,
    svc,
    historyCalls: sharedHarness.historyCalls,
    checkInCalls: sharedHarness.checkInCalls,
    smsCalls: sharedHarness.smsCalls,
    revokeCalls: prHarness.revokeCalls,
    markInactiveCalls: prHarness.markInactiveCalls,
    deactivateCalls,
    refundCalls: refundCalls.length === 0 ? deps.refundSquarePayment : refundCalls,
    expiredSmsCalls,
  };
}

// Helpers to fabricate reservations + credits used across multiple tests.
function reservationItem(overrides = {}) {
  return {
    PK: `EVENTDATE#${TODAY_LOCAL_DATE}`,
    SK: "RES#r1",
    reservationId: "r1",
    eventDate: TODAY_LOCAL_DATE,
    tableId: "T1",
    customerName: "Alice",
    phone: "+12025550100",
    phoneCountry: "US",
    status: "CONFIRMED",
    paymentStatus: "PARTIAL",
    amountDue: 100,
    depositAmount: 30,
    payments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listReservations / listReservationHistory
// ---------------------------------------------------------------------------

describe("listReservations", () => {
  it("delegates to shared.queryReservationsForEventDate", async () => {
    const calls = [];
    const { svc } = buildReservations({
      shared: {
        queryReservationsForEventDate: async (eventDate) => {
          calls.push(eventDate);
          return [{ reservationId: "r1" }];
        },
      },
    });
    const out = await svc.listReservations(TODAY_LOCAL_DATE);
    assert.deepEqual(out, [{ reservationId: "r1" }]);
    assert.deepEqual(calls, [TODAY_LOCAL_DATE]);
  });
});

describe("listReservationHistory", () => {
  it("400 on bad eventDate", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () => svc.listReservationHistory("garbage", "r1"),
      (err) => err?.statusCode === 400
    );
  });

  it("400 on missing reservationId", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () => svc.listReservationHistory(TODAY_LOCAL_DATE, ""),
      (err) => err?.statusCode === 400
    );
  });

  it("issues QueryCommand with HIST# prefix, descending, Limit 200", async () => {
    const ddb = makeFakeDdb({ queryResponses: [{ Items: [{ a: 1 }] }] });
    const { svc } = buildReservations({ ddb });
    const out = await svc.listReservationHistory(TODAY_LOCAL_DATE, "r1");
    const q = ddb.calls[0];
    assert.equal(q.name, "QueryCommand");
    assert.equal(q.input.TableName, "ff-reservations");
    assert.equal(q.input.ExpressionAttributeValues[":pk"], `EVENTDATE#${TODAY_LOCAL_DATE}`);
    assert.equal(q.input.ExpressionAttributeValues[":sk"], "HIST#r1#");
    assert.equal(q.input.ScanIndexForward, false);
    assert.equal(q.input.Limit, 200);
    assert.deepEqual(out, [{ a: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// releaseOverdueReservationsForEventDate
// ---------------------------------------------------------------------------

describe("releaseOverdueReservationsForEventDate", () => {
  it("400 on bad eventDate", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () => svc.releaseOverdueReservationsForEventDate("garbage"),
      (err) => err?.statusCode === 400
    );
  });

  it("ignores non-overdue reservations", async () => {
    const reservations = [
      reservationItem({ reservationId: "r1", _overdue: false }),
    ];
    const { svc, ddb } = buildReservations({
      shared: {
        queryReservationsForEventDate: async () => reservations,
        getReservationById: async () => reservations[0],
      },
    });
    const out = await svc.releaseOverdueReservationsForEventDate(TODAY_LOCAL_DATE);
    assert.equal(out.released, 0);
    // No update on the reservation row should have fired.
    assert.equal(
      ddb.calls.filter((c) => c.name === "UpdateCommand").length,
      0
    );
  });

  it("cancels each overdue reservation and counts releases", async () => {
    const reservations = [
      reservationItem({ reservationId: "r1", tableId: "T1", _overdue: true }),
      reservationItem({ reservationId: "r2", tableId: "T2", _overdue: true }),
      reservationItem({ reservationId: "r3", tableId: "T3", _overdue: false }),
    ];
    const byId = Object.fromEntries(reservations.map((r) => [r.reservationId, r]));
    const { svc, historyCalls } = buildReservations({
      shared: {
        queryReservationsForEventDate: async () => reservations,
        getReservationById: async (_evt, id) => byId[id] ?? null,
      },
    });
    const out = await svc.releaseOverdueReservationsForEventDate(TODAY_LOCAL_DATE);
    assert.equal(out.released, 2);
    // Each cancel writes a RESERVATION_CANCELLED history.
    const cancelHistory = historyCalls.filter(
      (h) => h.eventType === "RESERVATION_CANCELLED"
    );
    assert.equal(cancelHistory.length, 2);
  });

  it("swallows ConditionalCheckFailedException from cancellation (continues)", async () => {
    const reservations = [
      reservationItem({ reservationId: "r1", _overdue: true }),
      reservationItem({ reservationId: "r2", _overdue: true }),
    ];
    const byId = Object.fromEntries(reservations.map((r) => [r.reservationId, r]));
    const ccfe = new Error("conflict");
    ccfe.name = "ConditionalCheckFailedException";
    let updateCount = 0;
    const ddb = makeFakeDdb({
      respond: {
        UpdateCommand: () => {
          updateCount += 1;
          if (updateCount === 1) throw ccfe;
          return { Attributes: { _ok: true } };
        },
      },
    });
    const { svc } = buildReservations({
      ddb,
      shared: {
        queryReservationsForEventDate: async () => reservations,
        getReservationById: async (_evt, id) => byId[id] ?? null,
      },
    });
    const out = await svc.releaseOverdueReservationsForEventDate(TODAY_LOCAL_DATE);
    assert.equal(out.released, 1);
  });
});

// ---------------------------------------------------------------------------
// releaseOverdueReservationsForAllActiveEvents
// ---------------------------------------------------------------------------

describe("releaseOverdueReservationsForAllActiveEvents", () => {
  it("500 if listEvents dependency is not configured", async () => {
    const { svc } = buildReservations({ listEvents: undefined });
    await assert.rejects(
      () => svc.releaseOverdueReservationsForAllActiveEvents(),
      (err) => err?.statusCode === 500
    );
  });

  it("filters to ACTIVE + valid YYYY-MM-DD eventDate, aggregates released", async () => {
    const events = [
      { eventDate: "2026-05-09", status: "ACTIVE" },
      { eventDate: "2026-05-10", status: "INACTIVE" },
      { eventDate: "garbage", status: "ACTIVE" },
      { eventDate: "2026-05-11", status: "active" }, // case-insensitive
    ];
    const { svc } = buildReservations({
      listEvents: async () => events,
      shared: {
        queryReservationsForEventDate: async () => [],
      },
    });
    const out = await svc.releaseOverdueReservationsForAllActiveEvents();
    // 2 valid events scanned, 0 released (no overdue rows seeded)
    assert.equal(out.eventsScanned, 2);
    assert.equal(out.released, 0);
    assert.deepEqual(out.failures, []);
  });

  it("captures failures per-event without aborting the sweep", async () => {
    const events = [
      { eventDate: "2026-05-09", status: "ACTIVE" },
      { eventDate: "2026-05-10", status: "ACTIVE" },
    ];
    let calls = 0;
    const { svc } = buildReservations({
      listEvents: async () => events,
      shared: {
        queryReservationsForEventDate: async () => {
          calls += 1;
          if (calls === 1) throw new Error("DDB blip");
          return [];
        },
      },
    });
    const out = await svc.releaseOverdueReservationsForAllActiveEvents();
    assert.equal(out.eventsScanned, 2);
    assert.equal(out.released, 0);
    assert.equal(out.failures.length, 1);
    assert.equal(out.failures[0].eventDate, "2026-05-09");
    assert.match(out.failures[0].message, /blip/);
  });
});

// ---------------------------------------------------------------------------
// cancelReservation — validation + preconditions
// ---------------------------------------------------------------------------

describe("cancelReservation validation", () => {
  it("400 on bad resolutionType", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () =>
        svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "reason", {
          resolutionType: "WHATEVER",
        }),
      (err) => err?.statusCode === 400 && /resolutionType/.test(err.message)
    );
  });

  it("400 on missing cancelReason", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () => svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", ""),
      (err) => err?.statusCode === 400 && /cancelReason/.test(err.message)
    );
  });

  it("501 on REFUND when refundSquarePayment is not configured", async () => {
    const { svc } = buildReservations({ refundSquarePayment: undefined });
    await assert.rejects(
      () =>
        svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "reason", {
          resolutionType: "REFUND",
        }),
      (err) => err?.statusCode === 501
    );
  });

  it("409 on RESCHEDULE_CREDIT past cutoff", async () => {
    const { svc } = buildReservations({
      shared: {
        // Force cutoff to be in the past so any nowIso >= cutoffIso for today
        nowInTimeZoneLocalIso: () => `${TODAY_LOCAL_DATE}T18:00:00`,
        resolveRescheduleCutoffHour: () => 17, // cutoff was 5pm
      },
    });
    await assert.rejects(
      () =>
        svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "reason", {
          resolutionType: "RESCHEDULE_CREDIT",
        }),
      (err) => err?.statusCode === 409 && /cutoff/i.test(err.message)
    );
  });

  it("404 when reservation doesn't exist", async () => {
    const { svc } = buildReservations({
      shared: { getReservationById: async () => null },
    });
    await assert.rejects(
      () => svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "reason"),
      (err) => err?.statusCode === 404
    );
  });

  it("409 when reservation is not CONFIRMED", async () => {
    const { svc } = buildReservations({
      shared: {
        getReservationById: async () => reservationItem({ status: "CANCELLED" }),
      },
    });
    await assert.rejects(
      () => svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "reason"),
      (err) => err?.statusCode === 409 && /CONFIRMED/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// cancelReservation — CANCEL_NO_REFUND happy path
// ---------------------------------------------------------------------------

describe("cancelReservation CANCEL_NO_REFUND", () => {
  it("issues UpdateCommand with status:CANCELLED + DeleteCommand on hold + history", async () => {
    const ddb = makeFakeDdb();
    const { svc, historyCalls } = buildReservations({
      ddb,
      shared: {
        getReservationById: async () => reservationItem(),
      },
    });
    await svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "staff@x", "Customer cancelled");

    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.ok(update, "UpdateCommand sent");
    assert.equal(update.input.TableName, "ff-reservations");
    assert.equal(update.input.ExpressionAttributeValues[":cancelled"], "CANCELLED");
    assert.equal(update.input.ConditionExpression, "#status = :confirmed");
    assert.equal(update.input.ExpressionAttributeValues[":by"], "staff@x");
    assert.equal(update.input.ExpressionAttributeValues[":reason"], "Customer cancelled");

    // Hold delete with conditional on RESERVED + matching reservationId
    const del = ddb.calls.find((c) => c.name === "DeleteCommand");
    assert.ok(del, "DeleteCommand on hold sent");
    assert.equal(del.input.TableName, "ff-table-holds");
    assert.equal(del.input.Key.SK, "TABLE#T1");
    assert.equal(del.input.ConditionExpression, "lockType = :reserved AND reservationId = :rid");
    assert.equal(del.input.ExpressionAttributeValues[":rid"], "r1");

    // History RESERVATION_CANCELLED
    const cancelEvent = historyCalls.find((h) => h.eventType === "RESERVATION_CANCELLED");
    assert.ok(cancelEvent, "RESERVATION_CANCELLED history written");
    assert.equal(cancelEvent.details.resolutionType, "CANCEL_NO_REFUND");
    assert.equal(cancelEvent.details.reason, "Customer cancelled");
  });

  it("revokes ACTIVE Cash App link session", async () => {
    const ddb = makeFakeDdb({
      respond: {
        UpdateCommand: (input) => ({
          Attributes: {
            ...input.ExpressionAttributeValues,
            cashAppLinkStatus: "ACTIVE",
            tableId: "T1",
            customerName: "Alice",
          },
        }),
      },
    });
    const { svc, revokeCalls } = buildReservations({
      ddb,
      shared: {
        getReservationById: async () =>
          reservationItem({ cashAppLinkStatus: "ACTIVE" }),
      },
    });
    await svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "staff@x", "test");
    assert.equal(revokeCalls.length, 1);
    assert.equal(revokeCalls[0].reservationId, "r1");
  });

  it("deactivates the Square payment link when paymentLinkId is present", async () => {
    const ddb = makeFakeDdb({
      respond: {
        UpdateCommand: (input) => ({
          Attributes: {
            ...input.ExpressionAttributeValues,
            paymentLinkId: "PL_1",
            tableId: "T1",
            customerName: "Alice",
          },
        }),
      },
    });
    const { svc, deactivateCalls, markInactiveCalls } = buildReservations({
      ddb,
      shared: {
        getReservationById: async () => reservationItem({ paymentLinkId: "PL_1" }),
      },
    });
    await svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "staff@x", "test");
    assert.equal(deactivateCalls.length, 1);
    assert.equal(deactivateCalls[0].paymentLinkId, "PL_1");
    assert.equal(markInactiveCalls.length, 1);
    assert.equal(markInactiveCalls[0].status, "DEACTIVATED");
  });
});

// ---------------------------------------------------------------------------
// cancelReservation — RESCHEDULE_CREDIT
// ---------------------------------------------------------------------------

describe("cancelReservation RESCHEDULE_CREDIT", () => {
  it("400 when reservation has no phone (cannot issue credit)", async () => {
    const { svc } = buildReservations({
      shared: {
        getReservationById: async () => reservationItem({ phone: "" }),
      },
    });
    await assert.rejects(
      () =>
        svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "test", {
          resolutionType: "RESCHEDULE_CREDIT",
        }),
      (err) => err?.statusCode === 400 && /valid client phone/.test(err.message)
    );
  });

  it("400 when depositAmount is 0 (nothing to credit)", async () => {
    const { svc } = buildReservations({
      shared: {
        getReservationById: async () => reservationItem({ depositAmount: 0 }),
      },
    });
    await assert.rejects(
      () =>
        svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "test", {
          resolutionType: "RESCHEDULE_CREDIT",
        }),
      (err) => err?.statusCode === 400 && /paid amount/.test(err.message)
    );
  });

  it("happy path: TransactWrite has reservation update + credit Put", async () => {
    const ddb = makeFakeDdb();
    const { svc, historyCalls } = buildReservations({
      ddb,
      shared: {
        getReservationById: async () => reservationItem(),
      },
    });
    await svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "staff@x", "Customer rebooked", {
      resolutionType: "RESCHEDULE_CREDIT",
    });

    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    assert.ok(txn, "TransactWriteCommand sent");
    assert.equal(txn.input.TransactItems.length, 2);

    // First: reservation update with creditId/creditAmount
    const resUpdate = txn.input.TransactItems[0].Update;
    assert.equal(resUpdate.TableName, "ff-reservations");
    assert.equal(resUpdate.ExpressionAttributeValues[":cancelled"], "CANCELLED");
    assert.equal(resUpdate.ExpressionAttributeValues[":creditAmount"], 30);
    assert.equal(resUpdate.ExpressionAttributeValues[":creditStatus"], "ISSUED");

    // Second: credit Put with attribute_not_exists guard
    const credPut = txn.input.TransactItems[1].Put;
    assert.equal(credPut.TableName, "ff-clients");
    assert.equal(credPut.Item.entityType, "RESCHEDULE_CREDIT");
    assert.equal(credPut.Item.amountTotal, 30);
    assert.equal(credPut.Item.amountRemaining, 30);
    assert.equal(credPut.ConditionExpression, "attribute_not_exists(PK) AND attribute_not_exists(SK)");

    // Two histories: RESCHEDULE_CREDIT_ISSUED + RESERVATION_CANCELLED
    const types = historyCalls.map((h) => h.eventType);
    assert.ok(types.includes("RESCHEDULE_CREDIT_ISSUED"));
    assert.ok(types.includes("RESERVATION_CANCELLED"));
  });

  it("TransactionCanceledException with ConditionalCheckFailed → 409", async () => {
    const txnErr = new Error("Transaction cancelled, ConditionalCheckFailed");
    txnErr.name = "TransactionCanceledException";
    const ddb = makeFakeDdb({ throwOnCommand: { TransactWriteCommand: txnErr } });
    const { svc } = buildReservations({
      ddb,
      shared: {
        getReservationById: async () => reservationItem(),
      },
    });
    await assert.rejects(
      () =>
        svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "test", {
          resolutionType: "RESCHEDULE_CREDIT",
        }),
      (err) => err?.statusCode === 409 && /no longer CONFIRMED/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// cancelReservation — REFUND
// ---------------------------------------------------------------------------

describe("cancelReservation REFUND", () => {
  function refundablePayment(overrides = {}) {
    return {
      paymentId: "p1",
      amount: 50,
      method: "square",
      provider: { providerPaymentId: "sq_pay_1" },
      ...overrides,
    };
  }

  it("400 when no refundable Square/Cash App payments exist", async () => {
    const { svc } = buildReservations({
      shared: {
        getReservationById: async () =>
          reservationItem({ payments: [{ paymentId: "p1", amount: 30, method: "cash" }] }),
      },
      refundSquarePayment: async () => ({ refund: { id: "rf1", status: "PENDING" } }),
    });
    await assert.rejects(
      () =>
        svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "test", {
          resolutionType: "REFUND",
        }),
      (err) => err?.statusCode === 400 && /No refundable/i.test(err.message)
    );
  });

  it("happy path: each payment refunded, UpdateCommand sets paymentStatus=REFUNDED", async () => {
    const refundCallLog = [];
    const ddb = makeFakeDdb();
    const { svc, historyCalls } = buildReservations({
      ddb,
      shared: {
        getReservationById: async () =>
          reservationItem({
            payments: [
              refundablePayment({ paymentId: "p1", amount: 30 }),
              refundablePayment({
                paymentId: "p2",
                amount: 20,
                method: "cashapp",
                provider: { providerPaymentId: "sq_pay_2" },
              }),
            ],
          }),
      },
      refundSquarePayment: async (args) => {
        refundCallLog.push(args);
        return { refund: { id: `rf-${refundCallLog.length}`, status: "PENDING" } };
      },
    });
    await svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "staff@x", "Refund please", {
      resolutionType: "REFUND",
    });

    assert.equal(refundCallLog.length, 2);
    assert.match(refundCallLog[0].idempotencyKey, /^refund-r1-/);

    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.ok(update, "UpdateCommand for cancellation sent");
    assert.equal(update.input.ExpressionAttributeValues[":refunded"], "REFUNDED");
    assert.equal(update.input.ExpressionAttributeValues[":refundedAmount"], 50);
    assert.equal(update.input.ConditionExpression, "#status = :confirmed");

    const types = historyCalls.map((h) => h.eventType);
    assert.ok(types.includes("REFUND_ISSUED"));
    assert.ok(types.includes("RESERVATION_CANCELLED"));
  });

  it("partial-refund failure → REFUND_FAILED history + 502 (no DDB cancel)", async () => {
    const ddb = makeFakeDdb();
    let i = 0;
    const { svc, historyCalls } = buildReservations({
      ddb,
      shared: {
        getReservationById: async () =>
          reservationItem({
            payments: [
              refundablePayment({ paymentId: "p1" }),
              refundablePayment({
                paymentId: "p2",
                provider: { providerPaymentId: "sq_pay_2" },
              }),
            ],
          }),
      },
      refundSquarePayment: async () => {
        i += 1;
        if (i === 1) return { refund: { id: "rf1", status: "PENDING" } };
        throw new Error("Square down");
      },
    });
    await assert.rejects(
      () =>
        svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "test", {
          resolutionType: "REFUND",
        }),
      (err) => err?.statusCode === 502 && /partially failed/i.test(err.message)
    );
    // No reservation cancel update since we threw before
    assert.equal(ddb.calls.filter((c) => c.name === "UpdateCommand").length, 0);
    // REFUND_FAILED history was written
    const failed = historyCalls.find((h) => h.eventType === "REFUND_FAILED");
    assert.ok(failed);
    assert.equal(failed.details.refunds.length, 2);
  });

  it("CCFE on cancellation update after successful refunds → REFUND_ORPHANED + 409", async () => {
    const ccfe = new Error("status changed");
    ccfe.name = "ConditionalCheckFailedException";
    const ddb = makeFakeDdb({ throwOnCommand: { UpdateCommand: ccfe } });
    // Capture stderr to verify the structured log marker
    const origError = console.error;
    const errLogs = [];
    console.error = (...args) => errLogs.push(args);
    try {
      const { svc, historyCalls } = buildReservations({
        ddb,
        shared: {
          getReservationById: async () =>
            reservationItem({ payments: [refundablePayment()] }),
        },
        refundSquarePayment: async () => ({ refund: { id: "rf1", status: "PENDING" } }),
      });
      await assert.rejects(
        () =>
          svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "test", {
            resolutionType: "REFUND",
          }),
        (err) => err?.statusCode === 409 && /reconciliation/i.test(err.message)
      );
      const orphaned = historyCalls.find((h) => h.eventType === "REFUND_ORPHANED");
      assert.ok(orphaned, "REFUND_ORPHANED history written");
      // The log marker `refund_orphaned` is what the CW metric filter hooks on
      const markerLog = errLogs.find((entry) => entry[0] === "refund_orphaned");
      assert.ok(markerLog, "refund_orphaned console.error marker emitted");
      assert.equal(markerLog[1].reservationId, "r1");
    } finally {
      console.error = origError;
    }
  });

  it("skips already-refunded payments", async () => {
    const refundLog = [];
    const ddb = makeFakeDdb();
    const { svc } = buildReservations({
      ddb,
      shared: {
        getReservationById: async () =>
          reservationItem({
            payments: [
              {
                paymentId: "p1",
                amount: 50,
                method: "square",
                provider: { providerPaymentId: "sq_pay_1" },
                refund: { refundId: "rf-existing" }, // already refunded
              },
              refundablePayment({
                paymentId: "p2",
                provider: { providerPaymentId: "sq_pay_2" },
              }),
            ],
          }),
      },
      refundSquarePayment: async (args) => {
        refundLog.push(args);
        return { refund: { id: `rf-${refundLog.length}`, status: "PENDING" } };
      },
    });
    await svc.cancelReservation(TODAY_LOCAL_DATE, "r1", "T1", "u", "test", {
      resolutionType: "REFUND",
    });
    // Only p2 was refunded, not p1
    assert.equal(refundLog.length, 1);
    assert.equal(refundLog[0].paymentId, "sq_pay_2");
  });
});

// ---------------------------------------------------------------------------
// createReservation — validation
// ---------------------------------------------------------------------------

describe("createReservation validation", () => {
  function basePayload(overrides = {}) {
    return {
      eventDate: TODAY_LOCAL_DATE,
      tableId: "T1",
      holdId: "h1",
      customerName: "Alice",
      phone: "+12025550100",
      depositAmount: 0,
      paymentDeadlineAt: "2026-05-10T18:00:00",
      ...overrides,
    };
  }

  it("400 on bad eventDate", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () => svc.createReservation(basePayload({ eventDate: "x" }), "u", false),
      (err) => err?.statusCode === 400
    );
  });

  it("400 on missing tableId", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () => svc.createReservation(basePayload({ tableId: "" }), "u", false),
      (err) => err?.statusCode === 400
    );
  });

  it("400 on missing holdId", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () => svc.createReservation(basePayload({ holdId: "" }), "u", false),
      (err) => err?.statusCode === 400
    );
  });

  it("400 on missing customerName", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () => svc.createReservation(basePayload({ customerName: "" }), "u", false),
      (err) => err?.statusCode === 400
    );
  });

  it("400 on missing phone", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () => svc.createReservation(basePayload({ phone: "" }), "u", false),
      (err) => err?.statusCode === 400 && /valid US or MX/.test(err.message)
    );
  });

  it("400 on negative depositAmount", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () => svc.createReservation(basePayload({ depositAmount: -1 }), "u", false),
      (err) => err?.statusCode === 400
    );
  });

  it("404 when event not found", async () => {
    const { svc } = buildReservations({ getEventByDate: async () => null });
    await assert.rejects(
      () => svc.createReservation(basePayload(), "u", false),
      (err) => err?.statusCode === 404
    );
  });

  it("400 when depositAmount is below minDeposit (non-admin)", async () => {
    const { svc } = buildReservations({
      getEventByDate: async () => ({ minDeposit: 50, tablePrices: { T1: 100 } }),
    });
    await assert.rejects(
      () => svc.createReservation(basePayload({ depositAmount: 20 }), "u", false),
      (err) => err?.statusCode === 400 && /minimum/.test(err.message)
    );
  });

  it("admin can bypass minDeposit", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildReservations({
      ddb,
      getEventByDate: async () => ({ minDeposit: 50, tablePrices: { T1: 100 } }),
    });
    await svc.createReservation(basePayload({ depositAmount: 0 }), "admin@x", true);
    // Should have made it to the TransactWrite step
    assert.ok(ddb.calls.find((c) => c.name === "TransactWriteCommand"));
  });

  it("400 on invalid tableId for event", async () => {
    const { svc } = buildReservations({
      getEventByDate: async () => ({ tablePrices: { T2: 200 } }),
    });
    await assert.rejects(
      () => svc.createReservation(basePayload({ tableId: "T1" }), "u", false),
      (err) => err?.statusCode === 400 && /Invalid tableId/.test(err.message)
    );
  });

  it("400 on bad paymentStatus enum", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () =>
        svc.createReservation(
          basePayload({ paymentStatus: "WHATEVER" }),
          "u",
          false
        ),
      (err) => err?.statusCode === 400 && /paymentStatus/.test(err.message)
    );
  });

  it("400 when PAID but no paymentMethod given", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () =>
        svc.createReservation(
          basePayload({ depositAmount: 100, paymentStatus: "PAID" }),
          "u",
          false
        ),
      (err) => err?.statusCode === 400 && /paymentMethod is required/.test(err.message)
    );
  });

  it("400 when paymentDeadlineAt is in the past for PENDING/PARTIAL", async () => {
    const { svc } = buildReservations({
      shared: {
        nowInTimeZoneLocalIso: () => "2026-05-09T20:00:00",
      },
    });
    await assert.rejects(
      () =>
        svc.createReservation(
          basePayload({ paymentDeadlineAt: "2026-05-09T10:00:00" }),
          "u",
          false
        ),
      (err) => err?.statusCode === 400 && /future/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// createReservation — TransactWrite happy path
// ---------------------------------------------------------------------------

describe("createReservation TransactWrite happy path", () => {
  it("hold update HOLD→RESERVED with 5s grace cutoff + reservation Put", async () => {
    const ddb = makeFakeDdb();
    const { svc, historyCalls } = buildReservations({ ddb });
    const out = await svc.createReservation(
      {
        eventDate: TODAY_LOCAL_DATE,
        tableId: "T1",
        holdId: "h1",
        customerName: "Alice",
        phone: "+12025550100",
        depositAmount: 0,
        paymentDeadlineAt: "2026-05-10T18:00:00",
      },
      "staff@x",
      false
    );
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    assert.ok(txn, "TransactWriteCommand sent");
    assert.equal(txn.input.TransactItems.length, 2);

    // Hold update — flips HOLD→RESERVED, condition includes 5s grace
    const holdUpd = txn.input.TransactItems[0].Update;
    assert.equal(holdUpd.TableName, "ff-table-holds");
    assert.equal(
      holdUpd.ConditionExpression,
      "lockType = :hold AND holdId = :hid AND expiresAt >= :graceCutoff"
    );
    assert.equal(holdUpd.ExpressionAttributeValues[":reserved"], "RESERVED");
    assert.equal(holdUpd.ExpressionAttributeValues[":hid"], "h1");
    // grace: now - 5s
    assert.equal(holdUpd.ExpressionAttributeValues[":graceCutoff"], FIXED_NOW - 5);

    // Reservation Put — attribute_not_exists guard, all fields present
    const resPut = txn.input.TransactItems[1].Put;
    assert.equal(resPut.TableName, "ff-reservations");
    assert.equal(resPut.ConditionExpression, "attribute_not_exists(PK) AND attribute_not_exists(SK)");
    assert.equal(resPut.Item.tableId, "T1");
    assert.equal(resPut.Item.customerName, "Alice");
    assert.equal(resPut.Item.amountDue, 100); // from event tablePrices
    assert.equal(resPut.Item.depositAmount, 0);
    assert.equal(resPut.Item.paymentStatus, "PENDING");
    assert.equal(resPut.Item.status, "CONFIRMED");

    // Output
    assert.equal(out.reservationId, resPut.Item.reservationId);
    assert.equal(out.checkInPass, null);

    // History RESERVATION_CREATED appended
    assert.ok(historyCalls.find((h) => h.eventType === "RESERVATION_CREATED"));
  });

  it("derives PAID status when depositAmount >= amountDue + writes PAYMENT_RECORDED", async () => {
    const ddb = makeFakeDdb();
    const { svc, historyCalls } = buildReservations({ ddb });
    await svc.createReservation(
      {
        eventDate: TODAY_LOCAL_DATE,
        tableId: "T1",
        holdId: "h1",
        customerName: "Alice",
        phone: "+12025550100",
        depositAmount: 100,
        paymentMethod: "cash",
      },
      "staff@x",
      false
    );
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    const resPut = txn.input.TransactItems[1].Put;
    assert.equal(resPut.Item.paymentStatus, "PAID");
    assert.equal(resPut.Item.depositAmount, 100);
    assert.equal(resPut.Item.payments.length, 1);
    assert.equal(resPut.Item.payments[0].method, "cash");
    assert.equal(resPut.Item.payments[0].source, "manual");
    assert.equal(resPut.Item.payments[0].note, "Initial payment");
    // Both RESERVATION_CREATED and PAYMENT_RECORDED histories
    assert.ok(historyCalls.find((h) => h.eventType === "RESERVATION_CREATED"));
    assert.ok(historyCalls.find((h) => h.eventType === "PAYMENT_RECORDED"));
  });

  it("COURTESY zeroes out amountDue + depositAmount + skips deadline", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildReservations({ ddb });
    await svc.createReservation(
      {
        eventDate: TODAY_LOCAL_DATE,
        tableId: "T1",
        holdId: "h1",
        customerName: "Alice",
        phone: "+12025550100",
        depositAmount: 0,
        paymentStatus: "COURTESY",
      },
      "staff@x",
      true
    );
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    const resPut = txn.input.TransactItems[1].Put;
    assert.equal(resPut.Item.paymentStatus, "COURTESY");
    assert.equal(resPut.Item.amountDue, 0);
    assert.equal(resPut.Item.depositAmount, 0);
    assert.equal(resPut.Item.paymentMethod, null);
    assert.equal(resPut.Item.paymentDeadlineAt, null);
    assert.equal(resPut.Item.paymentDeadlineTz, null);
  });

  it("attaches customerCognitoSub to the row + uses 'customer' history source for self-service", async () => {
    const ddb = makeFakeDdb();
    const { svc, historyCalls } = buildReservations({ ddb });
    await svc.createReservation(
      {
        eventDate: TODAY_LOCAL_DATE,
        tableId: "T1",
        holdId: "h1",
        customerName: "Alice",
        phone: "+12025550100",
        depositAmount: 0,
        customerCognitoSub: "sub-xyz",
        paymentDeadlineAt: "2026-05-10T18:00:00",
      },
      "customer:sub-xyz",
      false
    );
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    const resPut = txn.input.TransactItems[1].Put;
    assert.equal(resPut.Item.customerCognitoSub, "sub-xyz");
    const created = historyCalls.find(
      (h) => h.eventType === "RESERVATION_CREATED"
    );
    assert.equal(created.source, "customer");
    assert.equal(created.actor, "customer:sub-xyz");
  });

  it("staff-created reservation omits customerCognitoSub (sparse GSI invariant)", async () => {
    const ddb = makeFakeDdb();
    const { svc, historyCalls } = buildReservations({ ddb });
    await svc.createReservation(
      {
        eventDate: TODAY_LOCAL_DATE,
        tableId: "T1",
        holdId: "h1",
        customerName: "Alice",
        phone: "+12025550100",
        depositAmount: 0,
        paymentDeadlineAt: "2026-05-10T18:00:00",
      },
      "staff@example.com",
      false
    );
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    const resPut = txn.input.TransactItems[1].Put;
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        resPut.Item,
        "customerCognitoSub"
      ),
      false,
      "staff reservation must not set customerCognitoSub"
    );
    const created = historyCalls.find(
      (h) => h.eventType === "RESERVATION_CREATED"
    );
    assert.equal(created.source, "staff");
  });

  it("auto-clamps past *default* deadline (event happened, +1d-default is past)", async () => {
    // Force "now" to be after the auto-defaulted "event_date + 1 day at
    // 18:00" deadline by setting the event to yesterday-ish + a now that
    // beats it.
    const ddb = makeFakeDdb();
    const yesterday = "2026-05-08";
    const nowAfterDefault = "2026-05-10T05:00:00";
    const { svc, historyCalls } = buildReservations({
      ddb,
      shared: {
        nowInTimeZoneLocalIso: () => nowAfterDefault,
      },
      getEventByDate: async () => ({
        eventId: "ev1",
        eventDate: yesterday,
        minDeposit: 0,
        tablePrices: { T1: 100 },
      }),
    });
    const out = await svc.createReservation(
      {
        eventDate: yesterday,
        tableId: "T1",
        holdId: "h1",
        customerName: "Alice",
        phone: "+12025550100",
        depositAmount: 0,
        // No paymentDeadlineAt → backend defaults to 2026-05-09T18:00:00
        // (yesterday + 1d at default 18:00). That's < nowAfterDefault, so
        // the new clamp kicks in: deadline becomes nowAfterDefault + 4h.
      },
      "staff@x",
      false
    );
    assert.ok(out.reservationId, "reservation created despite past default");
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    const resPut = txn.input.TransactItems[1].Put;
    // Clamped deadline: 2026-05-10T05:00:00 + 240 min = 2026-05-10T09:00:00
    assert.equal(resPut.Item.paymentDeadlineAt, "2026-05-10T09:00:00");
    assert.ok(historyCalls.find((h) => h.eventType === "RESERVATION_CREATED"));
  });

  it("explicit past deadline still throws 400 (user error, not system bug)", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildReservations({
      ddb,
      shared: { nowInTimeZoneLocalIso: () => "2026-05-10T05:00:00" },
    });
    await assert.rejects(
      () =>
        svc.createReservation(
          {
            eventDate: TODAY_LOCAL_DATE,
            tableId: "T1",
            holdId: "h1",
            customerName: "Alice",
            phone: "+12025550100",
            depositAmount: 0,
            // Caller explicitly sent a past deadline — staff form bug.
            paymentDeadlineAt: "2026-05-10T03:00:00",
          },
          "staff@x",
          false
        ),
      (err) =>
        err?.statusCode === 400 &&
        /paymentDeadlineAt must be in the future/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// createReservation — idempotent replay (audit M3)
// ---------------------------------------------------------------------------

describe("createReservation idempotent replay", () => {
  it("TransactionCanceledException + hold already RESERVED with same rid → idempotentReplay:true", async () => {
    const txnErr = new Error("conflict");
    txnErr.name = "TransactionCanceledException";
    let getCount = 0;
    const ddb = makeFakeDdb({
      respond: {
        TransactWriteCommand: () => {
          throw txnErr;
        },
        GetCommand: (input) => {
          getCount += 1;
          if (getCount === 1) {
            // Hold lookup
            return {
              Item: { lockType: "RESERVED", reservationId: "existing-rid" },
            };
          }
          // Reservation lookup
          return {
            Item: {
              reservationId: "existing-rid",
              status: "CONFIRMED",
            },
          };
        },
      },
    });
    const { svc } = buildReservations({ ddb });
    const out = await svc.createReservation(
      {
        eventDate: TODAY_LOCAL_DATE,
        tableId: "T1",
        holdId: "h1",
        customerName: "Alice",
        phone: "+12025550100",
        depositAmount: 0,
        paymentDeadlineAt: "2026-05-10T18:00:00",
      },
      "staff@x",
      false
    );
    assert.equal(out.reservationId, "existing-rid");
    assert.equal(out.idempotentReplay, true);
  });

  it("TransactionCanceledException + hold not RESERVED → 409", async () => {
    const txnErr = new Error("conflict");
    txnErr.name = "TransactionCanceledException";
    const ddb = makeFakeDdb({
      respond: {
        TransactWriteCommand: () => {
          throw txnErr;
        },
        GetCommand: () => ({ Item: null }),
      },
    });
    const { svc } = buildReservations({ ddb });
    await assert.rejects(
      () =>
        svc.createReservation(
          {
            eventDate: TODAY_LOCAL_DATE,
            tableId: "T1",
            holdId: "h1",
            customerName: "Alice",
            phone: "+12025550100",
            depositAmount: 0,
            paymentDeadlineAt: "2026-05-10T18:00:00",
          },
          "staff@x",
          false
        ),
      (err) => err?.statusCode === 409 && /no longer available/i.test(err.message)
    );
  });

  it("non-TransactionCanceledException is propagated unchanged", async () => {
    const otherErr = new Error("Throughput");
    otherErr.name = "ProvisionedThroughputExceededException";
    const ddb = makeFakeDdb({ throwOnCommand: { TransactWriteCommand: otherErr } });
    const { svc } = buildReservations({ ddb });
    await assert.rejects(
      () =>
        svc.createReservation(
          {
            eventDate: TODAY_LOCAL_DATE,
            tableId: "T1",
            holdId: "h1",
            customerName: "Alice",
            phone: "+12025550100",
            depositAmount: 0,
            paymentDeadlineAt: "2026-05-10T18:00:00",
          },
          "staff@x",
          false
        ),
      (err) => err?.name === "ProvisionedThroughputExceededException"
    );
  });
});

// ---------------------------------------------------------------------------
// rescheduleReservationForCustomer — preconditions
// ---------------------------------------------------------------------------
//
// The orchestrator composes cancelReservation + createReservation +
// paymentRecording.addReservationPayment. These tests focus on the
// preconditions that fail fast before any sub-call (validation, ownership,
// status, 24h gate). Happy path + partial failure are covered at the
// route layer (with the orchestrator stubbed) since exercising the full
// chain through real DDB fakes adds significant test complexity for
// little incremental coverage.

const FAR_FUTURE_DATE = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 60);
  return d.toISOString().slice(0, 10);
})();
const YESTERDAY_DATE = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();
const TOMORROW_DATE = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();

const VALID_RESCHEDULE = {
  originalReservationId: "r-old",
  newTableId: "T7",
  newHoldId: "hold-new-1",
  newCustomerName: "Alice",
  customerCognitoSub: "sub-abc",
  actor: "customer:sub-abc",
};

describe("rescheduleReservationForCustomer validation", () => {
  it("400 on bad originalEventDate", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () =>
        svc.rescheduleReservationForCustomer({
          ...VALID_RESCHEDULE,
          originalEventDate: "garbage",
          newEventDate: FAR_FUTURE_DATE,
        }),
      (err) => err?.statusCode === 400 && /originalEventDate/.test(err.message)
    );
  });

  it("400 on missing originalReservationId", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () =>
        svc.rescheduleReservationForCustomer({
          ...VALID_RESCHEDULE,
          originalEventDate: FAR_FUTURE_DATE,
          newEventDate: FAR_FUTURE_DATE,
          originalReservationId: "",
        }),
      (err) => err?.statusCode === 400 && /originalReservationId/.test(err.message)
    );
  });

  it("400 on bad newEventDate", async () => {
    const { svc } = buildReservations();
    await assert.rejects(
      () =>
        svc.rescheduleReservationForCustomer({
          ...VALID_RESCHEDULE,
          originalEventDate: FAR_FUTURE_DATE,
          newEventDate: "tomorrow",
        }),
      (err) => err?.statusCode === 400 && /newEventDate/.test(err.message)
    );
  });

  it("400 on missing newTableId / newHoldId / newCustomerName / sub / actor", async () => {
    const cases = [
      { newTableId: "" },
      { newHoldId: "" },
      { newCustomerName: "" },
      { customerCognitoSub: "" },
      { actor: "" },
    ];
    for (const partial of cases) {
      const { svc } = buildReservations();
      await assert.rejects(
        () =>
          svc.rescheduleReservationForCustomer({
            ...VALID_RESCHEDULE,
            ...partial,
            originalEventDate: FAR_FUTURE_DATE,
            newEventDate: FAR_FUTURE_DATE,
          }),
        (err) => err?.statusCode === 400
      );
    }
  });

  it("404 when original reservation does not exist", async () => {
    const { svc } = buildReservations({
      shared: {
        getReservationById: async () => null,
      },
    });
    await assert.rejects(
      () =>
        svc.rescheduleReservationForCustomer({
          ...VALID_RESCHEDULE,
          originalEventDate: FAR_FUTURE_DATE,
          newEventDate: FAR_FUTURE_DATE,
        }),
      (err) => err?.statusCode === 404
    );
  });

  it("403 when original reservation belongs to a different sub", async () => {
    const { svc } = buildReservations({
      shared: {
        getReservationById: async () =>
          reservationItem({
            customerCognitoSub: "sub-someone-else",
            paymentStatus: "PAID",
            depositAmount: 100,
          }),
      },
    });
    await assert.rejects(
      () =>
        svc.rescheduleReservationForCustomer({
          ...VALID_RESCHEDULE,
          originalEventDate: FAR_FUTURE_DATE,
          newEventDate: FAR_FUTURE_DATE,
        }),
      (err) => err?.statusCode === 403 && /not yours/i.test(err.message)
    );
  });

  it("409 when original status is not CONFIRMED", async () => {
    const { svc } = buildReservations({
      shared: {
        getReservationById: async () =>
          reservationItem({
            customerCognitoSub: "sub-abc",
            status: "CANCELLED",
            paymentStatus: "PAID",
            depositAmount: 100,
          }),
      },
    });
    await assert.rejects(
      () =>
        svc.rescheduleReservationForCustomer({
          ...VALID_RESCHEDULE,
          originalEventDate: FAR_FUTURE_DATE,
          newEventDate: FAR_FUTURE_DATE,
        }),
      (err) => err?.statusCode === 409 && /CONFIRMED/.test(err.message)
    );
  });

  it("409 when paymentStatus is PENDING (no credit to migrate)", async () => {
    const { svc } = buildReservations({
      shared: {
        getReservationById: async () =>
          reservationItem({
            customerCognitoSub: "sub-abc",
            paymentStatus: "PENDING",
            depositAmount: 0,
          }),
      },
    });
    await assert.rejects(
      () =>
        svc.rescheduleReservationForCustomer({
          ...VALID_RESCHEDULE,
          originalEventDate: FAR_FUTURE_DATE,
          newEventDate: FAR_FUTURE_DATE,
        }),
      (err) => err?.statusCode === 409 && /paid or partially paid/i.test(err.message)
    );
  });

  it("409 when within 24h of event end", async () => {
    // Yesterday's event = already in the past = always fails the 24h gate.
    const { svc } = buildReservations({
      shared: {
        getReservationById: async () =>
          reservationItem({
            customerCognitoSub: "sub-abc",
            eventDate: YESTERDAY_DATE,
            paymentStatus: "PAID",
            depositAmount: 100,
          }),
      },
    });
    await assert.rejects(
      () =>
        svc.rescheduleReservationForCustomer({
          ...VALID_RESCHEDULE,
          originalEventDate: YESTERDAY_DATE,
          newEventDate: FAR_FUTURE_DATE,
        }),
      (err) => err?.statusCode === 409 && /at least.*hours before/i.test(err.message)
    );
  });

  it("custom hoursBefore policy is honored", async () => {
    // Tomorrow's event with hoursBefore: 1 (about 24h+ away from now → passes).
    // The orchestrator will then proceed to call cancelReservation, which will
    // hit the buildRescheduleCreditItem flow and ultimately attempt a
    // TransactWrite. We don't seed a successful TransactWrite path, so this
    // test only verifies the gate doesn't pre-empt — we expect it to fail at
    // a *later* step (TransactWrite or assertRescheduleCreditAllowed),
    // not at the 24h check.
    let getReservationCalls = 0;
    const { svc } = buildReservations({
      shared: {
        getReservationById: async () => {
          getReservationCalls += 1;
          return reservationItem({
            customerCognitoSub: "sub-abc",
            eventDate: TOMORROW_DATE,
            paymentStatus: "PAID",
            depositAmount: 100,
          });
        },
      },
    });
    // hoursBefore: 1 → cutoff is 1h before end-of-day-tomorrow ≈ 23h+ from now.
    // Now < cutoff, so the 24h gate passes; subsequent assertRescheduleCreditAllowed
    // runs against the settings cutoff. We expect an error from a later step
    // (not the "at least N hours before" message from this gate).
    await assert.rejects(
      () =>
        svc.rescheduleReservationForCustomer({
          ...VALID_RESCHEDULE,
          originalEventDate: TOMORROW_DATE,
          newEventDate: FAR_FUTURE_DATE,
          hoursBefore: 1,
        }),
      (err) => !/at least 1 hours before/i.test(String(err?.message ?? ""))
    );
    // Ensure we got past the 24h check (which loads the original).
    assert.ok(getReservationCalls >= 1);
  });
});
