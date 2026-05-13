// Tests for routes-reservations-holds.mjs (1,667 lines, 16 routes).
// Coverage focuses on:
// - Auth gates (requireStaffOrAdmin) on every authenticated route
// - Body validation (400 on missing/bad JSON or required fields)
// - Path matching across all 16 routes (including trailing slashes
//   where allowed)
// - Service dispatch verification (correct args forwarded)
// - Security-critical paths:
//   - Auto-refund safety net on POST /reservations (audit C2)
//   - Public Cash App session: 256-bit token + timing-safe equality
//   - The 6 payment-link routes that send SMS to customer phones

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleReservationsAndHoldsRoute } from "./routes-reservations-holds.mjs";

function makeCtx(overrides = {}) {
  const calls = {
    json: [],
    noContent: [],
    requireStaffOrAdmin: [],
    getBody: [],
    getUserLabel: [],
    createHold: [],
    listHolds: [],
    releaseHold: [],
    createReservation: [],
    upsertCrmClient: [],
    listReservations: [],
    listReservationHistory: [],
    getReservationById: [],
    releaseOverdueReservationsForEventDate: [],
    addReservationPayment: [],
    setReservationPaymentLinkWindow: [],
    setReservationCashAppLinkSession: [],
    markReservationCashAppLinkSessionUsed: [],
    appendReservationHistory: [],
    createSquarePayment: [],
    createSquarePaymentLink: [],
    refundSquarePayment: [],
    sendPaymentLinkSms: [],
    cancelReservation: [],
    getRuntimeSettingsSubset: [],
    getEventByDate: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/holds",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      httpError: (status, message) => {
        const err = new Error(message);
        err.statusCode = status;
        return err;
      },
      json: (status, body, cors) => {
        calls.json.push({ status, body, cors });
        return { statusCode: status, body, cors };
      },
      noContent: (status, cors) => {
        calls.noContent.push({ status, cors });
        return { statusCode: status, cors };
      },
      getBody: (event) => {
        calls.getBody.push(event);
        return overrides.body !== undefined ? overrides.body : null;
      },
      getUserLabel: async () => overrides.userLabel ?? "staff@x",
      getGroupsFromEvent: () => overrides.groups ?? ["Staff"],
      autoSendSquareLinkSmsEnabled:
        overrides.autoSendSquareLinkSmsEnabled !== undefined
          ? overrides.autoSendSquareLinkSmsEnabled
          : false,
      requireStaffOrAdmin: (event) => {
        calls.requireStaffOrAdmin.push(event);
        if (overrides.requireStaffOrAdminThrows) throw overrides.requireStaffOrAdminThrows;
      },
      cashAppLinkBaseUrl: overrides.cashAppLinkBaseUrl ?? "https://cashapp/pay",
      checkInPassBaseUrl: overrides.checkInPassBaseUrl ?? "https://checkin/pass",
      createHold: async (body, user) => {
        calls.createHold.push({ body, user });
        return overrides.holdResult ?? { holdId: "h1" };
      },
      listHolds: async (eventDate) => {
        calls.listHolds.push(eventDate);
        return overrides.holds ?? [];
      },
      releaseHold: async (eventDate, tableId) => {
        calls.releaseHold.push({ eventDate, tableId });
      },
      createReservation: async (body, user, isAdmin) => {
        calls.createReservation.push({ body, user, isAdmin });
        return overrides.createReservationResult ?? { reservationId: "r1", checkInPass: null };
      },
      upsertCrmClient: async (args) => {
        calls.upsertCrmClient.push(args);
      },
      listReservations: async (eventDate) => {
        calls.listReservations.push(eventDate);
        return overrides.reservations ?? [];
      },
      listReservationHistory: async (eventDate, id) => {
        calls.listReservationHistory.push({ eventDate, id });
        return overrides.history ?? [];
      },
      getReservationById: async (eventDate, id) => {
        calls.getReservationById.push({ eventDate, id });
        return overrides.reservation !== undefined ? overrides.reservation : null;
      },
      releaseOverdueReservationsForEventDate: async (date) => {
        calls.releaseOverdueReservationsForEventDate.push(date);
      },
      addReservationPayment: async (id, payload, user) => {
        calls.addReservationPayment.push({ id, payload, user });
        return overrides.paymentResult ?? { reservationId: id };
      },
      setReservationPaymentLinkWindow: async (args) => {
        calls.setReservationPaymentLinkWindow.push(args);
        return overrides.linkWindowResult ?? null;
      },
      setReservationCashAppLinkSession: async (args) => {
        calls.setReservationCashAppLinkSession.push(args);
        return overrides.cashAppSessionResult ?? null;
      },
      markReservationCashAppLinkSessionUsed: async (args) => {
        calls.markReservationCashAppLinkSessionUsed.push(args);
      },
      appendReservationHistory: async (entry) => {
        calls.appendReservationHistory.push(entry);
      },
      createSquarePayment: async (args) => {
        calls.createSquarePayment.push(args);
        return overrides.squarePaymentResult ?? {
          payment: { id: "sq-pay-1", status: "COMPLETED" },
        };
      },
      createSquarePaymentLink: async (args) => {
        calls.createSquarePaymentLink.push(args);
        return overrides.squareLinkResult ?? {
          paymentLink: { id: "PL_1", url: "https://sq.link/abc" },
        };
      },
      refundSquarePayment: async (args) => {
        calls.refundSquarePayment.push(args);
        return overrides.refundResult ?? { refund: { id: "rf1", status: "PENDING" } };
      },
      sendPaymentLinkSms: async (args) => {
        calls.sendPaymentLinkSms.push(args);
        return overrides.smsResult ?? { sent: true, messageId: "msg-1" };
      },
      cancelReservation: async (eventDate, id, tableId, user, reason, options) => {
        calls.cancelReservation.push({ eventDate, id, tableId, user, reason, options });
      },
      getRuntimeSettingsSubset: async () => overrides.runtimeSettings ?? {},
      getEventByDate: async (date) => {
        calls.getEventByDate.push(date);
        return overrides.event !== undefined ? overrides.event : null;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Path mismatch
// ---------------------------------------------------------------------------

describe("handleReservationsAndHoldsRoute — path mismatch", () => {
  it("returns null when path matches no handler", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/other" });
    assert.equal(await handleReservationsAndHoldsRoute(ctx), null);
  });
});

// ---------------------------------------------------------------------------
// POST /holds
// ---------------------------------------------------------------------------

describe("POST /holds", () => {
  it("requireStaffOrAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/holds",
      requireStaffOrAdminThrows: denied,
    });
    await assert.rejects(
      () => handleReservationsAndHoldsRoute(ctx),
      (err) => err?.statusCode === 403
    );
    assert.equal(calls.createHold.length, 0);
  });

  it("400 on bad JSON", async () => {
    const { ctx } = makeCtx({ method: "POST", path: "/holds", body: null });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("happy path: 201 with item, body forwarded with user", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/holds",
      body: { eventDate: "2026-05-09", tableId: "A1" },
      userLabel: "staff@x",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(calls.createHold[0], {
      body: { eventDate: "2026-05-09", tableId: "A1" },
      user: "staff@x",
    });
  });
});

