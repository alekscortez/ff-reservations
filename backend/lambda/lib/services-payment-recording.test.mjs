// Tests for services-payment-recording.mjs (PR #6 / batch-7 of the audit
// refactor). Exercises every public method with a fake DocumentClient
// + a fake `shared` bag, focusing on the security-critical bits:
// - Validation surface (HTTP 400 + 404 + 409 paths)
// - Precondition gating (CONFIRMED + PENDING/PARTIAL)
// - The depositAmount CAS that prevents the audit-C3 race
// - Provider-payment dedupe (Square webhook idempotency)
// - The credit-redemption TransactWrite (both items + cancellation mapping)
// - History-write side effects + check-in pass orchestration
// - Soft-error functions that swallow CCFE and return null

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createPaymentRecordingService } from "./services-payment-recording.mjs";

const FIXED_NOW = 1_700_000_000;

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

// Fake DocumentClient. Default behavior: GetCommand returns the seeded
// reservation/credit by index, Update/TransactWrite returns Attributes
// derived from the input, and any handler can be replaced via
// `overrides.respond`. Pushing into `calls` lets each test assert
// shape + condition expressions.
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
      if (name === "UpdateCommand") {
        // Echo the input as ALL_NEW Attributes, merged with the deltas.
        const baseline = input?.ExpressionAttributeValues ?? {};
        return { Attributes: { ...baseline, _echoed: true } };
      }
      if (name === "TransactWriteCommand") {
        return {};
      }
      return {};
    },
  };
}

function defaultShared(overrides = {}) {
  const historyCalls = [];
  const checkInCalls = [];
  const smsCalls = [];
  const baseShared = {
    roundMoney: (n) => Math.round(Number(n ?? 0) * 100) / 100,
    toRescheduleCreditSk: (phone, id) => `CREDIT#PHONE#${phone}#${id}`,
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
    getRuntimeSettings: async () => ({}),
    getReservationById: async () => null,
    resolveCashReceiptNumberRequired: () => false,
    resolveDefaultPaymentDeadlineTz: () => "America/Chicago",
    resolveDefaultPaymentDeadlineHour: () => 18,
    resolveDefaultPaymentDeadlineMinute: () => 0,
    resolvePaymentLinkTtlMinutes: () => 60,
    shouldUseFrequentPaymentLinkTtl: async () => false,
    normalizeDeadlineLocalIso: (s) => (s ? String(s) : null),
    nowInTimeZoneLocalIso: () => "2026-05-09T12:00:00",
    addMinutesToLocalIso: (iso, mins) => `${iso}+${mins}m`,
    localIsoToEpochSeconds: () => FIXED_NOW + 3600,
  };
  return {
    historyCalls,
    checkInCalls,
    smsCalls,
    shared: { ...baseShared, ...overrides },
  };
}

function buildPaymentRecording(overrides = {}) {
  const ddb = overrides.ddb ?? makeFakeDdb();
  const harness = defaultShared(overrides.shared ?? {});
  const svc = createPaymentRecordingService(
    {
      ddb,
      tableNames: {
        RES_TABLE: "ff-reservations",
        CLIENTS_TABLE: "ff-clients",
      },
      requiredEnv: (n, v) => v,
      httpError,
      nowEpoch: () => FIXED_NOW,
      randomUUID: () => "fake-payment-uuid",
      addDaysToIsoDate: (date) => `${date}+1d`,
      normalizePhone: (phone) => (phone ? String(phone) : null),
    },
    harness.shared
  );
  return { ddb, svc, ...harness };
}

// ---------------------------------------------------------------------------
// setReservationPaymentLinkWindow
// ---------------------------------------------------------------------------

