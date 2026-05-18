// Tests for services-reservations-table-change.mjs.
//
// Strategy mirrors services-reservations.test.mjs:
// - Fake DocumentClient records every send() by command name.
// - Per-test response queues for GetCommand.
// - defaultShared / defaultPaymentRecording supply no-op stubs for the
//   shared + payment-recording surface the service relies on.
// - Each describe block overrides only what it needs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createReservationsTableChangeService } from "./services-reservations-table-change.mjs";

const FIXED_NOW = 1_700_000_000;
const NOW_LOCAL_ISO = "2026-05-09T12:00:00";
const TODAY_LOCAL_DATE = "2026-05-09";
const EVENT_DATE = "2026-05-30";

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
  respond,
  throwOnCommand,
} = {}) {
  let getIdx = 0;
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      const input = cmd?.input;
      calls.push({ name, input });
      if (throwOnCommand?.[name]) {
        const candidate = throwOnCommand[name];
        if (typeof candidate === "function") throw candidate(input, calls.length);
        throw candidate;
      }
      if (respond?.[name]) return respond[name](input, calls.length, name);
      if (name === "GetCommand") {
        return getResponses[getIdx++] ?? { Item: null };
      }
      return {};
    },
  };
}

function defaultShared(overrides = {}) {
  const historyCalls = [];
  const ensurePassCalls = [];
  const sendPassSmsCalls = [];
  const base = {
    roundMoney: (n) => Math.round(Number(n ?? 0) * 100) / 100,
    toRescheduleCreditSk: (phone, id) => `CREDIT#PHONE#${phone}#${id}`,
    historySourceFromActor: (user) => {
      const v = String(user ?? "");
      if (v.startsWith("system:")) return "system";
      if (v.startsWith("customer:")) return "customer";
      return "staff";
    },
    getRuntimeSettings: async () => ({}),
    resolveDefaultPaymentDeadlineTz: () => "America/Chicago",
    nowInTimeZoneLocalIso: () => NOW_LOCAL_ISO,
    resolveCashReceiptNumberRequired: () => true,
    appendReservationHistory: async (entry) => {
      historyCalls.push(entry);
    },
    getReservationById: async () => null,
    tryEnsureCheckInPass: async (reservation, user, opts) => {
      ensurePassCalls.push({ reservation, user, opts: opts ?? null });
      // Default: simulate a successful reissue so trySendCheckInPassSms
      // gets a chance to fire. Override per-test for the failure path.
      return {
        issued: true,
        reused: false,
        pass: {
          passId: "pass-after-change",
          url: "https://example.invalid/pass",
        },
      };
    },
    trySendCheckInPassSms: async (reservation, passResult, actor) => {
      sendPassSmsCalls.push({ reservation, passResult, actor });
      return null;
    },
    // Default: not frequent. Auto-regen tests override this to async () => true.
    shouldUseFrequentPaymentLinkTtl: async () => false,
  };
  return {
    historyCalls,
    ensurePassCalls,
    sendPassSmsCalls,
    shared: { ...base, ...overrides },
  };
}

function defaultPaymentRecording(overrides = {}) {
  const markInactiveCalls = [];
  const setLinkWindowCalls = [];
  return {
    markInactiveCalls,
    setLinkWindowCalls,
    paymentRecording: {
      markReservationPaymentLinkInactive: async (args) => {
        markInactiveCalls.push(args);
        if (typeof overrides.markReservationPaymentLinkInactive === "function") {
          return overrides.markReservationPaymentLinkInactive(args);
        }
        return null;
      },
      // Always record. Auto-regen tests pass a custom return via overrides
      // (e.g. to simulate the post-stamp row); the recording itself stays in
      // the harness so the test surface (`setLinkWindowCalls`) is stable
      // regardless of which path overrides the response.
      setReservationPaymentLinkWindow: async (args) => {
        setLinkWindowCalls.push(args);
        if (typeof overrides.setReservationPaymentLinkWindow === "function") {
          return overrides.setReservationPaymentLinkWindow(args);
        }
        return null;
      },
    },
  };
}