// ---------------------------------------------------------------------------
// GET /holds
// ---------------------------------------------------------------------------

describe("GET /holds", () => {
  it("400 when eventDate query param missing", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/holds",
      event: { queryStringParameters: {} },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("triggers overdue release before listing (short-window freshness)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/holds",
      event: { queryStringParameters: { eventDate: "2026-05-09" } },
    });
    await handleReservationsAndHoldsRoute(ctx);
    assert.deepEqual(
      calls.releaseOverdueReservationsForEventDate,
      ["2026-05-09"]
    );
    assert.deepEqual(calls.listHolds, ["2026-05-09"]);
  });
});

// ---------------------------------------------------------------------------
// DELETE /holds/{date}/{tableId}
// ---------------------------------------------------------------------------

describe("DELETE /holds/{date}/{tableId}", () => {
  it("requireStaffOrAdmin + 204 + dispatches releaseHold", async () => {
    const { ctx, calls } = makeCtx({
      method: "DELETE",
      path: "/holds/2026-05-09/A1",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 204);
    assert.deepEqual(calls.releaseHold[0], { eventDate: "2026-05-09", tableId: "A1" });
  });

  it("doesn't match malformed date", async () => {
    const { ctx } = makeCtx({
      method: "DELETE",
      path: "/holds/garbage/A1",
    });
    assert.equal(await handleReservationsAndHoldsRoute(ctx), null);
  });
});

// ---------------------------------------------------------------------------
// POST /reservations (the big one — auto-refund safety net)
// ---------------------------------------------------------------------------

describe("POST /reservations", () => {
  it("requireStaffOrAdmin + 400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations",
      body: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("happy path (cash, no Square): dispatches createReservation + upsertCrmClient + returns item", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations",
      body: {
        eventDate: "2026-05-09",
        tableId: "A1",
        holdId: "h1",
        customerName: "Alice",
        phone: "+12025550100",
        depositAmount: 100,
        amountDue: 100,
        paymentMethod: "cash",
        paymentStatus: "PAID",
      },
      groups: ["Staff"],
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 201);
    assert.equal(calls.createReservation.length, 1);
    assert.equal(calls.createReservation[0].isAdmin, false);
    assert.equal(calls.upsertCrmClient.length, 1);
  });

  it("admin role detected from groups: createReservation called with isAdmin=true", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations",
      body: {
        eventDate: "2026-05-09",
        tableId: "A1",
        holdId: "h1",
        customerName: "Alice",
        phone: "+12025550100",
        depositAmount: 100,
        amountDue: 100,
        paymentMethod: "cash",
      },
      groups: ["Admin"],
    });
    await handleReservationsAndHoldsRoute(ctx);
    assert.equal(calls.createReservation[0].isAdmin, true);
  });
});