describe("setReservationPaymentLinkWindow validation", () => {
  it("400 on bad eventDate", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () =>
        svc.setReservationPaymentLinkWindow({
          eventDate: "garbage",
          reservationId: "r1",
          paymentLinkId: "L",
          paymentLinkUrl: "https://x",
        }),
      (err) => err?.statusCode === 400 && /YYYY-MM-DD/.test(err.message)
    );
  });

  it("400 on missing reservationId", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () =>
        svc.setReservationPaymentLinkWindow({
          eventDate: "2026-05-09",
          reservationId: "",
          paymentLinkId: "L",
          paymentLinkUrl: "https://x",
        }),
      (err) => err?.statusCode === 400
    );
  });

  it("400 on missing paymentLinkId / paymentLinkUrl", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () =>
        svc.setReservationPaymentLinkWindow({
          eventDate: "2026-05-09",
          reservationId: "r1",
          paymentLinkId: "",
          paymentLinkUrl: "https://x",
        }),
      (err) => err?.statusCode === 400
    );
  });

  it("400 when reservation is not CONFIRMED", async () => {
    const { svc } = buildPaymentRecording({
      shared: {
        getReservationById: async () => ({ status: "CANCELLED", paymentStatus: "PENDING" }),
      },
    });
    await assert.rejects(
      () =>
        svc.setReservationPaymentLinkWindow({
          eventDate: "2026-05-09",
          reservationId: "r1",
          paymentLinkId: "L",
          paymentLinkUrl: "https://x",
        }),
      (err) => err?.statusCode === 400 && /confirmed/i.test(err.message)
    );
  });

  it("400 when paymentStatus is not PENDING or PARTIAL", async () => {
    const { svc } = buildPaymentRecording({
      shared: {
        getReservationById: async () => ({ status: "CONFIRMED", paymentStatus: "PAID" }),
      },
    });
    await assert.rejects(
      () =>
        svc.setReservationPaymentLinkWindow({
          eventDate: "2026-05-09",
          reservationId: "r1",
          paymentLinkId: "L",
          paymentLinkUrl: "https://x",
        }),
      (err) => err?.statusCode === 400
    );
  });
});

describe("setReservationPaymentLinkWindow happy path", () => {
  it("issues UpdateCommand with the right condition + history append", async () => {
    const ddb = makeFakeDdb();
    const { svc, historyCalls } = buildPaymentRecording({
      ddb,
      shared: {
        getReservationById: async () => ({
          status: "CONFIRMED",
          paymentStatus: "PENDING",
          tableId: "T7",
          customerName: "Alice",
        }),
      },
    });
    await svc.setReservationPaymentLinkWindow({
      eventDate: "2026-05-09",
      reservationId: "r1",
      paymentLinkId: "PL_1",
      paymentLinkUrl: "https://sq.link/abc",
      actor: "staff@x",
    });
    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.ok(update, "UpdateCommand was sent");
    assert.equal(update.input.TableName, "ff-reservations");
    assert.equal(update.input.Key.PK, "EVENTDATE#2026-05-09");
    assert.equal(update.input.Key.SK, "RES#r1");
    assert.match(
      update.input.ConditionExpression,
      /#status = :confirmed AND \(#paymentStatus = :pending OR #paymentStatus = :partial\)/
    );
    assert.equal(update.input.ExpressionAttributeValues[":provider"], "square");
    assert.equal(update.input.ExpressionAttributeValues[":linkStatus"], "ACTIVE");
    assert.equal(
      update.input.ExpressionAttributeValues[":paymentLinkId"],
      "PL_1"
    );
    assert.equal(
      update.input.ExpressionAttributeValues[":paymentLinkUrl"],
      "https://sq.link/abc"
    );
    assert.equal(update.input.ExpressionAttributeValues[":by"], "staff@x");
    assert.equal(update.input.ExpressionAttributeValues[":now"], FIXED_NOW);

    // History should record PAYMENT_LINK_ISSUED
    assert.equal(historyCalls.length, 1);
    assert.equal(historyCalls[0].eventType, "PAYMENT_LINK_ISSUED");
    assert.equal(historyCalls[0].reservationId, "r1");
    assert.equal(historyCalls[0].details.paymentLinkId, "PL_1");
  });

  it("falls back to system actor when none is supplied", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildPaymentRecording({
      ddb,
      shared: {
        getReservationById: async () => ({
          status: "CONFIRMED",
          paymentStatus: "PENDING",
        }),
      },
    });
    await svc.setReservationPaymentLinkWindow({
      eventDate: "2026-05-09",
      reservationId: "r1",
      paymentLinkId: "PL",
      paymentLinkUrl: "https://x",
    });
    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.equal(update.input.ExpressionAttributeValues[":by"], "system");
  });
});

// ---------------------------------------------------------------------------
// markReservationPaymentLinkInactive
// ---------------------------------------------------------------------------