function buildService(overrides = {}) {
  const ddb = overrides.ddb ?? makeFakeDdb();
  const sharedHarness = defaultShared(overrides.shared ?? {});
  const prHarness = defaultPaymentRecording(overrides.paymentRecording ?? {});
  const deactivateCalls = [];
  const refundCalls = [];
  const revokePassCalls = [];
  const createSquareLinkCalls = [];

  const deps = {
    ddb,
    tableNames: {
      EVENTS_TABLE: "ff-events",
      HOLDS_TABLE: "ff-table-holds",
      RES_TABLE: "ff-reservations",
      CLIENTS_TABLE: "ff-clients",
    },
    requiredEnv: (_n, v) => v,
    httpError,
    nowEpoch: () => FIXED_NOW,
    addDaysToIsoDate: (date, n) => {
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
    getEventByDate:
      overrides.getEventByDate ??
      (async () => ({
        eventId: "ev1",
        eventDate: EVENT_DATE,
        minDeposit: 0,
        tablePrices: { T1: 100, T2: 200, T3: 50, T4: 75, T5: 125 },
        frequentReleasedTables: [],
      })),
    getTablePriceForEvent:
      overrides.getTablePriceForEvent ??
      ((event, tableId) => event?.tablePrices?.[tableId] ?? null),
    deactivateSquarePaymentLink:
      overrides.deactivateSquarePaymentLink ??
      (async (args) => {
        deactivateCalls.push(args);
        return { alreadyGone: false };
      }),
    refundSquarePayment:
      overrides.refundSquarePayment ??
      (async (args) => {
        refundCalls.push(args);
        return {
          refund: { id: `rfnd_${args.paymentId}`, status: "PENDING" },
        };
      }),
    revokeActivePassesForReservation:
      overrides.revokeActivePassesForReservation ??
      (async (reservationId, revokedBy) => {
        revokePassCalls.push({ reservationId, revokedBy });
        return { revoked: 1 };
      }),
    // Threaded for the post-swap auto-regen path (frequent reservations
    // only). Undefined by default so the existing tests that don't opt
    // in keep the manual-regen behavior. Auto-regen tests pass a
    // function via overrides.createSquarePaymentLink.
    createSquarePaymentLink: overrides.createSquarePaymentLink
      ? async (args) => {
          createSquareLinkCalls.push(args);
          return overrides.createSquarePaymentLink(args);
        }
      : undefined,
  };

  const svc = createReservationsTableChangeService(
    deps,
    sharedHarness.shared,
    prHarness.paymentRecording
  );

  return {
    ddb,
    svc,
    historyCalls: sharedHarness.historyCalls,
    ensurePassCalls: sharedHarness.ensurePassCalls,
    sendPassSmsCalls: sharedHarness.sendPassSmsCalls,
    markInactiveCalls: prHarness.markInactiveCalls,
    setLinkWindowCalls: prHarness.setLinkWindowCalls,
    deactivateCalls,
    refundCalls,
    revokePassCalls,
    createSquareLinkCalls,
  };
}

function reservationItem(overrides = {}) {
  return {
    PK: `EVENTDATE#${EVENT_DATE}`,
    SK: "RES#r1",
    reservationId: "r1",
    eventDate: EVENT_DATE,
    tableId: "T1",
    tableIds: ["T1"],
    tablePrice: 100,
    tablePrices: [100],
    customerName: "Alice",
    phone: "+12025550100",
    phoneCountry: "US",
    status: "CONFIRMED",
    paymentStatus: "PAID",
    paymentMethod: "cash",
    depositAmount: 100,
    amountDue: 100,
    payments: [
      {
        paymentId: "p1",
        amount: 100,
        method: "cash",
        source: "manual",
        receiptNumber: "1",
        createdAt: FIXED_NOW - 1000,
        createdBy: "staff@x",
      },
    ],
    ...overrides,
  };
}

function basePayload(overrides = {}) {
  return {
    reservationId: "r1",
    eventDate: EVENT_DATE,
    newTableIds: ["T2"],
    newHoldsByTableId: { T2: "h-T2" },
    expectedTablePriceTotal: 200,
    reason: "Customer requested upgrade",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("changeReservationTables — input validation", () => {
  it("400 when reservationId missing", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.changeReservationTables(basePayload({ reservationId: "" }), "u"),
      (err) => err.statusCode === 400 && /reservationId/.test(err.message)
    );
  });

  it("400 on bad eventDate format", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.changeReservationTables(basePayload({ eventDate: "x" }), "u"),
      (err) => err.statusCode === 400 && /eventDate/.test(err.message)
    );
  });

  it("400 when newTableIds is empty", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.changeReservationTables(basePayload({ newTableIds: [] }), "u"),
      (err) => err.statusCode === 400 && /newTableIds is required/.test(err.message)
    );
  });

  it("400 when newTableIds exceeds MAX_TABLES_PER_RESERVATION (10)", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({
            newTableIds: Array.from({ length: 11 }, (_, i) => `T${i + 100}`),
          }),
          "u"
        ),
      (err) => err.statusCode === 400 && /more than 10/.test(err.message)
    );
  });

  it("400 on duplicate newTableIds", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () =>
        svc.changeReservationTables(basePayload({ newTableIds: ["T2", "T2"] }), "u"),
      (err) => err.statusCode === 400 && /unique/.test(err.message)
    );
  });

  it("400 when expectedTablePriceTotal is not a number", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({ expectedTablePriceTotal: "nope" }),
          "u"
        ),
      (err) => err.statusCode === 400 && /expectedTablePriceTotal/.test(err.message)
    );
  });

  it("400 when reason is missing", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.changeReservationTables(basePayload({ reason: "" }), "u"),
      (err) => err.statusCode === 400 && /reason is required/.test(err.message)
    );
  });

  it("409 when reservation is not CONFIRMED", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem({ status: "CANCELLED" }) },
    });
    await assert.rejects(
      () => svc.changeReservationTables(basePayload(), "u"),
      (err) => err.statusCode === 409 && /CONFIRMED/.test(err.message)
    );
  });

  it("400 when reservation paymentStatus is COURTESY", async () => {
    const { svc } = buildService({
      shared: {
        getReservationById: async () => reservationItem({ paymentStatus: "COURTESY" }),
      },
    });
    await assert.rejects(
      () => svc.changeReservationTables(basePayload(), "u"),
      (err) => err.statusCode === 400 && /courtesy/.test(err.message)
    );
  });

  it("400 when reservation paymentStatus is REFUNDED", async () => {
    const { svc } = buildService({
      shared: {
        getReservationById: async () => reservationItem({ paymentStatus: "REFUNDED" }),
      },
    });
    await assert.rejects(
      () => svc.changeReservationTables(basePayload(), "u"),
      (err) => err.statusCode === 400 && /refunded/.test(err.message)
    );
  });

  it("400 when newTableIds is identical to current tables (no-op)", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() }, // current = [T1]
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({
            newTableIds: ["T1"],
            newHoldsByTableId: {},
            expectedTablePriceTotal: 100,
          }),
          "u"
        ),
      (err) => err.statusCode === 400 && /identical/.test(err.message)
    );
  });

  it("400 when newTableIds adds a table without a holdId", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({ newTableIds: ["T2"], newHoldsByTableId: {} }),
          "u"
        ),
      (err) =>
        err.statusCode === 400 && /Missing holdId for new table T2/.test(err.message)
    );
  });

  it("404 when event not found", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
      getEventByDate: async () => null,
    });
    await assert.rejects(
      () => svc.changeReservationTables(basePayload(), "u"),
      (err) => err.statusCode === 404 && /Event not found/.test(err.message)
    );
  });

  it("400 when one of the new tables has no price for the event", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
      getEventByDate: async () => ({
        eventId: "ev1",
        eventDate: EVENT_DATE,
        tablePrices: { T1: 100 },
      }),
    });
    await assert.rejects(
      () => svc.changeReservationTables(basePayload(), "u"),
      (err) => err.statusCode === 400 && /Invalid tableId/.test(err.message)
    );
  });

  it("409 when expectedTablePriceTotal does not match server-computed sum (stale UI)", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({ expectedTablePriceTotal: 999 }),
          "u"
        ),
      (err) => err.statusCode === 409 && /Table prices changed/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// delta = 0 (same total price, table set still changes)
// ---------------------------------------------------------------------------