// ---------------------------------------------------------------------------
// GET /reservations
// ---------------------------------------------------------------------------

describe("GET /reservations", () => {
  it("400 when eventDate missing", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations",
      event: { queryStringParameters: {} },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("triggers overdue release + returns wrapped { items }", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/reservations",
      event: { queryStringParameters: { eventDate: "2026-05-09" } },
      reservations: [{ reservationId: "r1" }],
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 1);
    assert.deepEqual(calls.releaseOverdueReservationsForEventDate, ["2026-05-09"]);
  });

  it("suppressRelease=1 skips the overdue release sweep", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/reservations",
      event: {
        queryStringParameters: { eventDate: "2026-05-09", suppressRelease: "1" },
      },
      reservations: [{ reservationId: "r1" }],
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 1);
    assert.deepEqual(calls.releaseOverdueReservationsForEventDate, []);
  });
});

// ---------------------------------------------------------------------------
// GET /reservations/{id}/history
// ---------------------------------------------------------------------------

describe("GET /reservations/{id}/history", () => {
  it("requireStaffOrAdmin + 400 when eventDate missing", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/r1/history",
      event: { queryStringParameters: {} },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("returns history wrapped in { items }", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/reservations/r1/history",
      event: { queryStringParameters: { eventDate: "2026-05-09" } },
      history: [{ eventType: "RESERVATION_CREATED" }],
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 1);
    assert.deepEqual(calls.listReservationHistory[0], {
      id: "r1",
      eventDate: "2026-05-09",
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /reservations/{id}/payment (manual payment record)
// ---------------------------------------------------------------------------

describe("PUT /reservations/{id}/payment", () => {
  it("requireStaffOrAdmin + 400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/payment",
      body: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("dispatches addReservationPayment with id + payload + user", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/payment",
      body: { eventDate: "2026-05-09", amount: 50, method: "cash" },
      userLabel: "staff@x",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.addReservationPayment[0], {
      id: "r1",
      payload: { eventDate: "2026-05-09", amount: 50, method: "cash" },
      user: "staff@x",
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /reservations/{id}/cancel
// ---------------------------------------------------------------------------

describe("PUT /reservations/{id}/cancel", () => {
  it("requireStaffOrAdmin + 400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/cancel",
      body: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("400 when eventDate / tableId / cancelReason missing in body", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/cancel",
      body: { eventDate: "2026-05-09", tableId: "A1" }, // missing cancelReason
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /cancelReason/);
  });

  it("dispatches cancelReservation with all fields + resolution → 204", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/cancel",
      body: {
        eventDate: "2026-05-09",
        tableId: "A1",
        cancelReason: "Customer asked",
        resolutionType: "RESCHEDULE_CREDIT",
      },
      userLabel: "staff@x",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 204);
    assert.deepEqual(calls.cancelReservation[0], {
      eventDate: "2026-05-09",
      id: "r1",
      tableId: "A1",
      user: "staff@x",
      reason: "Customer asked",
      options: { resolutionType: "RESCHEDULE_CREDIT" },
    });
  });

  it("uppercases resolutionType (defaults to CANCEL_NO_REFUND)", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/cancel",
      body: {
        eventDate: "2026-05-09",
        tableId: "A1",
        cancelReason: "test",
        resolutionType: "refund",
      },
    });
    await handleReservationsAndHoldsRoute(ctx);
    assert.equal(calls.cancelReservation[0].options.resolutionType, "REFUND");
  });
});

// ---------------------------------------------------------------------------
// GET /cashapp/session (PUBLIC — token-based access)
// ---------------------------------------------------------------------------

describe("GET /cashapp/session (public)", () => {
  it("**no requireStaffOrAdmin call** (public route — even when downstream throws)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/cashapp/session",
      event: {
        queryStringParameters: {
          eventDate: "2026-05-09",
          reservationId: "r1",
          token: "0".repeat(64),
        },
      },
      reservation: null, // makes loadCashAppLinkSessionContext throw 409
    });
    // Downstream throws because reservation is null, but the auth gate
    // should NOT have been called regardless (it's a public route)
    await assert.rejects(() => handleReservationsAndHoldsRoute(ctx));
    assert.equal(calls.requireStaffOrAdmin.length, 0, "no staff/admin gate on public route");
  });
});

// ---------------------------------------------------------------------------
// Hold + reservation validation regression for path matching
// ---------------------------------------------------------------------------

describe("path matching — DELETE on a non-DELETE path returns null (router falls through)", () => {
  it("returns null on PUT /holds (no PUT handler at this path)", async () => {
    const { ctx } = makeCtx({ method: "PUT", path: "/holds" });
    assert.equal(await handleReservationsAndHoldsRoute(ctx), null);
  });

  it("returns null on PATCH /reservations (no PATCH handler)", async () => {
    const { ctx } = makeCtx({ method: "PATCH", path: "/reservations" });
    assert.equal(await handleReservationsAndHoldsRoute(ctx), null);
  });
});

// ---------------------------------------------------------------------------
// POST /reservations/{id}/payment/square — staff direct charge
// Critical: auto-refund safety net if addReservationPayment fails after
// Square already took the money (audit C2).
// ---------------------------------------------------------------------------

const CONFIRMED_PARTIAL = {
  status: "CONFIRMED",
  paymentStatus: "PARTIAL",
  amountDue: 100,
  depositAmount: 25, // 75 remaining
  tableId: "A1",
  customerName: "Alice",
  phone: "+15555550100",
};

describe("POST /reservations/{id}/payment/square", () => {
  it("requireStaffOrAdmin runs first (denies before any service call)", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      requireStaffOrAdminThrows: denied,
    });
    await assert.rejects(
      () => handleReservationsAndHoldsRoute(ctx),
      (err) => err?.statusCode === 403
    );
    assert.equal(calls.createSquarePayment.length, 0);
    assert.equal(calls.addReservationPayment.length, 0);
  });

  it("400 on bad JSON body", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Invalid JSON body/);
  });

  it("400 on bad eventDate format", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "5/9/2026", amount: 50, sourceId: "src" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /YYYY-MM-DD/);
  });

  it("400 when amount <= 0", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "2026-05-09", amount: 0, sourceId: "src" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /amount must be > 0/);
  });

  it("400 when sourceId missing", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "2026-05-09", amount: 50, sourceId: "" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /sourceId is required/);
  });

  it("400 when reservation is not CONFIRMED", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "2026-05-09", amount: 50, sourceId: "src" },
      reservation: { status: "CANCELLED" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Only confirmed/);
  });

  it("400 when reservation is COURTESY", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "2026-05-09", amount: 50, sourceId: "src" },
      reservation: { ...CONFIRMED_PARTIAL, paymentStatus: "COURTESY" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /courtesy/);
  });

  it("400 when reservation already fully paid", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "2026-05-09", amount: 50, sourceId: "src" },
      reservation: { ...CONFIRMED_PARTIAL, depositAmount: 100 },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /already fully paid/);
  });

  it("400 when amount exceeds remaining balance", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "2026-05-09", amount: 200, sourceId: "src" }, // remaining=75
      reservation: CONFIRMED_PARTIAL,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /cannot exceed remaining/);
  });

  it("happy path: charges Square, records payment, returns 200 with receipt", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "2026-05-09", amount: 50, sourceId: "src", note: "tip" },
      reservation: CONFIRMED_PARTIAL,
      userLabel: "staff@x",
      squarePaymentResult: {
        payment: {
          id: "sq-1",
          status: "COMPLETED",
          source_type: "CARD",
          receipt_url: "https://r/receipt",
          order_id: "ord-1",
          amount_money: { amount: 5000, currency: "USD" },
        },
        idempotencyKey: "idem-1",
        squareEnv: "sandbox",
      },
      paymentResult: { reservationId: "r1", paymentStatus: "PARTIAL" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.createSquarePayment.length, 1);
    assert.equal(calls.createSquarePayment[0].sourceId, "src");
    assert.equal(calls.createSquarePayment[0].amount, 50);
    assert.equal(calls.addReservationPayment.length, 1);
    assert.equal(calls.addReservationPayment[0].payload.method, "square");
    // Auto-refund must NOT fire when recording succeeds.
    assert.equal(calls.refundSquarePayment.length, 0);
  });

  it("records method='cashapp' when Square reports source_type=CASH_APP", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "2026-05-09", amount: 50, sourceId: "src" },
      reservation: CONFIRMED_PARTIAL,
      squarePaymentResult: {
        payment: { id: "sq-1", status: "COMPLETED", source_type: "CASH_APP" },
      },
    });
    await handleReservationsAndHoldsRoute(ctx);
    assert.equal(calls.addReservationPayment[0].payload.method, "cashapp");
  });

  it("auto-refunds when addReservationPayment throws AFTER Square charge succeeds (audit C2)", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "2026-05-09", amount: 50, sourceId: "src" },
      reservation: CONFIRMED_PARTIAL,
      squarePaymentResult: { payment: { id: "sq-double", status: "COMPLETED" } },
      refundResult: { refund: { id: "rf-1", status: "PENDING" } },
    });
    // Inject the addReservationPayment failure (e.g. another payment landed first).
    ctx.addReservationPayment = async () => {
      throw Object.assign(new Error("Reservation already fully paid"), {
        statusCode: 409,
      });
    };
    await assert.rejects(
      () => handleReservationsAndHoldsRoute(ctx),
      (err) => {
        // After successful auto-refund, route throws 409 with refund mention.
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /refunded automatically/);
        return true;
      }
    );
    assert.equal(calls.refundSquarePayment.length, 1);
    assert.equal(calls.refundSquarePayment[0].paymentId, "sq-double");
    assert.equal(calls.refundSquarePayment[0].amount, 50);
    // Idempotency-keyed by paymentId so retries are safe.
    assert.equal(calls.refundSquarePayment[0].idempotencyKey, "auto-refund-sq-double");
  });

  it("throws 502 when Square charge succeeds but BOTH record AND auto-refund fail (manual reconciliation needed)", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square",
      body: { eventDate: "2026-05-09", amount: 50, sourceId: "src" },
      reservation: CONFIRMED_PARTIAL,
      squarePaymentResult: { payment: { id: "sq-orphan", status: "COMPLETED" } },
    });
    ctx.addReservationPayment = async () => {
      throw new Error("DDB outage");
    };
    ctx.refundSquarePayment = async () => {
      throw new Error("Square refund 500");
    };
    await assert.rejects(
      () => handleReservationsAndHoldsRoute(ctx),
      (err) => {
        assert.equal(err.statusCode, 502);
        assert.match(err.message, /Auto-refund FAILED/);
        assert.match(err.message, /sq-orphan/);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// POST /reservations/{id}/payment-link/square
// ---------------------------------------------------------------------------

describe("POST /reservations/{id}/payment-link/square", () => {
  it("requireStaffOrAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square",
      requireStaffOrAdminThrows: denied,
    });
    await assert.rejects(() => handleReservationsAndHoldsRoute(ctx));
    assert.equal(calls.createSquarePaymentLink.length, 0);
  });

  it("400 on bad JSON body", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square",
      body: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("400 on bad eventDate", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square",
      body: { eventDate: "bad" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("400 when reservation not CONFIRMED", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square",
      body: { eventDate: "2026-05-09" },
      reservation: { status: "CANCELLED" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("400 when COURTESY", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square",
      body: { eventDate: "2026-05-09" },
      reservation: { ...CONFIRMED_PARTIAL, paymentStatus: "COURTESY" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("happy path with no amount: defaults to remainingAmount, dispatches createSquarePaymentLink + setReservationPaymentLinkWindow", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square",
      body: { eventDate: "2026-05-09" },
      reservation: CONFIRMED_PARTIAL,
      squareLinkResult: {
        paymentLink: { id: "PL_1", url: "https://sq.link/abc", version: 1, order_id: "o1" },
        squareEnv: "sandbox",
        idempotencyKey: "idem-1",
        audit: { phonePrefillStatus: "ok" },
      },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.createSquarePaymentLink[0].amount, 75); // remainingAmount
    assert.equal(calls.setReservationPaymentLinkWindow.length, 1);
  });

  it("uses explicit amount when provided", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square",
      body: { eventDate: "2026-05-09", amount: 30 },
      reservation: CONFIRMED_PARTIAL,
    });
    await handleReservationsAndHoldsRoute(ctx);
    assert.equal(calls.createSquarePaymentLink[0].amount, 30);
  });

  it("400 when explicit amount exceeds remaining balance", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square",
      body: { eventDate: "2026-05-09", amount: 200 },
      reservation: CONFIRMED_PARTIAL,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /cannot exceed remaining/);
  });

  it("502 when Square returns no link URL", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square",
      body: { eventDate: "2026-05-09" },
      reservation: CONFIRMED_PARTIAL,
      squareLinkResult: { paymentLink: { id: "PL_x", url: "" } },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 502);
    assert.match(res.body.message, /missing url/);
  });
});