describe("markReservationPaymentLinkInactive", () => {
  it("returns null on bad eventDate (no DDB call)", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildPaymentRecording({ ddb });
    const out = await svc.markReservationPaymentLinkInactive({
      eventDate: "garbage",
      reservationId: "r1",
      status: "REVOKED",
    });
    assert.equal(out, null);
    assert.equal(ddb.calls.length, 0);
  });

  it("returns null when status is missing", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildPaymentRecording({ ddb });
    const out = await svc.markReservationPaymentLinkInactive({
      eventDate: "2026-05-09",
      reservationId: "r1",
      status: "",
    });
    assert.equal(out, null);
    assert.equal(ddb.calls.length, 0);
  });

  it("with a reason: SET clause keeps deactivation reason", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildPaymentRecording({ ddb });
    await svc.markReservationPaymentLinkInactive({
      eventDate: "2026-05-09",
      reservationId: "r1",
      status: "REVOKED",
      actor: "staff@x",
      reason: "Customer paid in cash",
    });
    const update = ddb.calls[0];
    assert.equal(update.name, "UpdateCommand");
    assert.match(
      update.input.UpdateExpression,
      /#paymentLinkDeactivationReason = :reason/
    );
    assert.equal(
      update.input.ExpressionAttributeValues[":reason"],
      "Customer paid in cash"
    );
    assert.equal(update.input.ExpressionAttributeValues[":status"], "REVOKED");
  });

  it("without a reason: REMOVE clause clears deactivation reason", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildPaymentRecording({ ddb });
    await svc.markReservationPaymentLinkInactive({
      eventDate: "2026-05-09",
      reservationId: "r1",
      status: "EXPIRED",
    });
    const update = ddb.calls[0];
    assert.equal(update.name, "UpdateCommand");
    assert.match(
      update.input.UpdateExpression,
      /REMOVE #paymentLinkUrl, #paymentLinkDeactivationReason/
    );
    assert.equal(update.input.ExpressionAttributeValues[":reason"], undefined);
  });

  it("uppercases status input", async () => {
    const ddb = makeFakeDdb();
    const { svc } = buildPaymentRecording({ ddb });
    await svc.markReservationPaymentLinkInactive({
      eventDate: "2026-05-09",
      reservationId: "r1",
      status: "expired",
    });
    const update = ddb.calls[0];
    assert.equal(update.input.ExpressionAttributeValues[":status"], "EXPIRED");
  });

  it("CCFE → null (silent)", async () => {
    const ccfe = new Error("not present");
    ccfe.name = "ConditionalCheckFailedException";
    const ddb = makeFakeDdb({ throwOnCommand: { UpdateCommand: ccfe } });
    const { svc } = buildPaymentRecording({ ddb });
    const out = await svc.markReservationPaymentLinkInactive({
      eventDate: "2026-05-09",
      reservationId: "r1",
      status: "REVOKED",
    });
    assert.equal(out, null);
  });
});

// ---------------------------------------------------------------------------
// addReservationPayment — input validation
// ---------------------------------------------------------------------------

describe("addReservationPayment validation", () => {
  it("400 on bad eventDate", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () => svc.addReservationPayment("r1", { eventDate: "x", amount: 10, method: "cash" }, "u"),
      (err) => err?.statusCode === 400
    );
  });

  it("400 on amount <= 0", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 0, method: "cash" },
          "u"
        ),
      (err) => err?.statusCode === 400 && /amount/.test(err.message)
    );
  });

  it("400 on bad method", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 10, method: "wire" },
          "u"
        ),
      (err) => err?.statusCode === 400 && /method/.test(err.message)
    );
  });

  it("400 on receiptNumber too long (>64)", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          {
            eventDate: "2026-05-09",
            amount: 10,
            method: "cash",
            receiptNumber: "1".repeat(65),
          },
          "u"
        ),
      (err) => err?.statusCode === 400 && /64 characters/.test(err.message)
    );
  });

  it("400 on receiptNumber containing non-digits", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          {
            eventDate: "2026-05-09",
            amount: 10,
            method: "cash",
            receiptNumber: "abc123",
          },
          "u"
        ),
      (err) => err?.statusCode === 400 && /digits/.test(err.message)
    );
  });

  it("400 on cash with required-receipt-number setting + missing receipt", async () => {
    const { svc } = buildPaymentRecording({
      shared: {
        resolveCashReceiptNumberRequired: () => true,
      },
    });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 10, method: "cash" },
          "u"
        ),
      (err) => err?.statusCode === 400 && /receiptNumber is required/.test(err.message)
    );
  });

  it("400 on credit method without creditId", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 10, method: "credit" },
          "u"
        ),
      (err) => err?.statusCode === 400 && /creditId is required/.test(err.message)
    );
  });

  it("400 on provider supplied for non-square/cashapp method", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          {
            eventDate: "2026-05-09",
            amount: 10,
            method: "cash",
            provider: { providerPaymentId: "sq_pay_xxx" },
          },
          "u"
        ),
      (err) => err?.statusCode === 400 && /provider metadata/.test(err.message)
    );
  });

  it("400 on bad source enum", async () => {
    const { svc } = buildPaymentRecording();
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 10, method: "cash", source: "weird" },
          "u"
        ),
      (err) => err?.statusCode === 400 && /source must be/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// addReservationPayment — non-credit happy paths + preconditions