describe("changeReservationTables — delta = 0", () => {
  it("swaps tables atomically when prices balance, no payment required", async () => {
    // current [T1=$100], new [T3=$50, T4=$75]... no wait, that's $125.
    // Use [T1=$100] -> [T3=$50, T4=$75-25? Pick prices that sum to same].
    // Simpler: events with prices {T1: 100, T2: 100, T3: 50, T4: 50}.
    const { ddb, svc, historyCalls } = buildService({
      shared: { getReservationById: async () => reservationItem() }, // current=[T1] $100
      getEventByDate: async () => ({
        eventId: "ev1",
        eventDate: EVENT_DATE,
        tablePrices: { T1: 100, T3: 50, T4: 50 },
      }),
    });
    const out = await svc.changeReservationTables(
      basePayload({
        newTableIds: ["T3", "T4"],
        newHoldsByTableId: { T3: "h-T3", T4: "h-T4" },
        expectedTablePriceTotal: 100,
      }),
      "staff@x"
    );
    assert.equal(out.delta, 0);
    assert.equal(out.newAmountDue, 100);
    assert.deepEqual(out.newTablePrices, [50, 50]);
    assert.equal(out.payment, null);
    assert.equal(out.overpayment, null);
    assert.deepEqual(out.reservation.tableIds, ["T3", "T4"]);
    assert.equal(out.reservation.tablePrice, 100);
    assert.equal(out.reservation.paymentStatus, "PAID");

    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    assert.ok(txn, "TransactWriteCommand sent");
    // 1 Delete (T1) + 2 Updates (T3, T4 HOLD->RESERVED) + 1 Update (reservation)
    assert.equal(txn.input.TransactItems.length, 4);
    const items = txn.input.TransactItems;
    assert.equal(items[0].Delete.Key.SK, "TABLE#T1");
    assert.equal(items[0].Delete.ConditionExpression, "lockType = :reserved AND reservationId = :rid");
    assert.equal(items[1].Update.Key.SK, "TABLE#T3");
    assert.equal(
      items[1].Update.ConditionExpression,
      "lockType = :hold AND holdId = :hid AND expiresAt >= :graceCutoff"
    );
    assert.equal(items[1].Update.ExpressionAttributeValues[":hid"], "h-T3");
    assert.equal(items[2].Update.Key.SK, "TABLE#T4");
    assert.equal(items[2].Update.ExpressionAttributeValues[":hid"], "h-T4");

    const resUpd = items[3].Update;
    assert.equal(resUpd.TableName, "ff-reservations");
    assert.equal(
      resUpd.ConditionExpression,
      "#status = :confirmed AND #depositAmount = :currentPaid AND #tablePrice = :oldTablePrice"
    );
    assert.equal(resUpd.ExpressionAttributeValues[":currentPaid"], 100);
    assert.equal(resUpd.ExpressionAttributeValues[":oldTablePrice"], 100);
    assert.deepEqual(resUpd.ExpressionAttributeValues[":newTableIds"], ["T3", "T4"]);
    assert.equal(resUpd.ExpressionAttributeValues[":newTablePrice"], 100);
    assert.equal(resUpd.ExpressionAttributeValues[":newAmountDue"], 100);

    // TABLE_CHANGED history written
    const hist = historyCalls.find((h) => h.eventType === "TABLE_CHANGED");
    assert.ok(hist);
    assert.deepEqual(hist.details.fromTableIds, ["T1"]);
    assert.deepEqual(hist.details.toTableIds, ["T3", "T4"]);
    assert.equal(hist.details.delta, 0);
    assert.deepEqual(hist.details.addedTableIds, ["T3", "T4"]);
    assert.deepEqual(hist.details.removedTableIds, ["T1"]);
  });

  it("kept tables (intersection) are untouched in TransactWrite", async () => {
    // current [T1, T2] $300 (100+200), new [T1, T3, T4] $225 (100+50+75).
    // Actually for delta=0 with overlap, need 100+T_old = 100+T_new.
    // Use current [T1=$100, T2=$200] $300, new [T1=$100, T5=$125, T4=$75] $300.
    const { ddb, svc } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T1",
            tableIds: ["T1", "T2"],
            tablePrice: 300,
            tablePrices: [100, 200],
            amountDue: 300,
            depositAmount: 300,
          }),
      },
    });
    const out = await svc.changeReservationTables(
      basePayload({
        newTableIds: ["T1", "T5", "T4"],
        newHoldsByTableId: { T5: "h-T5", T4: "h-T4" }, // T1 is kept, no hold needed
        expectedTablePriceTotal: 300,
      }),
      "staff@x"
    );
    assert.equal(out.delta, 0);
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    // No Delete for T1 (kept). Delete T2 only. Updates T5, T4 only.
    const items = txn.input.TransactItems;
    assert.equal(items.length, 4); // 1 Delete + 2 Updates + 1 Reservation Update
    const deleteKeys = items
      .filter((i) => i.Delete)
      .map((i) => i.Delete.Key.SK);
    assert.deepEqual(deleteKeys, ["TABLE#T2"]);
    const updateHoldKeys = items
      .filter((i) => i.Update && i.Update.TableName === "ff-table-holds")
      .map((i) => i.Update.Key.SK);
    assert.deepEqual(updateHoldKeys.sort(), ["TABLE#T4", "TABLE#T5"].sort());
  });
});

// ---------------------------------------------------------------------------
// delta > 0 — cash bundled
// ---------------------------------------------------------------------------

describe("changeReservationTables — delta > 0 cash payment", () => {
  it("bundles cash payment for the exact delta in the reservation Update", async () => {
    const { ddb, svc, historyCalls } = buildService({
      shared: { getReservationById: async () => reservationItem() }, // [T1] $100 PAID
    });
    const out = await svc.changeReservationTables(
      basePayload({
        // T2=$200, delta=$100
        payment: {
          method: "cash",
          amount: 100,
          receiptNumber: "12345",
          note: "Upgrade to T2",
        },
      }),
      "staff@x"
    );
    assert.equal(out.delta, 100);
    assert.equal(out.newAmountDue, 200);
    assert.equal(out.reservation.depositAmount, 200);
    assert.equal(out.reservation.paymentStatus, "PAID");
    assert.equal(out.payment.method, "cash");
    assert.equal(out.payment.amount, 100);
    assert.equal(out.payment.receiptNumber, "12345");

    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    // 1 Delete (T1) + 1 Update (T2 HOLD->RESERVED) + 1 Update (reservation)
    assert.equal(txn.input.TransactItems.length, 3);
    const resUpd = txn.input.TransactItems[2].Update;
    assert.match(resUpd.UpdateExpression, /#depositAmount = :newDeposit/);
    assert.match(resUpd.UpdateExpression, /#paymentMethod = :paymentMethod/);
    assert.match(
      resUpd.UpdateExpression,
      /#payments = list_append\(if_not_exists\(#payments, :empty\), :newPayments\)/
    );
    assert.equal(resUpd.ExpressionAttributeValues[":newDeposit"], 200);
    assert.equal(resUpd.ExpressionAttributeValues[":paymentMethod"], "cash");
    assert.equal(resUpd.ExpressionAttributeValues[":newPayments"].length, 1);
    assert.equal(
      resUpd.ExpressionAttributeValues[":newPayments"][0].method,
      "cash"
    );

    // PAID -> deadline cleared via REMOVE clause
    assert.match(resUpd.UpdateExpression, /REMOVE.*#paymentDeadlineAt/);

    // History events
    assert.ok(historyCalls.find((h) => h.eventType === "TABLE_CHANGED"));
    const paymentHist = historyCalls.find((h) => h.eventType === "PAYMENT_RECORDED");
    assert.ok(paymentHist);
    assert.equal(paymentHist.details.fromTableChange, true);
    assert.equal(paymentHist.details.amount, 100);
  });

  it("400 when payment missing for delta > 0", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () => svc.changeReservationTables(basePayload(), "u"),
      (err) =>
        err.statusCode === 400 &&
        /payment or deferredPaymentMethod is required/.test(err.message)
    );
  });

  it("400 when payment.amount does not equal delta", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({
            payment: { method: "cash", amount: 50, receiptNumber: "1" },
          }),
          "u"
        ),
      (err) =>
        err.statusCode === 400 && /must equal delta/.test(err.message)
    );
  });

  it("400 when payment.method is square (async methods unsupported in Phase 1)", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({ payment: { method: "square", amount: 100 } }),
          "u"
        ),
      (err) =>
        err.statusCode === 400 &&
        /Async payment methods.*not supported/.test(err.message)
    );
  });

  it("400 when method=cash + receiptNumber missing and settings require it", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({ payment: { method: "cash", amount: 100 } }),
          "u"
        ),
      (err) =>
        err.statusCode === 400 && /receiptNumber is required/.test(err.message)
    );
  });

  it("partial reservation: bundling delta keeps it PARTIAL with same outstanding gap", async () => {
    // Current: amountDue=$100, depositAmount=$40 (PARTIAL).
    // Swap to T2=$200 (delta=$100, payment=$100 cash).
    // newDeposit=$140, newAmountDue=$200 -> PARTIAL.
    const { svc } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            paymentStatus: "PARTIAL",
            depositAmount: 40,
            amountDue: 100,
          }),
      },
    });
    const out = await svc.changeReservationTables(
      basePayload({
        payment: { method: "cash", amount: 100, receiptNumber: "9" },
      }),
      "staff@x"
    );
    assert.equal(out.reservation.paymentStatus, "PARTIAL");
    assert.equal(out.reservation.depositAmount, 140);
    assert.equal(out.newAmountDue, 200);
  });
});

