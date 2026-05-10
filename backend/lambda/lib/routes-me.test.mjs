// Tests for routes-me.mjs (customer self-service router). All 3
// endpoints require requireCustomerOwnership (defense-in-depth on
// top of the API Gateway customer authorizer).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleMeRoute } from "./routes-me.mjs";

const SUB = "cognito-sub-12345";

function makeCtx(overrides = {}) {
  const calls = {
    json: [],
    requireCustomerOwnership: [],
    getProfile: [],
    listReservations: [],
    deleteAccount: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/me/profile",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      json: (status, body, cors) => {
        calls.json.push({ status, body, cors });
        return { statusCode: status, body, cors };
      },
      requireCustomerOwnership: (event) => {
        calls.requireCustomerOwnership.push(event);
        if (overrides.requireOwnershipThrows) throw overrides.requireOwnershipThrows;
        return overrides.sub ?? SUB;
      },
      getProfile: async (sub) => {
        calls.getProfile.push(sub);
        return overrides.profile ?? { sub, phone: "+12025550100" };
      },
      listReservations: async (sub) => {
        calls.listReservations.push(sub);
        return overrides.reservations ?? [];
      },
      deleteAccount: async (sub) => {
        calls.deleteAccount.push(sub);
        return overrides.deleteResult ?? { deleted: true };
      },
    },
  };
}

describe("handleMeRoute — path mismatch", () => {
  it("returns null when path doesn't match", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/other" });
    assert.equal(await handleMeRoute(ctx), null);
  });
  it("returns null on POST /me/profile (no POST handler)", async () => {
    const { ctx } = makeCtx({ method: "POST", path: "/me/profile" });
    assert.equal(await handleMeRoute(ctx), null);
  });
});

describe("GET /me/profile", () => {
  it("requires customer ownership before fetching profile", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/me/profile",
      requireOwnershipThrows: denied,
    });
    await assert.rejects(() => handleMeRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.getProfile.length, 0);
  });
  it("happy path: returns profile for resolved sub", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/me/profile",
      profile: { sub: SUB, phone: "+12025550100", crm: { totalSpend: 100 } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.sub, SUB);
    assert.equal(res.body.crm.totalSpend, 100);
    assert.equal(calls.getProfile[0], SUB);
  });
});

describe("GET /me/reservations", () => {
  it("requires customer ownership", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/me/reservations",
      requireOwnershipThrows: denied,
    });
    await assert.rejects(() => handleMeRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.listReservations.length, 0);
  });
  it("returns wrapped { items } shape", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/me/reservations",
      reservations: [{ reservationId: "r1" }, { reservationId: "r2" }],
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 2);
    assert.equal(calls.listReservations[0], SUB);
  });
});

describe("DELETE /me", () => {
  it("requires customer ownership", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "DELETE",
      path: "/me",
      requireOwnershipThrows: denied,
    });
    await assert.rejects(() => handleMeRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.deleteAccount.length, 0);
  });
  it("happy path: returns delete result", async () => {
    const { ctx, calls } = makeCtx({
      method: "DELETE",
      path: "/me",
      deleteResult: { deleted: true, alreadyGone: false },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deleted, true);
    assert.equal(calls.deleteAccount[0], SUB);
  });
});