// ---------------------------------------------------------------------------

describe("addReservationPayment non-credit", () => {
  function reservationItem(overrides = {}) {
    return {
      PK: "EVENTDATE#2026-05-09",
      SK: "RES#r1",
      status: "CONFIRMED",
      paymentStatus: "PENDING",
      amountDue: 100,
      depositAmount: 0,
      tableId: "T1",
      customerName: "Alice",
      payments: [],
      ...overrides,
    };
  }

  it("404 when reservation not found", async () => {
    const ddb = makeFakeDdb({ getResponses: [{ Item: null }] });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 10, method: "cash" },
          "u"
        ),
      (err) => err?.statusCode === 404
    );
  });

  it("400 when reservation not CONFIRMED", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: reservationItem({ status: "CANCELLED" }) }],
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 10, method: "cash" },
          "u"
        ),
      (err) => err?.statusCode === 400 && /confirmed/i.test(err.message)
    );
  });

  it("400 on COURTESY reservation (cannot add payments)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: reservationItem({ paymentStatus: "COURTESY" }) }],
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 10, method: "cash" },
          "u"
        ),
      (err) => err?.statusCode === 400 && /courtesy/i.test(err.message)
    );
  });

  it("400 when reservation is already fully paid", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: reservationItem({ depositAmount: 100, paymentStatus: "PAID" }) },
      ],
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 10, method: "cash" },
          "u"
        ),
      (err) => err?.statusCode === 400 && /already fully paid/i.test(err.message)
    );
  });

  it("400 when amount exceeds remaining balance", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: reservationItem({ depositAmount: 80 }) }],
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 50, method: "cash" },
          "u"
        ),
      (err) => err?.statusCode === 400 && /exceed remaining/.test(err.message)
    );
  });

  it("dedupes Square payment by providerPaymentId (returns existing item, no Update)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: reservationItem({
            payments: [
              {
                paymentId: "p1",
                amount: 50,
                method: "square",
                provider: {
                  provider: "square",
                  providerPaymentId: "sq_pay_dup",
                  idempotencyKey: null,
                },
              },
            ],
            depositAmount: 50,
            paymentStatus: "PARTIAL",
          }),
        },
      ],
    });
    const { svc } = buildPaymentRecording({ ddb });
    const out = await svc.addReservationPayment(
      "r1",
      {
        eventDate: "2026-05-09",
        amount: 30,
        method: "square",
        provider: { providerPaymentId: "sq_pay_dup" },
      },
      "system:square-webhook"
    );
    // Should bail with the existing item, no Update issued.
    assert.equal(out.depositAmount, 50);
    assert.equal(out.paymentStatus, "PARTIAL");
    const updates = ddb.calls.filter((c) => c.name === "UpdateCommand");
    assert.equal(updates.length, 0);
  });

  it("dedupes Square payment by idempotencyKey", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: reservationItem({
            payments: [
              {
                paymentId: "p1",
                amount: 25,
                method: "cashapp",
                provider: {
                  provider: "square",
                  providerPaymentId: null,
                  idempotencyKey: "idem-1",
                },
              },
            ],
            depositAmount: 25,
            paymentStatus: "PARTIAL",
          }),
        },
      ],
    });
    const { svc } = buildPaymentRecording({ ddb });
    const out = await svc.addReservationPayment(
      "r1",
      {
        eventDate: "2026-05-09",
        amount: 25,
        method: "cashapp",
        provider: { idempotencyKey: "idem-1" },
      },
      "system:square-webhook"
    );
    assert.equal(out.depositAmount, 25);
    const updates = ddb.calls.filter((c) => c.name === "UpdateCommand");
    assert.equal(updates.length, 0);
  });

  it("happy path cash → PARTIAL preserves deadline, depositAmount CAS pinned", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: reservationItem({
            depositAmount: 20,
            paymentStatus: "PARTIAL",
            paymentDeadlineAt: "2026-05-10T18:00:00",
            paymentDeadlineTz: "America/Chicago",
          }),
        },
      ],
    });
    const { svc, historyCalls } = buildPaymentRecording({ ddb });
    await svc.addReservationPayment(
      "r1",
      {
        eventDate: "2026-05-09",
        amount: 30,
        method: "cash",
        receiptNumber: "12345",
      },
      "staff@x"
    );
    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.ok(update, "UpdateCommand sent");
    // Audit C3: depositAmount must be CAS-pinned to currentPaid
    assert.match(
      update.input.ConditionExpression,
      /#status = :confirmed AND #depositAmount = :currentPaid/
    );
    assert.equal(update.input.ExpressionAttributeValues[":currentPaid"], 20);
    assert.equal(update.input.ExpressionAttributeValues[":paid"], 50);
    assert.equal(update.input.ExpressionAttributeValues[":paymentStatus"], "PARTIAL");
    // Deadline preserved on PARTIAL
    assert.equal(
      update.input.ExpressionAttributeValues[":deadline"],
      "2026-05-10T18:00:00"
    );
    // History captured
    assert.equal(historyCalls.length, 1);
    assert.equal(historyCalls[0].eventType, "PAYMENT_RECORDED");
    assert.equal(historyCalls[0].details.method, "cash");
    assert.equal(historyCalls[0].details.amount, 30);
    assert.equal(historyCalls[0].details.receiptNumber, "12345");
  });

  it("happy path cash → fully PAID clears the deadline", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        {
          Item: reservationItem({
            depositAmount: 70,
            paymentStatus: "PARTIAL",
            paymentDeadlineAt: "2026-05-10T18:00:00",
            paymentDeadlineTz: "America/Chicago",
          }),
        },
      ],
    });
    const { svc, historyCalls } = buildPaymentRecording({ ddb });
    await svc.addReservationPayment(
      "r1",
      { eventDate: "2026-05-09", amount: 30, method: "cash" },
      "staff@x"
    );
    const update = ddb.calls.find((c) => c.name === "UpdateCommand");
    assert.equal(update.input.ExpressionAttributeValues[":paymentStatus"], "PAID");
    assert.equal(update.input.ExpressionAttributeValues[":paid"], 100);
    assert.equal(update.input.ExpressionAttributeValues[":deadline"], null);
    assert.equal(update.input.ExpressionAttributeValues[":deadlineTz"], null);
    assert.equal(historyCalls[0].details.paymentStatus, "PAID");
    assert.equal(historyCalls[0].details.remainingAmount, 0);
  });

  it("CCFE on the Update → 409 (concurrent change)", async () => {
    const ccfe = new Error("conflict");
    ccfe.name = "ConditionalCheckFailedException";
    const ddb = makeFakeDdb({
      getResponses: [{ Item: reservationItem() }],
      throwOnCommand: { UpdateCommand: ccfe },
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          { eventDate: "2026-05-09", amount: 50, method: "cash" },
          "u"
        ),
      (err) => err?.statusCode === 409 && /concurrent/i.test(err.message)
    );
  });

  it("inferred source is square-webhook when actor starts with system:square-webhook", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: reservationItem() }],
    });
    const { svc, historyCalls } = buildPaymentRecording({ ddb });
    await svc.addReservationPayment(
      "r1",
      {
        eventDate: "2026-05-09",
        amount: 30,
        method: "square",
        provider: { providerPaymentId: "sq_new" },
      },
      "system:square-webhook:abc"
    );
    assert.equal(historyCalls[0].source, "square-webhook");
  });

  it("inferred source is square-direct for staff actor", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: reservationItem() }],
    });
    const { svc, historyCalls } = buildPaymentRecording({ ddb });
    await svc.addReservationPayment(
      "r1",
      {
        eventDate: "2026-05-09",
        amount: 30,
        method: "square",
      },
      "staff@x"
    );
    assert.equal(historyCalls[0].source, "square-direct");
  });

  it("accepts source=square-stand for the iPad URL-scheme handoff", async () => {
    const ddb = makeFakeDdb({
      getResponses: [{ Item: reservationItem() }],
    });
    const { svc, historyCalls } = buildPaymentRecording({ ddb });
    await svc.addReservationPayment(
      "r1",
      {
        eventDate: "2026-05-09",
        amount: 30,
        method: "square",
        source: "square-stand",
        provider: { providerPaymentId: "sq_stand_1" },
      },
      "staff@x"
    );
    assert.equal(historyCalls[0].source, "square-stand");
  });
});