// ---------------------------------------------------------------------------
// delta > 0 — credit bundled
// ---------------------------------------------------------------------------

describe("changeReservationTables — delta > 0 credit payment", () => {
  it("bundles credit redemption: extra CLIENTS_TABLE Update in the TransactWrite", async () => {
    const { ddb, svc } = buildService({
      shared: {
        getReservationById: async () => reservationItem(),
      },
      // GetCommand sequence: 1st = credit fetch (entityType ACTIVE 200 remaining)
    });
    // Wire the credit row for the pre-flight Get
    ddb.calls.length = 0;
    const ddbWithCredit = makeFakeDdb({
      getResponses: [
        {
          Item: {
            PK: "CLIENT",
            SK: "CREDIT#PHONE#US:+12025550100#credit-1",
            entityType: "RESCHEDULE_CREDIT",
            status: "ACTIVE",
            amountRemaining: 500,
            expiresAt: "2099-12-31",
          },
        },
      ],
    });
    const { svc: svc2, historyCalls } = buildService({
      ddb: ddbWithCredit,
      shared: { getReservationById: async () => reservationItem() },
    });
    const out = await svc2.changeReservationTables(
      basePayload({
        payment: { method: "credit", amount: 100, creditId: "credit-1" },
      }),
      "staff@x"
    );
    assert.equal(out.payment.method, "credit");
    assert.equal(out.reservation.paymentStatus, "PAID");
    const txn = ddbWithCredit.calls.find((c) => c.name === "TransactWriteCommand");
    // 1 Delete (T1) + 1 Update (T2 hold) + 1 Update (reservation) + 1 Update (credit)
    assert.equal(txn.input.TransactItems.length, 4);
    const creditUpd = txn.input.TransactItems[3].Update;
    assert.equal(creditUpd.TableName, "ff-clients");
    assert.match(creditUpd.UpdateExpression, /#amountRemaining = :creditRemaining/);
    assert.equal(creditUpd.ExpressionAttributeValues[":creditRemaining"], 400); // 500 - 100
    assert.equal(creditUpd.ExpressionAttributeValues[":creditStatus"], "ACTIVE");

    // RESCHEDULE_CREDIT_APPLIED history written
    assert.ok(
      historyCalls.find((h) => h.eventType === "RESCHEDULE_CREDIT_APPLIED")
    );
  });

  it("credit drained to zero -> nextStatus USED", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: {
            PK: "CLIENT",
            SK: "CREDIT#PHONE#US:+12025550100#credit-1",
            entityType: "RESCHEDULE_CREDIT",
            status: "ACTIVE",
            amountRemaining: 100, // exactly equal to delta
            expiresAt: "2099-12-31",
          },
        },
      ],
    });
    const { svc } = buildService({
      ddb,
      shared: { getReservationById: async () => reservationItem() },
    });
    await svc.changeReservationTables(
      basePayload({
        payment: { method: "credit", amount: 100, creditId: "credit-1" },
      }),
      "staff@x"
    );
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    const creditUpd = txn.input.TransactItems[3].Update;
    assert.equal(creditUpd.ExpressionAttributeValues[":creditStatus"], "USED");
    assert.match(creditUpd.UpdateExpression, /#usedAt = :now, #usedBy = :by/);
  });

  it("404 when credit not found", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildService({
      ddb,
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({
            payment: { method: "credit", amount: 100, creditId: "missing" },
          }),
          "u"
        ),
      (err) => err.statusCode === 404 && /credit not found/i.test(err.message)
    );
  });

  it("409 when credit is not ACTIVE", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: {
            entityType: "RESCHEDULE_CREDIT",
            status: "USED",
            amountRemaining: 500,
          },
        },
      ],
    });
    const { svc } = buildService({
      ddb,
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({
            payment: { method: "credit", amount: 100, creditId: "credit-1" },
          }),
          "u"
        ),
      (err) => err.statusCode === 409 && /not active/i.test(err.message)
    );
  });

  it("400 when delta exceeds credit remaining", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: {
            entityType: "RESCHEDULE_CREDIT",
            status: "ACTIVE",
            amountRemaining: 50,
            expiresAt: "2099-12-31",
          },
        },
      ],
    });
    const { svc } = buildService({
      ddb,
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({
            payment: { method: "credit", amount: 100, creditId: "credit-1" },
          }),
          "u"
        ),
      (err) =>
        err.statusCode === 400 && /credit remaining balance/.test(err.message)
    );
  });

  it("400 when payment.method=credit but creditId is missing", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({ payment: { method: "credit", amount: 100 } }),
          "u"
        ),
      (err) => err.statusCode === 400 && /creditId is required/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// delta < 0 — overpayment resolutions
// ---------------------------------------------------------------------------