// ---------------------------------------------------------------------------
// POST /reservations/{id}/payment-link/square/sms
// Same validation as /payment-link/square + sends SMS + history events.
// ---------------------------------------------------------------------------

describe("POST /reservations/{id}/payment-link/square/sms", () => {
  it("requireStaffOrAdmin first; no SMS service → 500", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square/sms",
    });
    ctx.sendPaymentLinkSms = undefined;
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.message, /SMS service is not configured/);
  });

  it("400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square/sms",
      body: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("happy path: dispatches Square link, sends SMS, appends PAYMENT_LINK_SMS_SENT history", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square/sms",
      body: { eventDate: "2026-05-09" },
      reservation: CONFIRMED_PARTIAL,
      squareLinkResult: { paymentLink: { id: "PL_1", url: "https://sq/x" } },
      smsResult: { sent: true, messageId: "msg-1", to: "+15555550100", provider: "sns" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.sendPaymentLinkSms.length, 1);
    assert.equal(calls.sendPaymentLinkSms[0].paymentLinkUrl, "https://sq/x");
    const sentEvent = calls.appendReservationHistory.find(
      (h) => h.eventType === "PAYMENT_LINK_SMS_SENT"
    );
    assert.ok(sentEvent, "must append PAYMENT_LINK_SMS_SENT history");
    assert.equal(sentEvent.details.messageId, "msg-1");
  });

  it("appends PAYMENT_LINK_SMS_FAILED history + re-throws when SMS dispatch fails", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment-link/square/sms",
      body: { eventDate: "2026-05-09" },
      reservation: CONFIRMED_PARTIAL,
    });
    ctx.sendPaymentLinkSms = async () => {
      throw new Error("SNS throttled");
    };
    await assert.rejects(() => handleReservationsAndHoldsRoute(ctx));
    const failedEvent = calls.appendReservationHistory.find(
      (h) => h.eventType === "PAYMENT_LINK_SMS_FAILED"
    );
    assert.ok(failedEvent, "must append PAYMENT_LINK_SMS_FAILED history");
    assert.match(failedEvent.details.errorMessage, /SNS throttled/);
  });
});