// ===========================================================================
// Customer self-service: holds, reservations, payment, cancel, pass, credits,
// push-tokens, wallet-pass scaffold.
//
// Uses a fuller ctx fixture that injects every service dep the new routes
// touch, defaulting each to a no-op spy so tests only override what matters
// for the assertion at hand.
// ===========================================================================

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function makeFullCtx(overrides = {}) {
  const calls = {
    json: [],
    requireCustomerOwnership: [],
    getProfile: [],
    listReservations: [],
    deleteAccount: [],
    getReservationById: [],
    createHold: [],
    createReservation: [],
    cancelReservation: [],
    rescheduleReservationForCustomer: [],
    getActivePassForReservation: [],
    createSquarePayment: [],
    createSquarePaymentLink: [],
    setReservationPaymentLinkWindow: [],
    addReservationPayment: [],
    refundSquarePayment: [],
    appendReservationHistory: [],
    listCreditsForCustomer: [],
    registerPushToken: [],
    unregisterPushToken: [],
    checkAndIncrementCustomerHoldRateLimit: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      json: (status, body, cors) => {
        calls.json.push({ status, body, cors });
        return { statusCode: status, body, cors };
      },
      noContent: (status, cors) => ({ statusCode: status, body: null, cors }),
      httpError,
      getBody: (event) => event?.body ?? null,
      requireCustomerOwnership: (event) => {
        calls.requireCustomerOwnership.push(event);
        if (overrides.requireOwnershipThrows) throw overrides.requireOwnershipThrows;
        return overrides.sub ?? SUB;
      },
      getProfile: async (sub) => {
        calls.getProfile.push(sub);
        if (overrides.getProfileThrows) throw overrides.getProfileThrows;
        return overrides.profile ?? { sub, name: "Alice", phone: "+12025550100" };
      },
      deleteAccount: async (sub) => {
        calls.deleteAccount.push(sub);
        return { deleted: true };
      },
      listReservations: async (sub) => {
        calls.listReservations.push(sub);
        return [];
      },
      getReservationById: async (eventDate, reservationId) => {
        calls.getReservationById.push({ eventDate, reservationId });
        return overrides.reservation === undefined
          ? null
          : overrides.reservation;
      },
      createHold: async (payload, user) => {
        calls.createHold.push({ payload, user });
        return overrides.holdResult ?? {
          holdId: "hold-1",
          ...payload,
          createdBy: user,
        };
      },
      createReservation: async (payload, user, isAdmin) => {
        calls.createReservation.push({ payload, user, isAdmin });
        if (overrides.createReservationThrows) throw overrides.createReservationThrows;
        return overrides.createReservationResult ?? {
          reservationId: "res-1",
          ...payload,
        };
      },
      cancelReservation: async (eventDate, reservationId, tableId, user, reason, options) => {
        calls.cancelReservation.push({
          eventDate, reservationId, tableId, user, reason, options,
        });
        return overrides.cancelReservationResult ?? {
          reservationId,
          status: "CANCELLED",
        };
      },
      rescheduleReservationForCustomer:
        overrides.rescheduleReservationForCustomer === null
          ? undefined
          : overrides.rescheduleReservationForCustomer ??
            (async (payload) => {
              calls.rescheduleReservationForCustomer.push(payload);
              if (overrides.rescheduleThrows) throw overrides.rescheduleThrows;
              return (
                overrides.rescheduleResult ?? {
                  newReservation: {
                    reservationId: "res-new",
                    eventDate: payload.newEventDate,
                    tableId: payload.newTableId,
                    paymentStatus: "PAID",
                  },
                  cancelled: {
                    reservationId: payload.originalReservationId,
                    eventDate: payload.originalEventDate,
                  },
                  creditIssued: { creditId: "cr-1", amountTotal: 50 },
                  appliedCredit: {
                    creditId: "cr-1",
                    amountApplied: 50,
                    creditRemainingAfter: 0,
                    applied: true,
                    errorMessage: null,
                  },
                }
              );
            }),
      getActivePassForReservation: async (reservationId, opts) => {
        calls.getActivePassForReservation.push({ reservationId, opts });
        return overrides.activePass === undefined ? null : overrides.activePass;
      },
      createSquarePayment: async (args) => {
        calls.createSquarePayment.push(args);
        if (overrides.createSquarePaymentThrows) throw overrides.createSquarePaymentThrows;
        return overrides.squarePaymentResult ?? {
          payment: {
            id: "sq-pay-1",
            status: "COMPLETED",
            source_type: "WALLET",
            receipt_url: "https://sqr/r",
          },
        };
      },
      createSquarePaymentLink:
        overrides.createSquarePaymentLink === null
          ? undefined
          : overrides.createSquarePaymentLink ??
            (async (args) => {
              calls.createSquarePaymentLink.push(args);
              if (overrides.createSquarePaymentLinkThrows) {
                throw overrides.createSquarePaymentLinkThrows;
              }
              return (
                overrides.squarePaymentLinkResult ?? {
                  paymentLink: {
                    id: "plnk-1",
                    url: "https://checkout.square.site/plnk-1",
                  },
                }
              );
            }),
      setReservationPaymentLinkWindow: async (args) => {
        calls.setReservationPaymentLinkWindow.push(args);
        return overrides.reservationAfterLink ?? null;
      },
      addReservationPayment: async (reservationId, body, user) => {
        calls.addReservationPayment.push({ reservationId, body, user });
        if (overrides.addReservationPaymentThrows) {
          throw overrides.addReservationPaymentThrows;
        }
        return overrides.updatedReservation ?? {
          reservationId,
          paymentStatus: "PAID",
        };
      },
      refundSquarePayment: async (args) => {
        calls.refundSquarePayment.push(args);
        if (overrides.refundSquarePaymentThrows) {
          throw overrides.refundSquarePaymentThrows;
        }
        return { refund: { id: "rf-1", status: "PENDING" } };
      },
      appendReservationHistory: async (entry) => {
        calls.appendReservationHistory.push(entry);
      },
      listCreditsForCustomer: async (sub) => {
        calls.listCreditsForCustomer.push(sub);
        return overrides.creditsResult ?? { items: [], totalRemaining: 0 };
      },
      registerPushToken: async (sub, token, platform) => {
        calls.registerPushToken.push({ sub, token, platform });
        return { registered: true, tokenHash: "abc", platform };
      },
      unregisterPushToken: async (sub, token) => {
        calls.unregisterPushToken.push({ sub, token });
        return { unregistered: true, tokenHash: "abc" };
      },
      checkAndIncrementCustomerHoldRateLimit: async (sub) => {
        calls.checkAndIncrementCustomerHoldRateLimit.push(sub);
        if (overrides.rateLimitThrows) throw overrides.rateLimitThrows;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// POST /me/holds
// ---------------------------------------------------------------------------

describe("POST /me/holds", () => {
  it("400 on bad eventDate", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/holds",
      event: { body: { eventDate: "not-a-date", tableId: "T1" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("400 on missing tableId", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/holds",
      event: { body: { eventDate: "2026-05-09" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("invokes rate limit + tags hold with sub + actor=customer:{sub}", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/holds",
      event: { body: { eventDate: "2026-05-09", tableId: "T1" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 201);
    assert.equal(calls.checkAndIncrementCustomerHoldRateLimit[0], SUB);
    assert.equal(calls.createHold[0].payload.customerCognitoSub, SUB);
    assert.equal(calls.createHold[0].user, `customer:${SUB}`);
    assert.equal(res.body.ttlSeconds, 600);
  });

  it("propagates 429 from rate limit", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/holds",
      event: { body: { eventDate: "2026-05-09", tableId: "T1" } },
      rateLimitThrows: httpError(429, "too many"),
    });
    await assert.rejects(
      () => handleMeRoute(ctx),
      (err) => err?.statusCode === 429
    );
  });

  it("soft-fails getProfile failure (hold can still be created)", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/holds",
      event: { body: { eventDate: "2026-05-09", tableId: "T1" } },
      getProfileThrows: new Error("cognito blip"),
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 201);
    assert.equal(calls.createHold[0].payload.customerName, null);
    assert.equal(calls.createHold[0].payload.phone, null);
  });
});

// ---------------------------------------------------------------------------
// POST /me/reservations
// ---------------------------------------------------------------------------

describe("POST /me/reservations", () => {
  it("400 on missing required body fields", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations",
      event: { body: {} },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("409 when Cognito profile has no phone", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations",
      event: {
        body: {
          eventDate: "2026-05-09",
          tableId: "T1",
          holdId: "h1",
          customerName: "Alice",
        },
      },
      profile: { sub: SUB, name: "Alice", phone: null },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 409);
  });

  it("happy path: forwards customerCognitoSub + customer: actor + isAdmin=false", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations",
      event: {
        body: {
          eventDate: "2026-05-09",
          tableId: "T1",
          holdId: "h1",
          customerName: "Alice",
        },
      },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 201);
    const recorded = calls.createReservation[0];
    assert.equal(recorded.payload.customerCognitoSub, SUB);
    assert.equal(recorded.payload.phone, "+12025550100");
    assert.equal(recorded.user, `customer:${SUB}`);
    assert.equal(recorded.isAdmin, false);
  });
});

// ---------------------------------------------------------------------------
// POST /me/reservations/{id}/payment/square
// ---------------------------------------------------------------------------

describe("POST /me/reservations/{id}/payment/square", () => {
  const baseBody = {
    eventDate: "2026-05-09",
    sourceId: "cnon-xyz",
    amount: 50,
    idempotencyKey: "idem-1",
  };
  const baseReservation = {
    reservationId: "r1",
    customerCognitoSub: SUB,
    status: "CONFIRMED",
    paymentStatus: "PENDING",
    amountDue: 100,
    depositAmount: 0,
  };

  it("404 when reservation missing", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment/square",
      event: { body: baseBody },
      reservation: null,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 404);
  });

  it("403 when reservation belongs to a different sub", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment/square",
      event: { body: baseBody },
      reservation: { ...baseReservation, customerCognitoSub: "other-sub" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 403);
  });

  it("409 when reservation is already PAID", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment/square",
      event: { body: baseBody },
      reservation: { ...baseReservation, paymentStatus: "PAID" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 409);
  });

  it("400 when amount > remaining", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment/square",
      event: { body: { ...baseBody, amount: 999 } },
      reservation: baseReservation,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("happy path: charges Square + records payment + returns reservation", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment/square",
      event: { body: baseBody },
      reservation: baseReservation,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.square.paymentId, "sq-pay-1");
    assert.equal(calls.createSquarePayment[0].sourceId, "cnon-xyz");
    assert.equal(calls.addReservationPayment[0].body.method, "square");
    // The customer route does NOT set an explicit source — the actor
    // ("customer:{sub}") tracks who initiated; payment.source is a fixed
    // enum constrained to manual|square-direct|square-webhook|reschedule-credit.
    // addReservationPayment auto-defaults to "square-direct" for non-webhook
    // square payments, so the route must not pass an invalid value.
    assert.equal(calls.addReservationPayment[0].body.source, undefined);
  });

  it("auto-refunds on addReservationPayment failure (audit C2)", async () => {
    const recordErr = new Error("Reservation already settled");
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment/square",
      event: { body: baseBody },
      reservation: baseReservation,
      addReservationPaymentThrows: recordErr,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.refund.refunded, true);
    assert.equal(calls.refundSquarePayment.length, 1);
    assert.equal(
      calls.refundSquarePayment[0].idempotencyKey,
      "auto-refund-sq-pay-1"
    );
    const histEntry = calls.appendReservationHistory.find(
      (h) => h.eventType === "AUTO_REFUND_AFTER_RECORD_FAILURE"
    );
    assert.ok(histEntry, "auto-refund history entry written");
    assert.equal(histEntry.source, "customer");
  });

  it("emits AUTO_REFUND_FAILED history when refund itself fails", async () => {
    const recordErr = new Error("record error");
    const refundErr = new Error("refund error");
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment/square",
      event: { body: baseBody },
      reservation: baseReservation,
      addReservationPaymentThrows: recordErr,
      refundSquarePaymentThrows: refundErr,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.refund.refunded, false);
    const histEntry = calls.appendReservationHistory.find(
      (h) => h.eventType === "AUTO_REFUND_FAILED"
    );
    assert.ok(histEntry);
  });
});

