// Tests for the helpers extracted into services-reservations-shared.mjs
// (PR #5). Exercises the pure utilities directly via the factory and
// the mockable async helpers (appendReservationHistory, tryEnsureCheckInPass,
// trySendCheckInPassSms, queryReservationsForEventDate, getReservationById)
// with a fake DocumentClient.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_RELEASE_REASON,
  DEFAULT_DEADLINE_TZ,
  DEFAULT_HOLD_TTL_SECONDS,
  HOLD_EXPIRY_GRACE_SECONDS,
  createReservationsShared,
} from "./services-reservations-shared.mjs";

const FIXED_NOW = 1_700_000_000;

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function makeFakeDdb({ getResponses = [], queryResponses = [] } = {}) {
  let getIndex = 0;
  let queryIndex = 0;
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      calls.push({ name, input: cmd?.input });
      if (name === "GetCommand") {
        return getResponses[getIndex++] ?? { Item: null };
      }
      if (name === "QueryCommand") {
        return queryResponses[queryIndex++] ?? { Items: [] };
      }
      return {};
    },
  };
}

function buildShared(overrides = {}) {
  const fakeDdb = overrides.ddb ?? makeFakeDdb();
  return createReservationsShared({
    ddb: fakeDdb,
    tableNames: { RES_TABLE: "ff-reservations" },
    requiredEnv: (n, v) => v,
    httpError,
    nowEpoch: () => FIXED_NOW,
    randomUUID: () => "fake-uuid-0000",
    ensureCheckInPassForReservation: overrides.ensureCheckInPassForReservation,
    sendCheckInPassSms: overrides.sendCheckInPassSms,
    paymentLinkTtlMinutes: overrides.paymentLinkTtlMinutes,
    frequentPaymentLinkTtlMinutes: overrides.frequentPaymentLinkTtlMinutes,
    isFrequentReservationByPhoneAndTable: overrides.isFrequentReservationByPhoneAndTable,
    getAppSettings: overrides.getAppSettings,
  });
}

describe("constants", () => {
  it("exports the expected defaults", () => {
    assert.equal(AUTO_RELEASE_REASON, "Payment deadline passed - table auto released");
    assert.equal(DEFAULT_DEADLINE_TZ, "America/Chicago");
    assert.equal(DEFAULT_HOLD_TTL_SECONDS, 300);
    assert.equal(HOLD_EXPIRY_GRACE_SECONDS, 5);
  });
});

describe("pure helpers", () => {
  const s = buildShared();

  it("clampNumber clamps + rounds + falls back", () => {
    assert.equal(s.clampNumber(50, 0, 100, 5), 50);
    assert.equal(s.clampNumber(150, 0, 100, 5), 100);
    assert.equal(s.clampNumber(-10, 0, 100, 5), 0);
    assert.equal(s.clampNumber(7.4, 0, 100, 5), 7);
    assert.equal(s.clampNumber(NaN, 0, 100, 5), 5);
    assert.equal(s.clampNumber(undefined, 0, 100, 5), 5);
  });

  it("roundMoney trims float noise", () => {
    assert.equal(s.roundMoney(0.1 + 0.2), 0.3);
    assert.equal(s.roundMoney(10.005), 10.01);
    assert.equal(s.roundMoney(undefined), 0);
  });

  it("toTwelveHourLabel formats AM/PM correctly", () => {
    assert.equal(s.toTwelveHourLabel(0, 0), "12:00 AM");
    assert.equal(s.toTwelveHourLabel(13, 5), "1:05 PM");
    assert.equal(s.toTwelveHourLabel(23, 59), "11:59 PM");
    assert.equal(s.toTwelveHourLabel(12, 30), "12:30 PM");
  });

  it("toRescheduleCreditSk uses the documented PHONE shape", () => {
    assert.equal(
      s.toRescheduleCreditSk("12025550123", "credit-abc"),
      "CREDIT#PHONE#12025550123#credit-abc"
    );
  });

  it("toHistorySk pads epoch to 12 chars", () => {
    assert.equal(
      s.toHistorySk("res-1", 1700000000, "evt-1"),
      "HIST#res-1#001700000000#evt-1"
    );
  });

  it("historySourceFromActor classifies system: / customer: / human actors", () => {
    assert.equal(s.historySourceFromActor("system:auto-release"), "system");
    assert.equal(s.historySourceFromActor("system:square-webhook"), "system");
    assert.equal(s.historySourceFromActor("customer:abc123-sub"), "customer");
    assert.equal(s.historySourceFromActor("customer:"), "customer");
    assert.equal(s.historySourceFromActor("staff@example.com"), "staff");
    assert.equal(s.historySourceFromActor(""), "staff");
    assert.equal(s.historySourceFromActor(null), "staff");
  });
});