// ---------------------------------------------------------------------------
// addReservationPayment — credit redemption TransactWrite
// ---------------------------------------------------------------------------

describe("addReservationPayment credit", () => {
  function reservationItem(overrides = {}) {
    return {
      PK: "EVENTDATE#2026-05-09",
      SK: "RES#r1",
      status: "CONFIRMED",
      paymentStatus: "PENDING",
      amountDue: 100,
      depositAmount: 0,
      tableId: "T1",
      customerName: "Alice",
      phone: "+12025550100",
      phoneCountry: "US",
      payments: [],
      ...overrides,
    };
  }

  function creditItem(overrides = {}) {
    return {
      PK: "CLIENT",
      SK: "CREDIT#PHONE#+12025550100#cred-1",
      entityType: "RESCHEDULE_CREDIT",
      status: "ACTIVE",
      amountRemaining: 50,
      ...overrides,
    };
  }

  it("400 when reservation has no phone (cannot resolve credit owner)", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: reservationItem({ phone: "" }) },
      ],
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          {
            eventDate: "2026-05-09",
            amount: 30,
            method: "credit",
            creditId: "cred-1",
          },
          "u"
        ),
      (err) => err?.statusCode === 400 && /valid client phone/.test(err.message)
    );
  });

  it("404 when credit not found", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: reservationItem() },
        { Item: null }, // credit lookup
      ],
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          {
            eventDate: "2026-05-09",
            amount: 30,
            method: "credit",
            creditId: "cred-1",
          },
          "u"
        ),
      (err) => err?.statusCode === 404
    );
  });

  it("409 when credit is wrong entity type", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: reservationItem() },
        { Item: creditItem({ entityType: "SOMETHING_ELSE" }) },
      ],
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          {
            eventDate: "2026-05-09",
            amount: 30,
            method: "credit",
            creditId: "cred-1",
          },
          "u"
        ),
      (err) => err?.statusCode === 409 && /credit record type/.test(err.message)
    );
  });

  it("409 when credit status isn't ACTIVE", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: reservationItem() },
        { Item: creditItem({ status: "USED" }) },
      ],
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          {
            eventDate: "2026-05-09",
            amount: 30,
            method: "credit",
            creditId: "cred-1",
          },
          "u"
        ),
      (err) => err?.statusCode === 409 && /not active/i.test(err.message)
    );
  });

  it("400 when amount exceeds credit remaining", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: reservationItem() },
        { Item: creditItem({ amountRemaining: 10 }) },
      ],
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          {
            eventDate: "2026-05-09",
            amount: 30,
            method: "credit",
            creditId: "cred-1",
          },
          "u"
        ),
      (err) => err?.statusCode === 400 && /credit remaining balance/.test(err.message)
    );
  });

  it("409 when credit is expired", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: reservationItem() },
        { Item: creditItem({ expiresAt: "2020-01-01" }) },
      ],
    });
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          {
            eventDate: "2026-05-09",
            amount: 30,
            method: "credit",
            creditId: "cred-1",
          },
          "u"
        ),
      (err) => err?.statusCode === 409 && /expired/i.test(err.message)
    );
  });

  it("happy path partial-draw → TransactWrite has both updates with right conditions", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: reservationItem() },
        { Item: creditItem({ amountRemaining: 80 }) },
      ],
    });
    const { svc, historyCalls } = buildPaymentRecording({ ddb });
    await svc.addReservationPayment(
      "r1",
      {
        eventDate: "2026-05-09",
        amount: 30,
        method: "credit",
        creditId: "cred-1",
      },
      "staff@x"
    );
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    assert.ok(txn, "TransactWriteCommand sent");
    assert.equal(txn.input.TransactItems.length, 2);

    // First item: reservation update (CAS on depositAmount)
    const resUpdate = txn.input.TransactItems[0].Update;
    assert.equal(resUpdate.TableName, "ff-reservations");
    assert.match(
      resUpdate.ConditionExpression,
      /#status = :confirmed AND #depositAmount = :currentPaid/
    );
    assert.equal(resUpdate.ExpressionAttributeValues[":currentPaid"], 0);
    assert.equal(resUpdate.ExpressionAttributeValues[":paid"], 30);
    assert.equal(resUpdate.ExpressionAttributeValues[":paymentStatus"], "PARTIAL");
    assert.equal(resUpdate.ExpressionAttributeValues[":paymentMethod"], "credit");

    // Second item: credit update (entityType + status + remaining + expires checked)
    const credUpdate = txn.input.TransactItems[1].Update;
    assert.equal(credUpdate.TableName, "ff-clients");
    assert.match(
      credUpdate.ConditionExpression,
      /#entityType = :creditType AND #status = :creditActive AND #amountRemaining >= :amount/
    );
    assert.equal(credUpdate.ExpressionAttributeValues[":amount"], 30);
    assert.equal(credUpdate.ExpressionAttributeValues[":creditRemaining"], 50);
    assert.equal(credUpdate.ExpressionAttributeValues[":creditStatus"], "ACTIVE");
    // Partial draw → REMOVE the usedAt/usedBy
    assert.match(credUpdate.UpdateExpression, /REMOVE #usedAt, #usedBy/);

    // Two history events: PAYMENT_RECORDED + RESCHEDULE_CREDIT_APPLIED
    assert.equal(historyCalls.length, 2);
    assert.equal(historyCalls[0].eventType, "PAYMENT_RECORDED");
    assert.equal(historyCalls[1].eventType, "RESCHEDULE_CREDIT_APPLIED");
    assert.equal(historyCalls[1].details.creditRemainingAmount, 50);
  });

  it("happy path full-draw → credit status flips to USED with usedAt set", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: reservationItem() },
        { Item: creditItem({ amountRemaining: 30 }) },
      ],
    });
    const { svc, historyCalls } = buildPaymentRecording({ ddb });
    await svc.addReservationPayment(
      "r1",
      {
        eventDate: "2026-05-09",
        amount: 30,
        method: "credit",
        creditId: "cred-1",
      },
      "staff@x"
    );
    const txn = ddb.calls.find((c) => c.name === "TransactWriteCommand");
    const credUpdate = txn.input.TransactItems[1].Update;
    assert.equal(credUpdate.ExpressionAttributeValues[":creditRemaining"], 0);
    assert.equal(credUpdate.ExpressionAttributeValues[":creditStatus"], "USED");
    // Full draw → SET the usedAt/usedBy
    assert.match(credUpdate.UpdateExpression, /SET .*#usedAt = :now, #usedBy = :by/);
    assert.equal(historyCalls[1].details.creditRemainingAmount, 0);
  });

  it("TransactionCanceledException with ConditionalCheckFailed → 409", async () => {
    const ddb = makeFakeDdb({
      getResponses: [
        { Item: reservationItem() },
        { Item: creditItem() },
      ],
    });
    // Throw on the TransactWrite specifically
    const txnErr = new Error("Transaction cancelled, ConditionalCheckFailed");
    txnErr.name = "TransactionCanceledException";
    ddb.send = async (cmd) => {
      const name = cmd?.constructor?.name ?? "Unknown";
      ddb.calls.push({ name, input: cmd?.input });
      if (name === "GetCommand") {
        const idx = ddb.calls.filter((c) => c.name === "GetCommand").length - 1;
        return [
          { Item: reservationItem() },
          { Item: creditItem() },
        ][idx];
      }
      if (name === "TransactWriteCommand") throw txnErr;
      return {};
    };
    const { svc } = buildPaymentRecording({ ddb });
    await assert.rejects(
      () =>
        svc.addReservationPayment(
          "r1",
          {
            eventDate: "2026-05-09",
            amount: 30,
            method: "credit",
            creditId: "cred-1",
          },
          "staff@x"
        ),
      (err) => err?.statusCode === 409 && /concurrent update/.test(err.message)
    );
  });
});