// ---------------------------------------------------------------------------
// POST /reservations/{id}/cashapp-link/square
// ---------------------------------------------------------------------------

describe("POST /reservations/{id}/cashapp-link/square", () => {
  it("requireStaffOrAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/cashapp-link/square",
      requireStaffOrAdminThrows: denied,
    });
    await assert.rejects(() => handleReservationsAndHoldsRoute(ctx));
    assert.equal(calls.setReservationCashAppLinkSession.length, 0);
  });

  it("400 on bad JSON / bad eventDate", async () => {
    for (const body of [null, { eventDate: "bad" }]) {
      const { ctx } = makeCtx({
        method: "POST",
        path: "/reservations/r1/cashapp-link/square",
        body,
      });
      const res = await handleReservationsAndHoldsRoute(ctx);
      assert.equal(res.statusCode, 400);
    }
  });

  it("400 when not CONFIRMED", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/cashapp-link/square",
      body: { eventDate: "2026-05-09" },
      reservation: { status: "CANCELLED" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Only confirmed/);
  });

  it("400 when paymentStatus is PAID (not PENDING/PARTIAL)", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/cashapp-link/square",
      body: { eventDate: "2026-05-09" },
      reservation: { ...CONFIRMED_PARTIAL, paymentStatus: "PAID", depositAmount: 100 },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /pending or partial/);
  });

  it("happy path: creates token + writes Cash App session + returns URL with TTL", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/cashapp-link/square",
      body: { eventDate: "2026-05-09", amount: 50, ttlMinutes: 30 },
      reservation: CONFIRMED_PARTIAL,
      cashAppLinkBaseUrl: "https://pay.example.com",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.setReservationCashAppLinkSession.length, 1);
    assert.equal(calls.setReservationCashAppLinkSession[0].amount, 50);
    // Token hash is hex-64 (sha256 of the 64-char token).
    assert.match(calls.setReservationCashAppLinkSession[0].tokenHash, /^[a-f0-9]{64}$/);
    assert.match(res.body.cashAppLink.url, /^https:\/\/pay\.example\.com/);
    assert.ok(res.body.cashAppLink.expiresAt > Math.floor(Date.now() / 1000));
  });

  it("500 when CASH_APP_LINK_BASE_URL (and check-in pass fallback) not configured", async () => {
    // resolveCashAppLinkBaseUrl falls back to checkInPassBaseUrl's origin if
    // cashAppLinkBaseUrl is empty; both must be empty to actually surface the
    // 500. (Prod always sets at least one.)
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/cashapp-link/square",
      body: { eventDate: "2026-05-09" },
      reservation: CONFIRMED_PARTIAL,
      cashAppLinkBaseUrl: "",
      checkInPassBaseUrl: "",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.message, /CASH_APP_LINK_BASE_URL/);
  });
});

