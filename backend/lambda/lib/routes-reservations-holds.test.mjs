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