// ---------------------------------------------------------------------------
// POST /me/reservations/{id}/reschedule
// ---------------------------------------------------------------------------

describe("POST /me/reservations/{id}/reschedule", () => {
  const validBody = {
    originalEventDate: "2026-06-01",
    newEventDate: "2026-06-15",
    newTableId: "T7",
    newHoldId: "hold-new-1",
    customerName: "Alice",
    newPaymentDeadlineAt: "2026-06-16T05:00:00",
    newPaymentDeadlineTz: "UTC",
    reason: "Switching dates",
  };

  it("400 when originalEventDate is invalid", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r-old/reschedule",
      event: { body: { ...validBody, originalEventDate: "not-a-date" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /originalEventDate/);
  });

  it("400 when newEventDate is invalid", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r-old/reschedule",
      event: { body: { ...validBody, newEventDate: "" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /newEventDate/);
  });

  it("400 when newTableId is missing", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r-old/reschedule",
      event: { body: { ...validBody, newTableId: "" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /newTableId/);
  });

  it("400 when newHoldId is missing", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r-old/reschedule",
      event: { body: { ...validBody, newHoldId: "" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /newHoldId/);
  });

  it("400 when customerName is missing", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r-old/reschedule",
      event: { body: { ...validBody, customerName: "" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /customerName/);
  });

  it("503 when service is not wired", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r-old/reschedule",
      event: { body: validBody },
      rescheduleReservationForCustomer: null,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 503);
  });

  it("requires customer ownership before doing anything", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r-old/reschedule",
      event: { body: validBody },
      requireOwnershipThrows: denied,
    });
    await assert.rejects(() => handleMeRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.rescheduleReservationForCustomer.length, 0);
  });

  it("happy path: forwards body + sub + actor + 24h policy and returns 201", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r-old/reschedule",
      event: { body: validBody },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 201);

    assert.equal(calls.rescheduleReservationForCustomer.length, 1);
    const recorded = calls.rescheduleReservationForCustomer[0];
    assert.equal(recorded.originalEventDate, validBody.originalEventDate);
    assert.equal(recorded.originalReservationId, "r-old");
    assert.equal(recorded.newEventDate, validBody.newEventDate);
    assert.equal(recorded.newTableId, validBody.newTableId);
    assert.equal(recorded.newHoldId, validBody.newHoldId);
    assert.equal(recorded.newCustomerName, validBody.customerName);
    assert.equal(recorded.newPaymentDeadlineAt, validBody.newPaymentDeadlineAt);
    assert.equal(recorded.newPaymentDeadlineTz, validBody.newPaymentDeadlineTz);
    assert.equal(recorded.customerCognitoSub, SUB);
    assert.equal(recorded.actor, `customer:${SUB}`);
    assert.equal(recorded.hoursBefore, 24);
    assert.equal(recorded.reason, validBody.reason);

    assert.equal(res.body.newReservation.reservationId, "res-new");
    assert.equal(res.body.appliedCredit.applied, true);
  });

  it("uses default reason when body omits one", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r-old/reschedule",
      event: { body: { ...validBody, reason: "" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 201);
    assert.equal(
      calls.rescheduleReservationForCustomer[0].reason,
      "Customer rescheduled via mobile app"
    );
  });

  it("propagates 502 when service partially fails (cancel succeeded, create failed)", async () => {
    const partialFail = Object.assign(
      new Error("Reschedule could not complete: hold expired. Your previous reservation has been cancelled..."),
      { statusCode: 502 }
    );
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r-old/reschedule",
      event: { body: validBody },
      rescheduleThrows: partialFail,
    });
    await assert.rejects(() => handleMeRoute(ctx), (err) => err?.statusCode === 502);
  });
});