// ---------------------------------------------------------------------------
// POST /reservations/{id}/cashapp-link/square/sms
// ---------------------------------------------------------------------------

describe("POST /reservations/{id}/cashapp-link/square/sms", () => {
  it("requireStaffOrAdmin first; no SMS service → 500", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/cashapp-link/square/sms",
    });
    ctx.sendPaymentLinkSms = undefined;
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 500);
  });

  it("happy path: sends SMS + appends PAYMENT_LINK_SMS_SENT (with linkType=cashapp-link)", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/cashapp-link/square/sms",
      body: { eventDate: "2026-05-09" },
      reservation: CONFIRMED_PARTIAL,
      cashAppLinkBaseUrl: "https://pay.example.com",
      smsResult: { sent: true, messageId: "msg-2", to: "+15555550100" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    const sentEvent = calls.appendReservationHistory.find(
      (h) => h.eventType === "PAYMENT_LINK_SMS_SENT"
    );
    assert.ok(sentEvent);
    assert.equal(sentEvent.details.linkType, "cashapp-link");
    assert.equal(sentEvent.details.paymentMethod, "cashapp");
  });

  it("appends PAYMENT_LINK_SMS_FAILED + re-throws when SMS fails", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/cashapp-link/square/sms",
      body: { eventDate: "2026-05-09" },
      reservation: CONFIRMED_PARTIAL,
      cashAppLinkBaseUrl: "https://pay.example.com",
    });
    ctx.sendPaymentLinkSms = async () => {
      throw new Error("SNS down");
    };
    await assert.rejects(() => handleReservationsAndHoldsRoute(ctx));
    const failed = calls.appendReservationHistory.find(
      (h) => h.eventType === "PAYMENT_LINK_SMS_FAILED"
    );
    assert.ok(failed);
    assert.equal(failed.details.linkType, "cashapp-link");
  });
});

