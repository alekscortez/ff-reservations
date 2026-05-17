// Tests for services-square-stand-handoff.mjs. Mirrors the fake-DDB +
// builder pattern used by services-payment-recording.test.mjs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSquareStandHandoffService } from "./services-square-stand-handoff.mjs";

const FIXED_NOW = 1_700_000_000;

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function makeFakeDdb({ getResponses = [], respond, throwOnCommand } = {}) {
  let getIndex = 0;
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      const input = cmd?.input;
      calls.push({ name, input });
      if (throwOnCommand?.[name]) throw throwOnCommand[name];
      if (respond?.[name]) return respond[name](input, calls.length);
      if (name === "GetCommand") {
        const next = getResponses[getIndex++];
        return next ?? { Item: null };
      }
      if (name === "PutCommand") return {};
      if (name === "UpdateCommand") return { Attributes: {} };
      return {};
    },
  };
}

function reservationItem(overrides = {}) {
  return {
    PK: "EVENTDATE#2026-05-20",
    SK: "RES#r1",
    status: "CONFIRMED",
    paymentStatus: "PENDING",
    amountDue: 100,
    depositAmount: 25,
    confirmationCode: "K7M3X2",
    ...overrides,
  };
}

function buildService(overrides = {}) {
  const ddb = overrides.ddb ?? makeFakeDdb();
  const addPaymentCalls = [];
  const refundCalls = [];
  const historyCalls = [];
  const orderResponses = overrides.orderResponses ?? [];
  const paymentResponses = overrides.paymentResponses ?? [];
  let orderIdx = 0;
  let paymentIdx = 0;
  const addReservationPayment =
    overrides.addReservationPayment ??
    (async (reservationId, payload, actor) => {
      addPaymentCalls.push({ reservationId, payload, actor });
      return { reservationId, paid: true };
    });
  const refundSquarePayment = overrides.refundSquarePayment
    ? async (input) => {
        refundCalls.push(input);
        return overrides.refundSquarePayment(input);
      }
    : async ({ paymentId, amount, idempotencyKey, reason }) => {
        refundCalls.push({ paymentId, amount, idempotencyKey, reason });
        return { refund: { id: `refund_${paymentId}`, status: "PENDING" } };
      };
  const appendReservationHistory =
    overrides.appendReservationHistory ??
    (async (entry) => {
      historyCalls.push(entry);
    });
  const svc = createSquareStandHandoffService({
    ddb,
    tableNames: { HOLDS_TABLE: "ff-table-holds" },
    httpError,
    nowEpoch: overrides.nowEpoch ?? (() => FIXED_NOW),
    randomUUID: overrides.randomUUID ?? (() => "fake-handoff-uuid"),
    getOrderById: async (id) => {
      const next = orderResponses[orderIdx++];
      if (next instanceof Error) throw next;
      return next ?? { order: { id, tenders: [{ payment_id: "pay_1" }] } };
    },
    getPaymentById: async (id) => {
      const next = paymentResponses[paymentIdx++];
      if (next instanceof Error) throw next;
      return (
        next ?? {
          squareEnv: "sandbox",
          payment: {
            id,
            status: "COMPLETED",
            amount_money: { amount: 7500, currency: "USD" },
            receipt_url: "https://square/r/pay_1",
            order_id: "ord_1",
            source_type: "CARD",
            idempotency_key: "idem_1",
            note: "Booking #FF-K7M3X2 • 2026-05-20",
          },
        }
      );
    },
    addReservationPayment,
    refundSquarePayment: overrides.skipRefundService ? undefined : refundSquarePayment,
    appendReservationHistory: overrides.skipHistory ? undefined : appendReservationHistory,
    getReservationById: overrides.getReservationById ??
      (async () => reservationItem()),
    defaultCallbackUrl:
      overrides.defaultCallbackUrl ??
      "https://famosofuego.com/square-stand-callback",
    handoffTtlSeconds: overrides.handoffTtlSeconds ?? 900,
  });
  return { svc, ddb, addPaymentCalls, refundCalls, historyCalls };
}

// ---------------------------------------------------------------------------
// startHandoff validation
// ---------------------------------------------------------------------------