describe("sanitizeHistoryValue", () => {
  const s = buildShared();
  it("preserves primitives and nested structures", () => {
    assert.equal(s.sanitizeHistoryValue(null), null);
    assert.equal(s.sanitizeHistoryValue("hello"), "hello");
    assert.equal(s.sanitizeHistoryValue(42), 42);
    assert.equal(s.sanitizeHistoryValue(true), true);
    assert.deepEqual(s.sanitizeHistoryValue([1, "a", null]), [1, "a", null]);
    assert.deepEqual(
      s.sanitizeHistoryValue({ a: 1, b: { c: "x", d: null } }),
      { a: 1, b: { c: "x", d: null } }
    );
  });

  it("drops undefined values from objects and arrays", () => {
    assert.deepEqual(
      s.sanitizeHistoryValue({ a: 1, b: undefined, c: 3 }),
      { a: 1, c: 3 }
    );
    assert.deepEqual(s.sanitizeHistoryValue([1, undefined, 3]), [1, 3]);
  });

  it("drops functions and symbols too", () => {
    assert.deepEqual(
      s.sanitizeHistoryValue({ a: 1, b: () => 1, c: Symbol("s") }),
      { a: 1 }
    );
  });
});

describe("normalizeDeadlineLocalIso", () => {
  const s = buildShared();
  it("normalizes valid forms (with and without seconds)", () => {
    assert.equal(s.normalizeDeadlineLocalIso("2026-05-09T22:00"), "2026-05-09T22:00:00");
    assert.equal(s.normalizeDeadlineLocalIso("2026-05-09T22:00:30"), "2026-05-09T22:00:30");
  });
  it("returns null for invalid", () => {
    assert.equal(s.normalizeDeadlineLocalIso(""), null);
    assert.equal(s.normalizeDeadlineLocalIso("not-a-date"), null);
    assert.equal(s.normalizeDeadlineLocalIso(null), null);
  });
});