// ---------------------------------------------------------------------------
// PUT /me/reservations/{id}/cancel
// ---------------------------------------------------------------------------

describe("PUT /me/reservations/{id}/cancel", () => {
  const farFutureDate = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30);
    return d.toISOString().slice(0, 10);
  })();
  const yesterdayDate = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const baseReservation = {
    reservationId: "r1",
    customerCognitoSub: SUB,
    status: "CONFIRMED",
    tableId: "T1",
  };

  it("404 when reservation missing", async () => {
    const { ctx } = makeFullCtx({
      method: "PUT",
      path: "/me/reservations/r1/cancel",
      event: { body: { eventDate: farFutureDate } },
      reservation: null,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 404);
  });

  it("403 when reservation belongs to a different sub", async () => {
    const { ctx } = makeFullCtx({
      method: "PUT",
      path: "/me/reservations/r1/cancel",
      event: { body: { eventDate: farFutureDate } },
      reservation: { ...baseReservation, customerCognitoSub: "other-sub" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 403);
  });

  it("409 when reservation status is not CONFIRMED", async () => {
    const { ctx } = makeFullCtx({
      method: "PUT",
      path: "/me/reservations/r1/cancel",
      event: { body: { eventDate: farFutureDate } },
      reservation: { ...baseReservation, status: "CANCELLED" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 409);
  });

  it("409 when event already passed (deadline missed)", async () => {
    const { ctx } = makeFullCtx({
      method: "PUT",
      path: "/me/reservations/r1/cancel",
      event: { body: { eventDate: yesterdayDate } },
      reservation: baseReservation,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.policyHours, 24);
  });

  it("happy path: forces RESCHEDULE_CREDIT + customer: actor", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "PUT",
      path: "/me/reservations/r1/cancel",
      event: { body: { eventDate: farFutureDate, reason: "Plans changed" } },
      reservation: baseReservation,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    const recorded = calls.cancelReservation[0];
    assert.equal(recorded.options.resolutionType, "RESCHEDULE_CREDIT");
    assert.equal(recorded.user, `customer:${SUB}`);
    assert.equal(recorded.reason, "Plans changed");
    assert.equal(recorded.tableId, "T1");
  });

  it("uses default reason when body omits one", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "PUT",
      path: "/me/reservations/r1/cancel",
      event: { body: { eventDate: farFutureDate } },
      reservation: baseReservation,
    });
    await handleMeRoute(ctx);
    assert.match(
      calls.cancelReservation[0].reason,
      /Customer cancelled via mobile app/
    );
  });
});