describe("startHandoff validation", () => {
  it("400 on missing reservationId", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () =>
        svc.startHandoff({
          reservationId: "",
          eventDate: "2026-05-20",
          amount: 50,
        }),
      (err) => err?.statusCode === 400 && /reservationId is required/.test(err.message)
    );
  });

  it("400 on bad eventDate", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () =>
        svc.startHandoff({
          reservationId: "r1",
          eventDate: "tomorrow",
          amount: 50,
        }),
      (err) => err?.statusCode === 400 && /YYYY-MM-DD/.test(err.message)
    );
  });

  it("400 on non-positive amount", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () =>
        svc.startHandoff({
          reservationId: "r1",
          eventDate: "2026-05-20",
          amount: 0,
        }),
      (err) => err?.statusCode === 400 && /amount must be > 0/.test(err.message)
    );
  });

  it("400 when reservation is not CONFIRMED", async () => {
    const { svc } = buildService({
      getReservationById: async () =>
        reservationItem({ status: "CANCELLED" }),
    });
    await assert.rejects(
      () =>
        svc.startHandoff({
          reservationId: "r1",
          eventDate: "2026-05-20",
          amount: 50,
        }),
      (err) =>
        err?.statusCode === 400 && /confirmed reservations/.test(err.message)
    );
  });

  it("400 when COURTESY", async () => {
    const { svc } = buildService({
      getReservationById: async () =>
        reservationItem({ paymentStatus: "COURTESY" }),
    });
    await assert.rejects(
      () =>
        svc.startHandoff({
          reservationId: "r1",
          eventDate: "2026-05-20",
          amount: 50,
        }),
      (err) => err?.statusCode === 400 && /courtesy/.test(err.message)
    );
  });

  it("400 when reservation is already fully paid", async () => {
    const { svc } = buildService({
      getReservationById: async () =>
        reservationItem({ amountDue: 100, depositAmount: 100 }),
    });
    await assert.rejects(
      () =>
        svc.startHandoff({
          reservationId: "r1",
          eventDate: "2026-05-20",
          amount: 50,
        }),
      (err) => err?.statusCode === 400 && /already fully paid/.test(err.message)
    );
  });

  it("400 when amount exceeds remaining balance", async () => {
    const { svc } = buildService({
      getReservationById: async () =>
        reservationItem({ amountDue: 100, depositAmount: 25 }),
    });
    await assert.rejects(
      () =>
        svc.startHandoff({
          reservationId: "r1",
          eventDate: "2026-05-20",
          amount: 80,
        }),
      (err) =>
        err?.statusCode === 400 && /cannot exceed remaining balance/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// startHandoff happy path
// ---------------------------------------------------------------------------

describe("startHandoff happy path", () => {
  it("writes a PENDING handoff row with TTL + returns handoffId+callbackUrl", async () => {
    const { svc, ddb } = buildService();
    const out = await svc.startHandoff({
      reservationId: "r1",
      eventDate: "2026-05-20",
      amount: 50,
      note: "deposit",
      returnPath: "/staff/reservations",
      actor: "staff@x",
    });

    assert.equal(out.handoffId, "fake-handoff-uuid");
    assert.equal(
      out.callbackUrl,
      "https://famosofuego.com/square-stand-callback"
    );
    assert.equal(out.amount, 50);
    assert.equal(out.expiresAt, FIXED_NOW + 900);

    const put = ddb.calls.find((c) => c.name === "PutCommand");
    assert.ok(put, "PutCommand expected");
    const item = put.input.Item;
    assert.equal(item.PK, "STANDPAY");
    assert.equal(item.SK, "HANDOFF#fake-handoff-uuid");
    assert.equal(item.status, "PENDING");
    assert.equal(item.reservationId, "r1");
    assert.equal(item.eventDate, "2026-05-20");
    assert.equal(item.amount, 50);
    assert.equal(item.note, "deposit");
    assert.equal(item.returnPath, "/staff/reservations");
    assert.equal(item.confirmationCode, "K7M3X2");
    assert.equal(item.expiresAt, FIXED_NOW + 900);
  });

  it("accepts caller-supplied callbackUrl override", async () => {
    const { svc, ddb } = buildService();
    await svc.startHandoff({
      reservationId: "r1",
      eventDate: "2026-05-20",
      amount: 50,
      callbackUrl: "https://staging.example.com/cb",
    });
    const put = ddb.calls.find((c) => c.name === "PutCommand");
    assert.equal(put.input.Item.callbackUrl, "https://staging.example.com/cb");
  });
});

// ---------------------------------------------------------------------------
// completeHandoff
// ---------------------------------------------------------------------------

describe("completeHandoff validation", () => {
  it("400 missing handoffId", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "", transactionId: "tx" }),
      (err) => err?.statusCode === 400 && /handoffId/.test(err.message)
    );
  });

  it("400 missing transactionId", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "h", transactionId: "" }),
      (err) => err?.statusCode === 400 && /transactionId/.test(err.message)
    );
  });

  it("404 when handoff row not found", async () => {
    const { svc } = buildService({
      ddb: makeFakeDdb({ getResponses: [{ Item: null }] }),
    });
    await assert.rejects(
      () =>
        svc.completeHandoff({ handoffId: "missing", transactionId: "tx" }),
      (err) => err?.statusCode === 404 && /Handoff not found/.test(err.message)
    );
  });

  it("409 when handoff was cancelled", async () => {
    const { svc } = buildService({
      ddb: makeFakeDdb({
        getResponses: [
          {
            Item: {
              status: "CANCELLED",
              reservationId: "r1",
              eventDate: "2026-05-20",
              expiresAt: FIXED_NOW + 60,
            },
          },
        ],
      }),
    });
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "h", transactionId: "tx" }),
      (err) => err?.statusCode === 409 && /cancelled/.test(err.message)
    );
  });

  it("409 when handoff is expired", async () => {
    const { svc } = buildService({
      ddb: makeFakeDdb({
        getResponses: [
          {
            Item: {
              status: "PENDING",
              reservationId: "r1",
              eventDate: "2026-05-20",
              expiresAt: FIXED_NOW - 1,
            },
          },
        ],
      }),
    });
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "h", transactionId: "tx" }),
      (err) => err?.statusCode === 409 && /expired/.test(err.message)
    );
  });

  it("400 when reservationId does not match", async () => {
    const { svc } = buildService({
      ddb: makeFakeDdb({
        getResponses: [
          {
            Item: {
              status: "PENDING",
              reservationId: "r1",
              eventDate: "2026-05-20",
              expiresAt: FIXED_NOW + 60,
            },
          },
        ],
      }),
    });
    await assert.rejects(
      () =>
        svc.completeHandoff({
          reservationId: "different",
          handoffId: "h",
          transactionId: "tx",
        }),
      (err) =>
        err?.statusCode === 400 && /does not match the handoff/.test(err.message)
    );
  });

  it("502 when Square order has no payment tender", async () => {
    const { svc } = buildService({
      ddb: makeFakeDdb({
        getResponses: [
          {
            Item: {
              status: "PENDING",
              reservationId: "r1",
              eventDate: "2026-05-20",
              expiresAt: FIXED_NOW + 60,
            },
          },
        ],
      }),
      orderResponses: [{ order: { id: "tx", tenders: [] } }],
    });
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "h", transactionId: "tx" }),
      (err) => err?.statusCode === 502 && /no payment tender/.test(err.message)
    );
  });

  it("409 when Square payment is not COMPLETED", async () => {
    const { svc } = buildService({
      ddb: makeFakeDdb({
        getResponses: [
          {
            Item: {
              status: "PENDING",
              reservationId: "r1",
              eventDate: "2026-05-20",
              expiresAt: FIXED_NOW + 60,
            },
          },
        ],
      }),
      paymentResponses: [
        {
          squareEnv: "sandbox",
          payment: { id: "pay_1", status: "PENDING", amount_money: { amount: 100 } },
        },
      ],
    });
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "h", transactionId: "tx" }),
      (err) => err?.statusCode === 409 && /not completed/.test(err.message)
    );
  });
});