describe("changeReservationTables — delta < 0 CREDIT", () => {
  it("issues an overpayment credit Put after the swap", async () => {
    const { ddb, svc, historyCalls } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 200,
          }),
      },
    });
    // current = [T2] $200 PAID. swap to [T1] $100. delta = -$100.
    const out = await svc.changeReservationTables(
      {
        reservationId: "r1",
        eventDate: EVENT_DATE,
        newTableIds: ["T1"],
        newHoldsByTableId: { T1: "h-T1" },
        expectedTablePriceTotal: 100,
        reason: "Downgrade",
        overpaymentResolution: "CREDIT",
      },
      "staff@x"
    );
    assert.equal(out.delta, -100);
    assert.equal(out.newAmountDue, 100);
    assert.equal(out.overpayment.surplus, 100);
    assert.equal(out.overpayment.resolution, "CREDIT");
    assert.equal(out.overpayment.credit.amountTotal, 100);

    // Sequence: TransactWriteCommand (the swap), then PutCommand (the credit)
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    assert.ok(txn);
    const put = ddb.calls.find((c) => c.name === "PutCommand");
    assert.ok(put, "PutCommand for the credit row");
    assert.equal(put.input.TableName, "ff-clients");
    assert.equal(put.input.Item.entityType, "RESCHEDULE_CREDIT");
    assert.equal(put.input.Item.amountTotal, 100);
    assert.equal(put.input.Item.amountRemaining, 100);
    assert.equal(put.input.Item.status, "ACTIVE");
    assert.equal(put.input.Item.sourceReservationId, "r1");

    // OVERPAYMENT_CREDIT_ISSUED history written
    assert.ok(
      historyCalls.find((h) => h.eventType === "OVERPAYMENT_CREDIT_ISSUED")
    );
  });

  it("PARTIAL reservation dropping below paid still triggers surplus if newDue < deposit", async () => {
    // current $200 due, $150 paid (PARTIAL). swap to $100 -> newDue=$100 -> surplus=$50
    const { svc } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 150,
            paymentStatus: "PARTIAL",
          }),
      },
    });
    const out = await svc.changeReservationTables(
      {
        reservationId: "r1",
        eventDate: EVENT_DATE,
        newTableIds: ["T1"],
        newHoldsByTableId: { T1: "h-T1" },
        expectedTablePriceTotal: 100,
        reason: "Downgrade",
        overpaymentResolution: "CREDIT",
      },
      "staff@x"
    );
    assert.equal(out.delta, -100);
    assert.equal(out.newAmountDue, 100);
    assert.equal(out.overpayment.surplus, 50);
    assert.equal(out.reservation.paymentStatus, "PAID"); // $150 >= $100
  });

  it("PENDING reservation downgrade -> no surplus, no resolution side-effect fires", async () => {
    const { svc, historyCalls } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 0,
            paymentStatus: "PENDING",
            paymentMethod: null,
          }),
      },
    });
    const out = await svc.changeReservationTables(
      {
        reservationId: "r1",
        eventDate: EVENT_DATE,
        newTableIds: ["T1"],
        newHoldsByTableId: { T1: "h-T1" },
        expectedTablePriceTotal: 100,
        reason: "Downgrade",
        overpaymentResolution: "CREDIT", // accepted but no-op since surplus=0
      },
      "staff@x"
    );
    assert.equal(out.delta, -100);
    assert.equal(out.overpayment, null);
    assert.equal(out.reservation.paymentStatus, "PENDING");
    // No OVERPAYMENT_CREDIT_ISSUED history
    assert.equal(
      historyCalls.filter((h) => h.eventType === "OVERPAYMENT_CREDIT_ISSUED")
        .length,
      0
    );
  });
});

describe("changeReservationTables — delta < 0 REFUND", () => {
  it("calls refundSquarePayment for the surplus + logs PARTIAL_REFUND_ISSUED", async () => {
    const { svc, historyCalls, refundCalls } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 200,
            paymentMethod: "square",
            payments: [
              {
                paymentId: "p-sq-1",
                amount: 200,
                method: "square",
                source: "square-direct",
                provider: { providerPaymentId: "sq_pay_abc" },
                createdAt: FIXED_NOW - 100,
              },
            ],
          }),
      },
    });
    const out = await svc.changeReservationTables(
      {
        reservationId: "r1",
        eventDate: EVENT_DATE,
        newTableIds: ["T1"],
        newHoldsByTableId: { T1: "h-T1" },
        expectedTablePriceTotal: 100,
        reason: "Downgrade",
        overpaymentResolution: "REFUND",
      },
      "staff@x"
    );
    assert.equal(out.overpayment.resolution, "REFUND");
    assert.equal(out.overpayment.refund.amount, 100);
    assert.equal(refundCalls.length, 1);
    assert.equal(refundCalls[0].paymentId, "sq_pay_abc");
    assert.equal(refundCalls[0].amount, 100);
    assert.match(refundCalls[0].idempotencyKey, /^refund-tablechange-r1-p-sq-1$/);
    assert.ok(
      historyCalls.find((h) => h.eventType === "PARTIAL_REFUND_ISSUED")
    );
  });

  it("400 when REFUND requested but no Square payment exists", async () => {
    const { svc } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 200,
            payments: [
              {
                paymentId: "p-cash-1",
                amount: 200,
                method: "cash",
                source: "manual",
              },
            ],
          }),
      },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          {
            reservationId: "r1",
            eventDate: EVENT_DATE,
            newTableIds: ["T1"],
            newHoldsByTableId: { T1: "h-T1" },
            expectedTablePriceTotal: 100,
            reason: "Downgrade",
            overpaymentResolution: "REFUND",
          },
          "u"
        ),
      (err) =>
        err.statusCode === 400 &&
        /No refundable Square payment/.test(err.message)
    );
  });

  it("502 + PARTIAL_REFUND_FAILED history when refund call throws (swap stays committed)", async () => {
    const refundErr = new Error("Square refund API failed");
    const { svc, historyCalls } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 200,
            paymentMethod: "square",
            payments: [
              {
                paymentId: "p-sq-1",
                amount: 200,
                method: "square",
                provider: { providerPaymentId: "sq_pay_abc" },
              },
            ],
          }),
      },
      refundSquarePayment: async () => {
        throw refundErr;
      },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          {
            reservationId: "r1",
            eventDate: EVENT_DATE,
            newTableIds: ["T1"],
            newHoldsByTableId: { T1: "h-T1" },
            expectedTablePriceTotal: 100,
            reason: "Downgrade",
            overpaymentResolution: "REFUND",
          },
          "staff@x"
        ),
      (err) =>
        err.statusCode === 502 && /partial refund failed/i.test(err.message)
    );
    assert.ok(
      historyCalls.find((h) => h.eventType === "PARTIAL_REFUND_FAILED")
    );
    // TABLE_CHANGED still fired (swap committed before refund attempt)
    assert.ok(historyCalls.find((h) => h.eventType === "TABLE_CHANGED"));
  });
});