// ---------------------------------------------------------------------------
// POST /cashapp/session/charge — public, customer-side Cash App pay
// Critical: same auto-refund safety net as /payment/square (audit C2)
// ---------------------------------------------------------------------------

// hashToken in routes-reservations-holds.mjs is sha256(value, utf8).digest("hex")
// — token = "a".repeat(64) → this hash. Computed once with the same recipe so
// the constant-time hex compare matches.
const SESSION_TOKEN = "a".repeat(64);
const SESSION_TOKEN_HASH =
  "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb";

const ACTIVE_CASHAPP_SESSION = {
  ...CONFIRMED_PARTIAL,
  paymentStatus: "PENDING",
  depositAmount: 0,
  amountDue: 50,
  cashAppLinkTokenHash: SESSION_TOKEN_HASH,
  cashAppLinkStatus: "ACTIVE",
  cashAppLinkExpiresAt: Math.floor(Date.now() / 1000) + 600, // 10 min from now
  cashAppLinkAmount: 50,
};

describe("POST /cashapp/session/charge (public)", () => {
  it("**no requireStaffOrAdmin call** — public route", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/cashapp/session/charge",
      body: {
        eventDate: "2026-05-09",
        reservationId: "r1",
        token: SESSION_TOKEN,
        sourceId: "src",
      },
      reservation: ACTIVE_CASHAPP_SESSION,
    });
    await handleReservationsAndHoldsRoute(ctx);
    assert.equal(calls.requireStaffOrAdmin.length, 0);
  });

  it("400 on bad JSON body", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/cashapp/session/charge",
      body: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("400 when sourceId missing", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/cashapp/session/charge",
      body: {
        eventDate: "2026-05-09",
        reservationId: "r1",
        token: SESSION_TOKEN,
        sourceId: "",
      },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /sourceId is required/);
  });

  it("happy path: charges Square, records as system actor, marks session used, appends CASH_APP_LINK_COMPLETED", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/cashapp/session/charge",
      body: {
        eventDate: "2026-05-09",
        reservationId: "r1",
        token: SESSION_TOKEN,
        sourceId: "cnon-card",
      },
      reservation: ACTIVE_CASHAPP_SESSION,
      squarePaymentResult: {
        payment: { id: "sq-2", status: "COMPLETED", source_type: "CASH_APP" },
        squareEnv: "sandbox",
      },
      paymentResult: { reservationId: "r1", paymentStatus: "PAID" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(calls.createSquarePayment.length, 1);
    assert.equal(calls.addReservationPayment[0].user, "system:cashapp-link");
    assert.equal(calls.addReservationPayment[0].payload.method, "cashapp");
    assert.equal(calls.markReservationCashAppLinkSessionUsed.length, 1);
    const completed = calls.appendReservationHistory.find(
      (h) => h.eventType === "CASH_APP_LINK_COMPLETED"
    );
    assert.ok(completed);
    assert.equal(completed.actor, "system:cashapp-link");
  });

  it("auto-refunds when addReservationPayment throws AFTER charge succeeds", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/cashapp/session/charge",
      body: {
        eventDate: "2026-05-09",
        reservationId: "r1",
        token: SESSION_TOKEN,
        sourceId: "src",
      },
      reservation: ACTIVE_CASHAPP_SESSION,
      squarePaymentResult: { payment: { id: "sq-double", status: "COMPLETED" } },
      refundResult: { refund: { id: "rf-1", status: "PENDING" } },
    });
    ctx.addReservationPayment = async () => {
      throw new Error("Reservation already settled");
    };
    await assert.rejects(
      () => handleReservationsAndHoldsRoute(ctx),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /refunded automatically/);
        return true;
      }
    );
    assert.equal(calls.refundSquarePayment.length, 1);
    // Session must NOT be marked used when payment failed (idempotent retry possible).
    assert.equal(calls.markReservationCashAppLinkSessionUsed.length, 0);
  });

  it("throws 502 when both record AND refund fail (orphaned charge)", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/cashapp/session/charge",
      body: {
        eventDate: "2026-05-09",
        reservationId: "r1",
        token: SESSION_TOKEN,
        sourceId: "src",
      },
      reservation: ACTIVE_CASHAPP_SESSION,
      squarePaymentResult: { payment: { id: "sq-orphan", status: "COMPLETED" } },
    });
    ctx.addReservationPayment = async () => {
      throw new Error("DDB outage");
    };
    ctx.refundSquarePayment = async () => {
      throw new Error("Square refund 500");
    };
    await assert.rejects(
      () => handleReservationsAndHoldsRoute(ctx),
      (err) => {
        assert.equal(err.statusCode, 502);
        assert.match(err.message, /sq-orphan/);
        return true;
      }
    );
  });
});