describe("nowInTimeZoneLocalIso", () => {
  const s = buildShared();
  it("returns a YYYY-MM-DDTHH:mm:ss string for a valid IANA tz", () => {
    const got = s.nowInTimeZoneLocalIso("America/Chicago");
    assert.match(got, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
  it("returns null for invalid tz", () => {
    assert.equal(s.nowInTimeZoneLocalIso("Not/A_Real_Tz"), null);
  });
});

describe("addMinutesToLocalIso", () => {
  const s = buildShared();
  it("adds minutes correctly", () => {
    assert.equal(s.addMinutesToLocalIso("2026-05-09T22:00:00", 30), "2026-05-09T22:30:00");
    assert.equal(s.addMinutesToLocalIso("2026-05-09T23:45:00", 30), "2026-05-10T00:15:00");
  });
  it("handles negative minutes", () => {
    assert.equal(s.addMinutesToLocalIso("2026-05-10T00:15:00", -30), "2026-05-09T23:45:00");
  });
  it("returns null for malformed input", () => {
    assert.equal(s.addMinutesToLocalIso("garbage", 30), null);
  });
});

describe("localIsoToEpochSeconds", () => {
  const s = buildShared();
  it("converts CST wall clock to epoch (UTC-6 in winter)", () => {
    // 2026-01-15 22:00 in America/Chicago = 2026-01-16 04:00 UTC
    const epoch = s.localIsoToEpochSeconds("2026-01-15T22:00:00", "America/Chicago");
    assert.equal(epoch, Math.floor(Date.UTC(2026, 0, 16, 4, 0, 0) / 1000));
  });
  it("converts CDT wall clock to epoch (UTC-5 in summer)", () => {
    // 2026-07-15 22:00 in America/Chicago = 2026-07-16 03:00 UTC
    const epoch = s.localIsoToEpochSeconds("2026-07-15T22:00:00", "America/Chicago");
    assert.equal(epoch, Math.floor(Date.UTC(2026, 6, 16, 3, 0, 0) / 1000));
  });
  it("returns null for malformed input", () => {
    assert.equal(s.localIsoToEpochSeconds("nope", "America/Chicago"), null);
  });
});

describe("isFrequentAutoReservation", () => {
  const s = buildShared();
  it("matches FREQUENT_AUTO source", () => {
    assert.equal(s.isFrequentAutoReservation({ reservationSource: "FREQUENT_AUTO" }), true);
    assert.equal(s.isFrequentAutoReservation({ reservationSource: "frequent_auto" }), true);
  });
  it("matches when frequentClientId is set (regardless of source)", () => {
    assert.equal(s.isFrequentAutoReservation({ frequentClientId: "abc" }), true);
  });
  it("returns false for normal reservations", () => {
    assert.equal(s.isFrequentAutoReservation({}), false);
    assert.equal(s.isFrequentAutoReservation({ reservationSource: "STAFF" }), false);
  });
});

describe("isOverdueReservation", () => {
  const s = buildShared();
  it("returns false for non-CONFIRMED reservations", () => {
    assert.equal(s.isOverdueReservation({ status: "CANCELLED" }), false);
  });
  it("returns false for paymentStatus PAID/COURTESY", () => {
    assert.equal(s.isOverdueReservation({ status: "CONFIRMED", paymentStatus: "PAID" }), false);
    assert.equal(s.isOverdueReservation({ status: "CONFIRMED", paymentStatus: "COURTESY" }), false);
  });
  it("returns false when there's no deadline", () => {
    assert.equal(
      s.isOverdueReservation({ status: "CONFIRMED", paymentStatus: "PENDING" }),
      false
    );
  });
  it("returns true when the deadline is well in the past (CST)", () => {
    assert.equal(
      s.isOverdueReservation({
        status: "CONFIRMED",
        paymentStatus: "PENDING",
        paymentDeadlineAt: "2020-01-01T00:00:00",
        paymentDeadlineTz: "America/Chicago",
      }),
      true
    );
  });
});

describe("resolveCashReceiptNumberRequired", () => {
  const s = buildShared();
  it("defaults to true when unset / non-boolean", () => {
    assert.equal(s.resolveCashReceiptNumberRequired(undefined), true);
    assert.equal(s.resolveCashReceiptNumberRequired({}), true);
    assert.equal(s.resolveCashReceiptNumberRequired({ cashReceiptNumberRequired: "yes" }), true);
  });
  it("respects explicit booleans", () => {
    assert.equal(s.resolveCashReceiptNumberRequired({ cashReceiptNumberRequired: false }), false);
    assert.equal(s.resolveCashReceiptNumberRequired({ cashReceiptNumberRequired: true }), true);
  });
});

describe("settings resolvers", () => {
  const s = buildShared();

  it("resolveHoldTtlSeconds clamps within [60, 1800]", () => {
    assert.equal(s.resolveHoldTtlSeconds({ holdTtlSeconds: 300 }), 300);
    assert.equal(s.resolveHoldTtlSeconds({ holdTtlSeconds: 5000 }), 1800);
    assert.equal(s.resolveHoldTtlSeconds({ holdTtlSeconds: 30 }), 60);
    assert.equal(s.resolveHoldTtlSeconds({}), DEFAULT_HOLD_TTL_SECONDS);
  });

  it("resolveDefaultPaymentDeadlineTz falls back to America/Chicago", () => {
    assert.equal(s.resolveDefaultPaymentDeadlineTz({ operatingTz: "Europe/Madrid" }), "Europe/Madrid");
    assert.equal(s.resolveDefaultPaymentDeadlineTz({}), DEFAULT_DEADLINE_TZ);
    assert.equal(s.resolveDefaultPaymentDeadlineTz(null), DEFAULT_DEADLINE_TZ);
  });

  it("resolvePaymentLinkTtlMinutes (non-frequent path) clamps to [1, 120]", () => {
    assert.equal(s.resolvePaymentLinkTtlMinutes({ paymentLinkTtlMinutes: 30 }, false), 30);
    assert.equal(s.resolvePaymentLinkTtlMinutes({ paymentLinkTtlMinutes: 200 }, false), 120);
    assert.equal(s.resolvePaymentLinkTtlMinutes({ paymentLinkTtlMinutes: 0 }, false), 1);
    assert.equal(s.resolvePaymentLinkTtlMinutes({}, false), 10);
  });

  it("resolvePaymentLinkTtlMinutes (frequent path) clamps to [10, 10080]", () => {
    assert.equal(s.resolvePaymentLinkTtlMinutes({ frequentPaymentLinkTtlMinutes: 1440 }, true), 1440);
    assert.equal(s.resolvePaymentLinkTtlMinutes({ frequentPaymentLinkTtlMinutes: 99999 }, true), 10080);
    assert.equal(s.resolvePaymentLinkTtlMinutes({}, true), 1440);
  });
});

describe("getRuntimeSettings", () => {
  it("returns null when getAppSettings is not provided", async () => {
    const s = buildShared();
    const got = await s.getRuntimeSettings();
    assert.equal(got, null);
  });

  it("returns the resolved settings on success", async () => {
    const s = buildShared({ getAppSettings: async () => ({ operatingTz: "Europe/Madrid" }) });
    const got = await s.getRuntimeSettings();
    assert.deepEqual(got, { operatingTz: "Europe/Madrid" });
  });

  it("swallows errors and returns null", async () => {
    const s = buildShared({
      getAppSettings: async () => {
        throw new Error("boom");
      },
    });
    const got = await s.getRuntimeSettings();
    assert.equal(got, null);
  });
});

describe("shouldUseFrequentPaymentLinkTtl", () => {
  it("short-circuits true for FREQUENT_AUTO reservations", async () => {
    const s = buildShared({
      isFrequentReservationByPhoneAndTable: async () => false,
    });
    assert.equal(
      await s.shouldUseFrequentPaymentLinkTtl({ reservationSource: "FREQUENT_AUTO" }),
      true
    );
  });

  it("uses the dependency for non-frequent-auto reservations", async () => {
    const s = buildShared({
      isFrequentReservationByPhoneAndTable: async (args) => args.tableId === "T1",
    });
    assert.equal(
      await s.shouldUseFrequentPaymentLinkTtl({ phone: "+12025550123", tableId: "T1" }),
      true
    );
    assert.equal(
      await s.shouldUseFrequentPaymentLinkTtl({ phone: "+12025550123", tableId: "T2" }),
      false
    );
  });

  it("returns false (and swallows) when the dep throws", async () => {
    const s = buildShared({
      isFrequentReservationByPhoneAndTable: async () => {
        throw new Error("dep blew up");
      },
    });
    assert.equal(
      await s.shouldUseFrequentPaymentLinkTtl({ phone: "+12025550123", tableId: "T1" }),
      false
    );
  });

  it("returns false when the dep is missing", async () => {
    const s = buildShared({});
    assert.equal(
      await s.shouldUseFrequentPaymentLinkTtl({ phone: "+12025550123", tableId: "T1" }),
      false
    );
  });
});

describe("appendReservationHistory", () => {
  it("writes a single history row with the documented PK/SK shape", async () => {
    const ddb = makeFakeDdb();
    const s = buildShared({ ddb });
    await s.appendReservationHistory({
      eventDate: "2026-05-09",
      reservationId: "res-1",
      eventType: "PAYMENT_RECORDED",
      actor: "staff@example.com",
      details: { amount: 50, method: "cash" },
    });
    assert.equal(ddb.calls.length, 1);
    const put = ddb.calls[0];
    assert.equal(put.name, "PutCommand");
    assert.equal(put.input.Item.PK, "EVENTDATE#2026-05-09");
    assert.equal(put.input.Item.SK, "HIST#res-1#001700000000#fake-uuid-0000");
    assert.equal(put.input.Item.eventType, "PAYMENT_RECORDED");
    assert.equal(put.input.Item.actor, "staff@example.com");
    assert.deepEqual(put.input.Item.details, { amount: 50, method: "cash" });
  });

  it("no-ops on malformed inputs without throwing", async () => {
    const ddb = makeFakeDdb();
    const s = buildShared({ ddb });
    await s.appendReservationHistory({ eventDate: "garbage", reservationId: "x", eventType: "X" });
    await s.appendReservationHistory({ eventDate: "2026-05-09", reservationId: "", eventType: "X" });
    await s.appendReservationHistory({ eventDate: "2026-05-09", reservationId: "x", eventType: "" });
    assert.equal(ddb.calls.length, 0);
  });
});

describe("tryEnsureCheckInPass", () => {
  it("returns null when the dep is missing", async () => {
    const s = buildShared({});
    const got = await s.tryEnsureCheckInPass({ status: "CONFIRMED", paymentStatus: "PAID" }, "u");
    assert.equal(got, null);
  });

  it("returns null for non-PAID reservations", async () => {
    const s = buildShared({ ensureCheckInPassForReservation: async () => ({ issued: true }) });
    assert.equal(
      await s.tryEnsureCheckInPass({ status: "CONFIRMED", paymentStatus: "PENDING" }, "u"),
      null
    );
    assert.equal(
      await s.tryEnsureCheckInPass({ status: "CANCELLED", paymentStatus: "PAID" }, "u"),
      null
    );
  });

  it("invokes the dep for CONFIRMED + PAID and returns its result", async () => {
    const s = buildShared({
      ensureCheckInPassForReservation: async () => ({ issued: true, pass: { passId: "p1" } }),
    });
    const got = await s.tryEnsureCheckInPass(
      { status: "CONFIRMED", paymentStatus: "PAID", reservationId: "r1" },
      "u"
    );
    assert.deepEqual(got, { issued: true, pass: { passId: "p1" } });
  });

  it("returns null on dep error (does not throw)", async () => {
    const s = buildShared({
      ensureCheckInPassForReservation: async () => {
        throw new Error("boom");
      },
    });
    const got = await s.tryEnsureCheckInPass(
      { status: "CONFIRMED", paymentStatus: "PAID", reservationId: "r1" },
      "u"
    );
    assert.equal(got, null);
  });
});

describe("queryReservationsForEventDate", () => {
  it("issues a Query with the EVENTDATE# PK + RES# prefix", async () => {
    const ddb = makeFakeDdb({
      queryResponses: [{ Items: [{ reservationId: "r1" }] }],
    });
    const s = buildShared({ ddb });
    const items = await s.queryReservationsForEventDate("2026-05-09");
    assert.deepEqual(items, [{ reservationId: "r1" }]);
    const q = ddb.calls[0];
    assert.equal(q.name, "QueryCommand");
    assert.equal(q.input.ExpressionAttributeValues[":pk"], "EVENTDATE#2026-05-09");
    assert.equal(q.input.ExpressionAttributeValues[":sk"], "RES#");
  });
});

describe("getReservationById", () => {
  it("returns the item on success", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: { reservationId: "r1", status: "CONFIRMED" } }],
    });
    const s = buildShared({ ddb });
    const got = await s.getReservationById("2026-05-09", "r1");
    assert.deepEqual(got, { reservationId: "r1", status: "CONFIRMED" });
  });

  it("throws 404 when not found", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const s = buildShared({ ddb });
    await assert.rejects(
      () => s.getReservationById("2026-05-09", "missing"),
      (err) => err?.statusCode === 404
    );
  });

  it("throws 400 on malformed eventDate / reservationId", async () => {
    const s = buildShared();
    await assert.rejects(
      () => s.getReservationById("garbage", "r1"),
      (err) => err?.statusCode === 400
    );
    await assert.rejects(
      () => s.getReservationById("2026-05-09", ""),
      (err) => err?.statusCode === 400
    );
  });
});