describe("changeReservationTables — delta < 0 LEAVE", () => {
  it("logs OVERPAYMENT_RECORDED without issuing credit or refund", async () => {
    const { ddb, svc, historyCalls, refundCalls } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 200,
          }),
      },
    });
    const out = await svc.changeReservationTables(
      {
        reservationId: "r1",
        eventDate: EVENT_DATE,
        newTableIds: ["T1"],
        newHoldsByTableId: { T1: "h-T1" },
        expectedTablePriceTotal: 100,
        reason: "Downgrade",
        overpaymentResolution: "LEAVE",
      },
      "staff@x"
    );
    assert.equal(out.overpayment.resolution, "LEAVE");
    assert.equal(refundCalls.length, 0);
    // No Put on CLIENTS_TABLE
    assert.equal(
      ddb.calls.filter(
        (c) => c.name === "PutCommand" && c.input?.TableName === "ff-clients"
      ).length,
      0
    );
    assert.ok(
      historyCalls.find((h) => h.eventType === "OVERPAYMENT_RECORDED")
    );
  });

  it("400 when overpaymentResolution missing for delta < 0", async () => {
    const { svc } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 200,
          }),
      },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          {
            reservationId: "r1",
            eventDate: EVENT_DATE,
            newTableIds: ["T1"],
            newHoldsByTableId: { T1: "h-T1" },
            expectedTablePriceTotal: 100,
            reason: "x",
          },
          "u"
        ),
      (err) =>
        err.statusCode === 400 &&
        /overpaymentResolution must be CREDIT \| REFUND \| LEAVE/.test(err.message)
    );
  });

  it("400 when payment supplied along with delta < 0", async () => {
    const { svc } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 200,
          }),
      },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          {
            reservationId: "r1",
            eventDate: EVENT_DATE,
            newTableIds: ["T1"],
            newHoldsByTableId: { T1: "h-T1" },
            expectedTablePriceTotal: 100,
            reason: "x",
            overpaymentResolution: "CREDIT",
            payment: { method: "cash", amount: 100, receiptNumber: "1" },
          },
          "u"
        ),
      (err) =>
        err.statusCode === 400 && /payment must not be provided/.test(err.message)
    );
  });

  it("400 when overpaymentResolution supplied with delta >= 0", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({
            payment: { method: "cash", amount: 100, receiptNumber: "1" },
            overpaymentResolution: "CREDIT",
          }),
          "u"
        ),
      (err) =>
        err.statusCode === 400 &&
        /overpaymentResolution must not be provided/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// Concurrency — TransactionCanceledException paths
// ---------------------------------------------------------------------------

describe("changeReservationTables — concurrency", () => {
  it("TransactionCanceledException + post-swap state matches target -> idempotent replay", async () => {
    const txnErr = new Error("TransactionCanceledException");
    txnErr.name = "TransactionCanceledException";
    let firstCall = true;
    const ddb = makeFakeDdb({
      throwOnCommand: { TransactWriteCommand: txnErr },
    });
    const { svc } = buildService({
      ddb,
      shared: {
        getReservationById: async () => {
          // 1st call: pre-flight returns current state.
          // 2nd call (after txn fails): returns post-swap state (target match).
          if (firstCall) {
            firstCall = false;
            return reservationItem();
          }
          return reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
          });
        },
      },
    });
    const out = await svc.changeReservationTables(
      basePayload({
        payment: { method: "cash", amount: 100, receiptNumber: "9" },
      }),
      "staff@x"
    );
    assert.equal(out.idempotentReplay, true);
    assert.deepEqual(out.reservation.tableIds, ["T2"]);
    assert.equal(out.reservation.idempotentReplay, true);
  });

  it("TransactionCanceledException + post-swap state mismatches -> 409", async () => {
    const txnErr = new Error("TransactionCanceledException");
    txnErr.name = "TransactionCanceledException";
    const ddb = makeFakeDdb({
      throwOnCommand: { TransactWriteCommand: txnErr },
    });
    const { svc } = buildService({
      ddb,
      shared: {
        // Both pre-flight + post-failure GET return current state (the
        // swap never happened — typical concurrent-payment race).
        getReservationById: async () => reservationItem(),
      },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({
            payment: { method: "cash", amount: 100, receiptNumber: "9" },
          }),
          "staff@x"
        ),
      (err) =>
        err.statusCode === 409 &&
        /could not complete/.test(err.message)
    );
  });

  it("non-TransactionCanceledException is propagated unchanged", async () => {
    const otherErr = new Error("DynamoDB transient failure");
    otherErr.name = "ProvisionedThroughputExceededException";
    const ddb = makeFakeDdb({
      throwOnCommand: { TransactWriteCommand: otherErr },
    });
    const { svc } = buildService({
      ddb,
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({
            payment: { method: "cash", amount: 100, receiptNumber: "9" },
          }),
          "staff@x"
        ),
      (err) => err === otherErr
    );
  });
});

// ---------------------------------------------------------------------------
// Payment-link deactivation post-swap
// ---------------------------------------------------------------------------

describe("changeReservationTables — deferred payment (delta > 0)", () => {
  it("happy path: square_stand swap commits to PARTIAL, no bundled payment", async () => {
    const { svc, historyCalls } = buildService({
      shared: { getReservationById: async () => reservationItem() }, // [T1] $100 PAID
    });
    const out = await svc.changeReservationTables(
      basePayload({
        // T2=$200, delta=+$100
        deferredPaymentMethod: "square_stand",
      }),
      "staff@x"
    );
    assert.equal(out.delta, 100);
    assert.equal(out.newAmountDue, 200);
    assert.equal(out.payment, null);
    assert.equal(out.reservation.paymentStatus, "PARTIAL");
    assert.equal(out.reservation.depositAmount, 100); // unchanged
    assert.equal(out.deferredPaymentMethod, "square_stand");

    // History: TABLE_CHANGED + DELTA_PAYMENT_DEFERRED both written.
    const tableChanged = historyCalls.find((h) => h.eventType === "TABLE_CHANGED");
    assert.ok(tableChanged);
    assert.equal(tableChanged.details.deferredPaymentMethod, "square_stand");
    const deferred = historyCalls.find((h) => h.eventType === "DELTA_PAYMENT_DEFERRED");
    assert.ok(deferred);
    assert.equal(deferred.details.method, "square_stand");
    assert.equal(deferred.details.amount, 100);
  });

  it("revokes active passes when status drops PAID -> PARTIAL", async () => {
    const { svc, revokePassCalls, historyCalls } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await svc.changeReservationTables(
      basePayload({ deferredPaymentMethod: "square_stand" }),
      "staff@x"
    );
    assert.equal(revokePassCalls.length, 1);
    assert.equal(revokePassCalls[0].reservationId, "r1");
    assert.equal(revokePassCalls[0].revokedBy, "staff@x");
    // CHECKIN_PASS_REVOKED history written for audit trail
    const revoked = historyCalls.find((h) => h.eventType === "CHECKIN_PASS_REVOKED");
    assert.ok(revoked);
    assert.equal(revoked.details.reason, "table-change-deferred-payment");
  });

  it("does NOT call the regular reissue path on the deferred-payment branch", async () => {
    const { svc, ensurePassCalls } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await svc.changeReservationTables(
      basePayload({ deferredPaymentMethod: "square_stand" }),
      "staff@x"
    );
    assert.equal(ensurePassCalls.length, 0);
  });

  it("400 when both payment and deferredPaymentMethod are provided", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({
            payment: { method: "cash", amount: 100, receiptNumber: "1" },
            deferredPaymentMethod: "square_stand",
          }),
          "u"
        ),
      (err) =>
        err.statusCode === 400 && /mutually exclusive/.test(err.message)
    );
  });

  it("400 when deferredPaymentMethod is invalid", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          basePayload({ deferredPaymentMethod: "bitcoin" }),
          "u"
        ),
      (err) =>
        err.statusCode === 400 &&
        /must be square_stand \| square \| cashapp/.test(err.message)
    );
  });

  it("400 when deferredPaymentMethod is provided for delta <= 0", async () => {
    // Reservation [T2]=$200 PAID. Swap to [T1]=$100. delta = -100.
    const { svc } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 200,
          }),
      },
    });
    await assert.rejects(
      () =>
        svc.changeReservationTables(
          {
            reservationId: "r1",
            eventDate: EVENT_DATE,
            newTableIds: ["T1"],
            newHoldsByTableId: { T1: "h-T1" },
            expectedTablePriceTotal: 100,
            reason: "Downgrade",
            deferredPaymentMethod: "square_stand",
          },
          "u"
        ),
      (err) =>
        err.statusCode === 400 &&
        /must not be provided when delta <= 0/.test(err.message)
    );
  });

  it("error message for missing payment now mentions deferredPaymentMethod alternative", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    await assert.rejects(
      () => svc.changeReservationTables(basePayload(), "u"),
      (err) =>
        err.statusCode === 400 &&
        /payment or deferredPaymentMethod is required/.test(err.message)
    );
  });
});