// ---------------------------------------------------------------------------
// GET /me/reservations/{id}/check-in-pass
// ---------------------------------------------------------------------------

describe("GET /me/reservations/{id}/check-in-pass", () => {
  const baseReservation = {
    reservationId: "r1",
    customerCognitoSub: SUB,
    status: "CONFIRMED",
  };

  it("400 when eventDate query param is missing", async () => {
    const { ctx } = makeFullCtx({
      method: "GET",
      path: "/me/reservations/r1/check-in-pass",
      event: { queryStringParameters: {} },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("403 when reservation belongs to a different sub", async () => {
    const { ctx } = makeFullCtx({
      method: "GET",
      path: "/me/reservations/r1/check-in-pass",
      event: { queryStringParameters: { eventDate: "2026-05-09" } },
      reservation: { ...baseReservation, customerCognitoSub: "other" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 403);
  });

  it("404 PASS_NOT_READY when reservation is owned but no active pass", async () => {
    const { ctx } = makeFullCtx({
      method: "GET",
      path: "/me/reservations/r1/check-in-pass",
      event: { queryStringParameters: { eventDate: "2026-05-09" } },
      reservation: baseReservation,
      activePass: null,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, "PASS_NOT_READY");
  });

  it("happy path: returns the active pass with token", async () => {
    const pass = { passId: "p1", token: "t1", qr: "data:..." };
    const { ctx } = makeFullCtx({
      method: "GET",
      path: "/me/reservations/r1/check-in-pass",
      event: { queryStringParameters: { eventDate: "2026-05-09" } },
      reservation: baseReservation,
      activePass: pass,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.pass.passId, "p1");
  });
});

// ---------------------------------------------------------------------------
// POST /me/reservations/{id}/wallet-pass — scaffold
// ---------------------------------------------------------------------------

describe("POST /me/reservations/{id}/wallet-pass (scaffold)", () => {
  const reservation = {
    reservationId: "r1",
    customerCognitoSub: SUB,
    status: "CONFIRMED",
  };

  it("403 when reservation is not the caller's", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/wallet-pass",
      event: { body: { eventDate: "2026-05-09" } },
      reservation: { ...reservation, customerCognitoSub: "other" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 403);
  });

  it("501 WALLET_PASS_NOT_CONFIGURED for owned reservation (cert not yet provisioned)", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/wallet-pass",
      event: { body: { eventDate: "2026-05-09" } },
      reservation,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 501);
    assert.equal(res.body.code, "WALLET_PASS_NOT_CONFIGURED");
  });
});

// ---------------------------------------------------------------------------
// GET /me/credits
// ---------------------------------------------------------------------------

describe("GET /me/credits", () => {
  it("delegates to listCreditsForCustomer + returns its result verbatim", async () => {
    const credits = {
      items: [{ creditId: "c1", amountRemaining: 30 }],
      totalRemaining: 30,
    };
    const { ctx, calls } = makeFullCtx({
      method: "GET",
      path: "/me/credits",
      creditsResult: credits,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, credits);
    assert.equal(calls.listCreditsForCustomer[0], SUB);
  });
});

// ---------------------------------------------------------------------------
// POST /me/push-tokens + DELETE /me/push-tokens/{token}
// ---------------------------------------------------------------------------

describe("POST /me/push-tokens", () => {
  it("forwards token + platform to the service", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/push-tokens",
      event: {
        body: { token: "ExponentPushToken[abc]", platform: "ios" },
      },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 201);
    assert.equal(calls.registerPushToken[0].sub, SUB);
    assert.equal(calls.registerPushToken[0].token, "ExponentPushToken[abc]");
    assert.equal(calls.registerPushToken[0].platform, "ios");
  });
});

describe("DELETE /me/push-tokens/{token}", () => {
  it("URL-decodes the token from the path before calling unregister", async () => {
    const raw = "ExponentPushToken[abc/123 +xyz]";
    const encoded = encodeURIComponent(raw);
    const { ctx, calls } = makeFullCtx({
      method: "DELETE",
      path: `/me/push-tokens/${encoded}`,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.unregisterPushToken[0].sub, SUB);
    assert.equal(calls.unregisterPushToken[0].token, raw);
  });
});

// ---------------------------------------------------------------------------
// POST /me/reservations/{id}/payment-link/square
// ---------------------------------------------------------------------------

describe("POST /me/reservations/{id}/payment-link/square", () => {
  const baseBody = { eventDate: "2026-05-09" };
  const baseReservation = {
    reservationId: "r1",
    customerCognitoSub: SUB,
    status: "CONFIRMED",
    paymentStatus: "PENDING",
    amountDue: 100,
    depositAmount: 0,
    tableId: "T1",
    customerName: "Alice",
    phone: "+12025550100",
  };

  it("400 on bad eventDate", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment-link/square",
      event: { body: { eventDate: "garbage" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("404 when reservation missing", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment-link/square",
      event: { body: baseBody },
      reservation: null,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 404);
  });

  it("403 when reservation belongs to a different sub", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment-link/square",
      event: { body: baseBody },
      reservation: { ...baseReservation, customerCognitoSub: "other-sub" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 403);
  });

  it("409 when status is not CONFIRMED", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment-link/square",
      event: { body: baseBody },
      reservation: { ...baseReservation, status: "CANCELLED" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 409);
  });

  it("409 when paymentStatus is PAID", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment-link/square",
      event: { body: baseBody },
      reservation: { ...baseReservation, paymentStatus: "PAID" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 409);
  });

  it("409 when remaining balance is zero (depositAmount >= amountDue)", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment-link/square",
      event: { body: baseBody },
      reservation: { ...baseReservation, depositAmount: 100 },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 409);
  });

  it("503 when createSquarePaymentLink dep is unavailable", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment-link/square",
      event: { body: baseBody },
      reservation: baseReservation,
      createSquarePaymentLink: null,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 503);
  });

  it("502 when Square returns no URL", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment-link/square",
      event: { body: baseBody },
      reservation: baseReservation,
      squarePaymentLinkResult: { paymentLink: { id: "plnk-1", url: "" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 502);
  });

  it("happy path: returns paymentLink.url + persists window via setReservationPaymentLinkWindow", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment-link/square",
      event: { body: baseBody },
      reservation: baseReservation,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.paymentLink.url, "https://checkout.square.site/plnk-1");
    assert.equal(res.body.paymentLink.id, "plnk-1");
    assert.equal(res.body.paymentLink.amount, 100);
    assert.equal(res.body.reservation.remainingAmount, 100);
    // Square link service called with the full remaining balance + customer
    // identity from the reservation row.
    assert.equal(calls.createSquarePaymentLink[0].amount, 100);
    assert.equal(calls.createSquarePaymentLink[0].customerName, "Alice");
    // Persists the link to the reservation row.
    assert.equal(calls.setReservationPaymentLinkWindow.length, 1);
    assert.equal(calls.setReservationPaymentLinkWindow[0].paymentLinkUrl, "https://checkout.square.site/plnk-1");
    assert.equal(calls.setReservationPaymentLinkWindow[0].actor, `customer:${SUB}`);
  });

  it("uses remaining balance (amountDue - depositAmount) when reservation is PARTIAL", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/payment-link/square",
      event: { body: baseBody },
      reservation: {
        ...baseReservation,
        paymentStatus: "PARTIAL",
        depositAmount: 30,
      },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.reservation.remainingAmount, 70);
    assert.equal(calls.createSquarePaymentLink[0].amount, 70);
  });
});