describe("completeHandoff happy path", () => {
  it("dispatches addReservationPayment with method=square source=square-stand + provider metadata", async () => {
    const { svc, ddb, addPaymentCalls } = buildService({
      ddb: makeFakeDdb({
        getResponses: [
          {
            Item: {
              status: "PENDING",
              reservationId: "r1",
              eventDate: "2026-05-20",
              amount: 75,
              expiresAt: FIXED_NOW + 60,
              note: "deposit",
            },
          },
        ],
      }),
    });

    const res = await svc.completeHandoff({
      reservationId: "r1",
      handoffId: "h",
      transactionId: "tx_1",
      actor: "staff@x",
    });

    assert.equal(addPaymentCalls.length, 1);
    const call = addPaymentCalls[0];
    assert.equal(call.reservationId, "r1");
    assert.equal(call.payload.method, "square");
    assert.equal(call.payload.source, "square-stand");
    assert.equal(call.payload.amount, 75);
    assert.equal(call.payload.provider.providerPaymentId, "pay_1");
    assert.equal(call.payload.provider.providerStatus, "COMPLETED");
    assert.equal(call.payload.provider.receiptUrl, "https://square/r/pay_1");
    assert.equal(call.payload.provider.orderId, "ord_1");
    assert.equal(call.actor, "staff@x");
    assert.equal(res.square.paymentId, "pay_1");
    assert.equal(res.square.env, "sandbox");

    // Verifies the CONSUMED status update fires AFTER addReservationPayment
    // succeeds — so an addReservationPayment failure leaves the handoff
    // PENDING and a retry is possible.
    const updates = ddb.calls.filter((c) => c.name === "UpdateCommand");
    assert.equal(updates.length, 1);
    assert.match(updates[0].input.UpdateExpression, /#status = :consumed/);
  });
});

// ---------------------------------------------------------------------------
// cancelHandoff
// ---------------------------------------------------------------------------

describe("cancelHandoff", () => {
  it("happy path: PENDING → CANCELLED", async () => {
    const { svc, ddb } = buildService();
    const res = await svc.cancelHandoff({
      handoffId: "h",
      reason: "staff_changed_mind",
      actor: "staff@x",
    });
    assert.equal(res.handoffId, "h");
    assert.equal(res.cancelled, true);
    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.ok(update);
    assert.match(update.input.ConditionExpression, /#status = :pending/);
    assert.match(update.input.UpdateExpression, /#status = :cancelled/);
    assert.equal(
      update.input.ExpressionAttributeValues[":reason"],
      "staff_changed_mind"
    );
  });

  it("returns cancelled:false when row is already CONSUMED (ConditionalCheckFailed)", async () => {
    const ccfe = new Error("ccfe");
    ccfe.name = "ConditionalCheckFailedException";
    const { svc } = buildService({
      ddb: makeFakeDdb({ throwOnCommand: { UpdateCommand: ccfe } }),
    });
    const res = await svc.cancelHandoff({ handoffId: "h" });
    assert.equal(res.cancelled, false);
  });

  it("400 on missing handoffId", async () => {
    const { svc } = buildService();
    await assert.rejects(
      () => svc.cancelHandoff({ handoffId: "" }),
      (err) => err?.statusCode === 400 && /handoffId/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// completeHandoff — auto-refund after addReservationPayment failure (audit
// finding #1). Mirrors autoRefundAfterRecordFailure in routes-reservations-
// holds.mjs so a Stand charge can never be orphaned at Square without a
// reservation record AND without an automatic refund attempt.
// ---------------------------------------------------------------------------

function pendingHandoffItem(overrides = {}) {
  return {
    status: "PENDING",
    reservationId: "r1",
    eventDate: "2026-05-20",
    amount: 75,
    expiresAt: FIXED_NOW + 60,
    note: "deposit",
    ...overrides,
  };
}

describe("completeHandoff auto-refund (record-failure path)", () => {
  it("auto-refunds when addReservationPayment throws 409 (CCFE), surfaces 409 with refund id", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: pendingHandoffItem() }],
    });
    const ccfe = new Error("Reservation changed concurrently — refresh and try again.");
    ccfe.statusCode = 409;
    const { svc, refundCalls, historyCalls } = buildService({
      ddb,
      addReservationPayment: async () => {
        throw ccfe;
      },
    });
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "h", transactionId: "tx_1" }),
      (err) =>
        err?.statusCode === 409 &&
        /refunded automatically/i.test(err.message) &&
        /refund_pay_1/.test(err.message)
    );
    assert.equal(refundCalls.length, 1);
    assert.equal(refundCalls[0].paymentId, "pay_1");
    assert.equal(refundCalls[0].amount, 75);
    assert.equal(refundCalls[0].idempotencyKey, "auto-refund-pay_1");
    const refundedHistory = historyCalls.find(
      (h) => h.eventType === "AUTO_REFUND_AFTER_RECORD_FAILURE"
    );
    assert.ok(refundedHistory, "expected AUTO_REFUND_AFTER_RECORD_FAILURE history entry");
    assert.equal(refundedHistory.details.integration, "square-stand");
  });

  it("surfaces 502 with manual-reconciliation hint when BOTH addReservationPayment AND refund fail", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: pendingHandoffItem() }],
    });
    const recordErr = new Error("amount cannot exceed remaining balance");
    recordErr.statusCode = 400;
    const refundErr = new Error("Square refund failed (502): UPSTREAM_TIMEOUT");
    const { svc, refundCalls, historyCalls } = buildService({
      ddb,
      addReservationPayment: async () => {
        throw recordErr;
      },
      refundSquarePayment: async () => {
        throw refundErr;
      },
    });
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "h", transactionId: "tx_1" }),
      (err) =>
        err?.statusCode === 502 &&
        /manual reconciliation required/i.test(err.message) &&
        /pay_1/.test(err.message)
    );
    assert.equal(refundCalls.length, 1);
    const failedHistory = historyCalls.find(
      (h) => h.eventType === "AUTO_REFUND_FAILED"
    );
    assert.ok(failedHistory, "expected AUTO_REFUND_FAILED history entry");
    assert.equal(failedHistory.details.integration, "square-stand");
  });

  it("falls back to 502 without refund when refundSquarePayment is not wired (defensive)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: pendingHandoffItem() }],
    });
    const recordErr = new Error("Reservation is already fully paid");
    recordErr.statusCode = 400;
    const { svc, refundCalls } = buildService({
      ddb,
      skipRefundService: true,
      addReservationPayment: async () => {
        throw recordErr;
      },
    });
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "h", transactionId: "tx_1" }),
      (err) =>
        err?.statusCode === 502 && /manual reconciliation/i.test(err.message)
    );
    assert.equal(refundCalls.length, 0);
  });

  it("does NOT auto-refund on the happy path", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: pendingHandoffItem() }],
    });
    const { svc, refundCalls, addPaymentCalls } = buildService({ ddb });
    await svc.completeHandoff({ handoffId: "h", transactionId: "tx_1" });
    assert.equal(addPaymentCalls.length, 1);
    assert.equal(refundCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// completeHandoff — captured-vs-handoff amount cap (audit finding #2).
// Square POS captures whatever amount its local settings produce (tipping
// + auto-gratuity etc.). If that exceeds our handoff.amount, we treat it
// as a seller-side misconfiguration and auto-refund the WHOLE payment.
// ---------------------------------------------------------------------------

describe("completeHandoff captured-amount cap", () => {
  it("auto-refunds + 409 when Square captured more than handoff.amount (tipping inflation)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: pendingHandoffItem({ amount: 50 }) }],
    });
    const { svc, refundCalls, addPaymentCalls } = buildService({
      ddb,
      // Default payment in the harness captures 75 (matches default
      // handoff amount). Override to simulate a $25 tip on a $50 deposit.
      paymentResponses: [
        {
          squareEnv: "sandbox",
          payment: {
            id: "pay_tipped",
            status: "COMPLETED",
            amount_money: { amount: 7500, currency: "USD" }, // $75 captured
            receipt_url: "https://square/r/pay_tipped",
            order_id: "ord_tipped",
            source_type: "CARD",
            idempotency_key: "idem_tipped",
          },
        },
      ],
    });
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "h", transactionId: "tx_1" }),
      (err) =>
        err?.statusCode === 409 &&
        /captured more than the deposit/i.test(err.message) &&
        /tipping/i.test(err.message)
    );
    assert.equal(refundCalls.length, 1);
    assert.equal(refundCalls[0].paymentId, "pay_tipped");
    assert.equal(refundCalls[0].amount, 75); // refund the full captured amount
    // addReservationPayment must NEVER be called when over-captured.
    assert.equal(addPaymentCalls.length, 0);
  });

  it("502 + manual-reconciliation hint when over-capture AND refund both fail", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: pendingHandoffItem({ amount: 50 }) }],
    });
    const refundErr = new Error("Square refund failed");
    const { svc, addPaymentCalls } = buildService({
      ddb,
      paymentResponses: [
        {
          squareEnv: "sandbox",
          payment: {
            id: "pay_tipped",
            status: "COMPLETED",
            amount_money: { amount: 7500, currency: "USD" },
          },
        },
      ],
      refundSquarePayment: async () => {
        throw refundErr;
      },
    });
    await assert.rejects(
      () => svc.completeHandoff({ handoffId: "h", transactionId: "tx_1" }),
      (err) =>
        err?.statusCode === 502 &&
        /Manual reconciliation required/i.test(err.message) &&
        /pay_tipped/.test(err.message)
    );
    assert.equal(addPaymentCalls.length, 0);
  });

  it("accepts $0.01 captured-vs-handoff drift as rounding tolerance", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: pendingHandoffItem({ amount: 50 }) }],
    });
    const { svc, refundCalls, addPaymentCalls } = buildService({
      ddb,
      paymentResponses: [
        {
          squareEnv: "sandbox",
          payment: {
            id: "pay_close",
            status: "COMPLETED",
            // $50.01 — one-cent drift, allowed.
            amount_money: { amount: 5001, currency: "USD" },
          },
        },
      ],
    });
    await svc.completeHandoff({ handoffId: "h", transactionId: "tx_1" });
    assert.equal(refundCalls.length, 0);
    assert.equal(addPaymentCalls.length, 1);
    assert.equal(addPaymentCalls[0].payload.amount, 50.01);
  });
});