describe("changeReservationTables — check-in pass reissue", () => {
  it("reissues + SMSes the pass when the new state stays PAID (delta = 0)", async () => {
    const { svc, ensurePassCalls, sendPassSmsCalls } = buildService({
      shared: { getReservationById: async () => reservationItem() }, // PAID
    });
    await svc.changeReservationTables(
      basePayload({
        newTableIds: ["T2"], // T1 -> T2, same shape post-swap on simple stub
        newHoldsByTableId: { T2: "h-T2" },
        expectedTablePriceTotal: 200,
        // delta = 100, so we need a payment to stay PAID
        payment: { method: "cash", amount: 100, receiptNumber: "5" },
      }),
      "staff@x"
    );
    assert.equal(ensurePassCalls.length, 1);
    assert.equal(ensurePassCalls[0].opts?.reissue, true);
    assert.deepEqual(ensurePassCalls[0].reservation.tableIds, ["T2"]);
    assert.equal(ensurePassCalls[0].reservation.paymentStatus, "PAID");
    assert.equal(sendPassSmsCalls.length, 1);
  });

  it("does NOT reissue when the new state is PARTIAL (no bundled payment + delta>0 is rejected, but if it happens via Δ<0 dropping below paid it stays PAID — covered above)", async () => {
    // Specifically covers the case where Δ<0 makes status drop to
    // PENDING because the customer never paid in the first place.
    const { svc, ensurePassCalls, sendPassSmsCalls } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            tableId: "T2",
            tableIds: ["T2"],
            tablePrice: 200,
            tablePrices: [200],
            amountDue: 200,
            depositAmount: 0,
            paymentStatus: "PENDING",
            paymentMethod: null,
          }),
      },
    });
    await svc.changeReservationTables(
      {
        reservationId: "r1",
        eventDate: EVENT_DATE,
        newTableIds: ["T1"],
        newHoldsByTableId: { T1: "h-T1" },
        expectedTablePriceTotal: 100,
        reason: "Downgrade unpaid",
        overpaymentResolution: "LEAVE",
      },
      "staff@x"
    );
    assert.equal(ensurePassCalls.length, 0);
    assert.equal(sendPassSmsCalls.length, 0);
  });

  it("skips SMS when the reissue did not actually issue a new pass (issued:false)", async () => {
    const { svc, ensurePassCalls, sendPassSmsCalls } = buildService({
      shared: {
        getReservationById: async () => reservationItem(),
        tryEnsureCheckInPass: async () => ({
          issued: false,
          reused: true,
          pass: { passId: "p", url: "u" },
        }),
      },
    });
    await svc.changeReservationTables(
      basePayload({
        payment: { method: "cash", amount: 100, receiptNumber: "5" },
      }),
      "staff@x"
    );
    assert.equal(ensurePassCalls.length, 0); // overridden stub doesn't push
    assert.equal(sendPassSmsCalls.length, 0);
  });

  it("does not fail the swap when tryEnsureCheckInPass throws", async () => {
    const { svc } = buildService({
      shared: {
        getReservationById: async () => reservationItem(),
        tryEnsureCheckInPass: async () => {
          throw new Error("pass module unavailable");
        },
      },
    });
    const out = await svc.changeReservationTables(
      basePayload({
        payment: { method: "cash", amount: 100, receiptNumber: "5" },
      }),
      "staff@x"
    );
    assert.equal(out.reservation.paymentStatus, "PAID");
    assert.equal(out.reissuedPass, null);
  });

  it("surfaces the reissued pass in the response under `reissuedPass`", async () => {
    const { svc } = buildService({
      shared: { getReservationById: async () => reservationItem() },
    });
    const out = await svc.changeReservationTables(
      basePayload({
        payment: { method: "cash", amount: 100, receiptNumber: "5" },
      }),
      "staff@x"
    );
    assert.ok(out.reissuedPass);
    assert.equal(out.reissuedPass.passId, "pass-after-change");
  });
});