// ---------------------------------------------------------------------------
// POST /me/reservations/{id}/cashapp-link/square
// Mirrors payment-link/square but with acceptedPaymentMethods set to
// cash_app_pay only — Square's hosted checkout hides Apple Pay / Google Pay /
// card and only shows the Cash App Pay button.
// ---------------------------------------------------------------------------

describe("POST /me/reservations/{id}/cashapp-link/square", () => {
  const baseBody = { eventDate: "2026-05-09" };
  const baseReservation = {
    reservationId: "r1",
    customerCognitoSub: SUB,
    status: "CONFIRMED",
    paymentStatus: "PENDING",
    amountDue: 100,
    depositAmount: 0,
    tableId: "T1",
    customerName: "Alice",
    phone: "+12025550100",
  };

  it("400 on bad eventDate", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/cashapp-link/square",
      event: { body: { eventDate: "garbage" } },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("404 when reservation missing", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/cashapp-link/square",
      event: { body: baseBody },
      reservation: null,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 404);
  });

  it("403 when reservation belongs to a different sub", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/cashapp-link/square",
      event: { body: baseBody },
      reservation: { ...baseReservation, customerCognitoSub: "other-sub" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 403);
  });

  it("409 when paymentStatus is PAID", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/cashapp-link/square",
      event: { body: baseBody },
      reservation: { ...baseReservation, paymentStatus: "PAID" },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 409);
  });

  it("503 when createSquarePaymentLink dep is unavailable", async () => {
    const { ctx } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/cashapp-link/square",
      event: { body: baseBody },
      reservation: baseReservation,
      createSquarePaymentLink: null,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 503);
  });

  it("happy path: forwards Cash App-only acceptedPaymentMethods + returns checkout URL", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/cashapp-link/square",
      event: { body: baseBody },
      reservation: baseReservation,
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.paymentLink.url, "https://checkout.square.site/plnk-1");
    assert.equal(res.body.paymentLink.amount, 100);
    // Verify the override is passed through — Apple Pay + Google Pay
    // disabled so the hosted checkout shows ONLY the Cash App button.
    const linkCall = calls.createSquarePaymentLink[0];
    assert.deepEqual(linkCall.acceptedPaymentMethods, {
      apple_pay: false,
      google_pay: false,
      cash_app_pay: true,
    });
    assert.equal(linkCall.amount, 100);
    assert.equal(linkCall.note, "Customer self-payment via Cash App");
    // Persists link to reservation row + tags actor as customer.
    assert.equal(calls.setReservationPaymentLinkWindow.length, 1);
    assert.equal(calls.setReservationPaymentLinkWindow[0].actor, `customer:${SUB}`);
  });

  it("uses remaining balance when reservation is PARTIAL", async () => {
    const { ctx, calls } = makeFullCtx({
      method: "POST",
      path: "/me/reservations/r1/cashapp-link/square",
      event: { body: baseBody },
      reservation: {
        ...baseReservation,
        paymentStatus: "PARTIAL",
        depositAmount: 25,
      },
    });
    const res = await handleMeRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.reservation.remainingAmount, 75);
    assert.equal(calls.createSquarePaymentLink[0].amount, 75);
  });
});