describe("changeReservationTables — payment-link deactivation", () => {
  it("deactivates an ACTIVE Square payment link after the swap", async () => {
    const { svc, deactivateCalls, markInactiveCalls } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            paymentStatus: "PARTIAL",
            depositAmount: 40,
            paymentLinkId: "PL_abc",
            paymentLinkStatus: "ACTIVE",
            paymentLinkUrl: "https://square.link/abc",
          }),
      },
    });
    await svc.changeReservationTables(
      basePayload({
        // T2=$200, delta=$100, partial payment
        payment: { method: "cash", amount: 100, receiptNumber: "5" },
      }),
      "staff@x"
    );
    assert.equal(deactivateCalls.length, 1);
    assert.equal(deactivateCalls[0].paymentLinkId, "PL_abc");
    assert.equal(markInactiveCalls.length, 1);
    assert.equal(markInactiveCalls[0].status, "DEACTIVATED");
  });

  it("does not call deactivate when paymentLinkStatus is not ACTIVE", async () => {
    const { svc, deactivateCalls } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            paymentLinkId: "PL_old",
            paymentLinkStatus: "DEACTIVATED",
          }),
      },
    });
    await svc.changeReservationTables(
      basePayload({
        payment: { method: "cash", amount: 100, receiptNumber: "5" },
      }),
      "staff@x"
    );
    assert.equal(deactivateCalls.length, 0);
  });

  it("survives a deactivation failure (still returns success)", async () => {
    const { svc, markInactiveCalls } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            paymentLinkId: "PL_abc",
            paymentLinkStatus: "ACTIVE",
          }),
      },
      deactivateSquarePaymentLink: async () => {
        throw new Error("Square API down");
      },
    });
    const out = await svc.changeReservationTables(
      basePayload({
        payment: { method: "cash", amount: 100, receiptNumber: "5" },
      }),
      "staff@x"
    );
    assert.equal(out.reservation.tableIds[0], "T2");
    assert.equal(markInactiveCalls[0].status, "DEACTIVATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// Auto-regen of Square payment link after a swap (FREQUENT reservations).
// Mirrors the eager link gen on FREQUENT_AUTO creation so a frequent
// guest's shareable link doesn't go dark across a table swap.
// ---------------------------------------------------------------------------

describe("changeReservationTables — auto-regen Square link (frequent)", () => {
  it("happy path: PAID frequent reservation swaps T1->T2 deferred, fresh link minted with remaining amount", async () => {
    let stamped = null;
    const { svc, createSquareLinkCalls, setLinkWindowCalls } = buildService({
      shared: {
        getReservationById: async () => {
          if (stamped) return stamped;
          return reservationItem({
            paymentLinkId: "PL_old",
            paymentLinkStatus: "ACTIVE",
          });
        },
        shouldUseFrequentPaymentLinkTtl: async () => true,
      },
      paymentRecording: {
        setReservationPaymentLinkWindow: async (args) => {
          // Simulate the DDB post-stamp row. The auto-regen block refetches
          // via getReservationById after this call, so seed `stamped`.
          stamped = {
            ...reservationItem(),
            tableIds: ["T2"],
            tableId: "T2",
            amountDue: 200,
            depositAmount: 100,
            paymentStatus: "PARTIAL",
            paymentLinkProvider: "square",
            paymentLinkId: args.paymentLinkId,
            paymentLinkUrl: args.paymentLinkUrl,
            paymentLinkStatus: "ACTIVE",
          };
          return stamped;
        },
      },
      createSquarePaymentLink: async () => ({
        paymentLink: { id: "PL_new", url: "https://sq.link/new" },
      }),
    });
    const out = await svc.changeReservationTables(
      basePayload({ deferredPaymentMethod: "square" }),
      "staff@x"
    );
    assert.equal(createSquareLinkCalls.length, 1, "Square link gen called");
    assert.equal(createSquareLinkCalls[0].amount, 100, "amount = remaining");
    assert.deepEqual(createSquareLinkCalls[0].tableIds, ["T2"]);
    assert.match(
      createSquareLinkCalls[0].idempotencyKey,
      /^freq:tablechange:r1:\d+$/,
      "deterministic-ish idempotency key namespaced for swap"
    );
    assert.equal(setLinkWindowCalls.length, 1);
    assert.equal(setLinkWindowCalls[0].paymentLinkId, "PL_new");
    // Response mirrors the post-stamp DDB row (refetch path)
    assert.equal(out.reservation.paymentLinkUrl, "https://sq.link/new");
    assert.equal(out.reservation.paymentLinkStatus, "ACTIVE");
  });

  it("non-frequent reservation: auto-regen does NOT fire", async () => {
    const { svc, createSquareLinkCalls } = buildService({
      shared: {
        getReservationById: async () =>
          reservationItem({
            paymentLinkId: "PL_old",
            paymentLinkStatus: "ACTIVE",
          }),
        shouldUseFrequentPaymentLinkTtl: async () => false,
      },
      createSquarePaymentLink: async () => ({
        paymentLink: { id: "PL_new", url: "https://sq.link/new" },
      }),
    });
    await svc.changeReservationTables(
      basePayload({ deferredPaymentMethod: "square" }),
      "staff@x"
    );
    assert.equal(createSquareLinkCalls.length, 0);
  });

  it("delta > 0 with bundled cash (status returns to PAID): does NOT fire (remaining=0)", async () => {
    const { svc, createSquareLinkCalls } = buildService({
      shared: {
        getReservationById: async () => reservationItem(),
        shouldUseFrequentPaymentLinkTtl: async () => true,
      },
      createSquarePaymentLink: async () => ({
        paymentLink: { id: "PL_new", url: "https://sq.link/new" },
      }),
    });
    const out = await svc.changeReservationTables(
      basePayload({
        payment: { method: "cash", amount: 100, receiptNumber: "5" },
      }),
      "staff@x"
    );
    assert.equal(out.reservation.paymentStatus, "PAID");
    assert.equal(createSquareLinkCalls.length, 0);
  });

  it("Square 5xx during auto-regen: swap still succeeds (best-effort)", async () => {
    const { svc, createSquareLinkCalls, setLinkWindowCalls } = buildService({
      shared: {
        getReservationById: async () => reservationItem(),
        shouldUseFrequentPaymentLinkTtl: async () => true,
      },
      createSquarePaymentLink: async () => {
        throw new Error("Square 502");
      },
    });
    const out = await svc.changeReservationTables(
      basePayload({ deferredPaymentMethod: "square" }),
      "staff@x"
    );
    assert.equal(createSquareLinkCalls.length, 1);
    assert.equal(setLinkWindowCalls.length, 0, "no stamp on Square failure");
    // Swap itself succeeded
    assert.equal(out.reservation.paymentStatus, "PARTIAL");
    assert.equal(out.reservation.tableIds[0], "T2");
  });

  it("createSquarePaymentLink dep not wired: no auto-regen, no error", async () => {
    const { svc, createSquareLinkCalls } = buildService({
      shared: {
        getReservationById: async () => reservationItem(),
        shouldUseFrequentPaymentLinkTtl: async () => true,
      },
      // createSquarePaymentLink intentionally omitted from overrides ->
      // buildService passes `undefined` -> auto-regen branch short-circuits.
    });
    const out = await svc.changeReservationTables(
      basePayload({ deferredPaymentMethod: "square" }),
      "staff@x"
    );
    assert.equal(createSquareLinkCalls.length, 0);
    assert.equal(out.reservation.paymentStatus, "PARTIAL");
  });

  it("frequent predicate throws: treated as non-frequent (manual-regen path)", async () => {
    const { svc, createSquareLinkCalls } = buildService({
      shared: {
        getReservationById: async () => reservationItem(),
        shouldUseFrequentPaymentLinkTtl: async () => {
          throw new Error("CRM lookup failed");
        },
      },
      createSquarePaymentLink: async () => ({
        paymentLink: { id: "PL_new", url: "https://sq.link/new" },
      }),
    });
    const out = await svc.changeReservationTables(
      basePayload({ deferredPaymentMethod: "square" }),
      "staff@x"
    );
    assert.equal(createSquareLinkCalls.length, 0);
    assert.equal(out.reservation.paymentStatus, "PARTIAL");
  });
});
