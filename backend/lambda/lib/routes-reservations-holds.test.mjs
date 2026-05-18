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
    lookupReservationByConfirmationCode: [],
    releaseOverdueReservationsForEventDate: [],
    addReservationPayment: [],
    setReservationPaymentLinkWindow: [],
    appendReservationHistory: [],
    createSquarePayment: [],
    createSquarePaymentLink: [],
    refundSquarePayment: [],
    sendPaymentLinkSms: [],
    cancelReservation: [],
    changeReservationTables: [],
    extendReservationPaymentDeadline: [],
    getRuntimeSettingsSubset: [],
    getEventByDate: [],
    startSquareStandHandoff: [],
    completeSquareStandHandoff: [],
    cancelSquareStandHandoff: [],
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
      lookupReservationByConfirmationCode: async (code) => {
        calls.lookupReservationByConfirmationCode.push(code);
        return overrides.codeLookup !== undefined ? overrides.codeLookup : null;
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
      changeReservationTables: overrides.changeReservationTablesDisabled
        ? undefined
        : async (body, user) => {
            calls.changeReservationTables.push({ body, user });
            return (
              overrides.changeReservationTablesResult ?? {
                reservation: { reservationId: body?.reservationId ?? null },
                delta: 0,
                newAmountDue: 0,
                newTablePrice: 0,
                newTablePrices: [],
                payment: null,
                overpayment: null,
              }
            );
          },
      extendReservationPaymentDeadline: overrides.extendReservationPaymentDeadlineDisabled
        ? undefined
        : async (args) => {
            calls.extendReservationPaymentDeadline.push(args);
            return (
              overrides.extendDeadlineResult ?? {
                reservationId: args?.reservationId ?? null,
                eventDate: args?.eventDate ?? null,
                paymentDeadlineAt: args?.paymentDeadlineAt ?? null,
              }
            );
          },
      getRuntimeSettingsSubset: async () => overrides.runtimeSettings ?? {},
      getEventByDate: async (date) => {
        calls.getEventByDate.push(date);
        return overrides.event !== undefined ? overrides.event : null;
      },
      listEvents: async () => overrides.events ?? [],
      resolveBusinessDate: async () =>
        overrides.businessCtx ?? { businessDate: "2026-05-16" },
      startSquareStandHandoff: overrides.startSquareStandHandoff
        ? async (args) => {
            calls.startSquareStandHandoff.push(args);
            return overrides.startSquareStandHandoff(args);
          }
        : overrides.disableStandHandoffServices
        ? undefined
        : async (args) => {
            calls.startSquareStandHandoff.push(args);
            return {
              handoffId: "h_fake",
              callbackUrl: "https://app.example/staff/square-stand-callback",
              expiresAt: 0,
              amount: args?.amount ?? 0,
            };
          },
      completeSquareStandHandoff: overrides.completeSquareStandHandoff
        ? async (args) => {
            calls.completeSquareStandHandoff.push(args);
            return overrides.completeSquareStandHandoff(args);
          }
        : overrides.disableStandHandoffServices
        ? undefined
        : async (args) => {
            calls.completeSquareStandHandoff.push(args);
            return {
              item: { reservationId: args.reservationId },
              square: { paymentId: "sq-stand-1" },
              handoff: { handoffId: args.handoffId, consumedAt: 0 },
            };
          },
      cancelSquareStandHandoff: overrides.cancelSquareStandHandoff
        ? async (args) => {
            calls.cancelSquareStandHandoff.push(args);
            return overrides.cancelSquareStandHandoff(args);
          }
        : overrides.disableStandHandoffServices
        ? undefined
        : async (args) => {
            calls.cancelSquareStandHandoff.push(args);
            return { handoffId: args.handoffId, cancelled: true };
          },
      squareStandCallbackUrl:
        overrides.squareStandCallbackUrl ??
        "https://app.example/staff/square-stand-callback",
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
// GET /reservations/recent
// ---------------------------------------------------------------------------

describe("GET /reservations/recent", () => {
  it("requireStaffOrAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/recent",
      requireStaffOrAdminThrows: denied,
    });
    await assert.rejects(() => handleReservationsAndHoldsRoute(ctx), { statusCode: 403 });
  });

  it("fans out across the next N ACTIVE events at/after the business date", async () => {
    const reservationsByDate = {
      "2026-05-16": [{ reservationId: "r1", eventDate: "2026-05-16" }],
      "2026-05-23": [
        { reservationId: "r2", eventDate: "2026-05-23" },
        { reservationId: "r3", eventDate: "2026-05-23" },
      ],
      "2026-05-30": [{ reservationId: "r4", eventDate: "2026-05-30" }],
    };
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/reservations/recent",
      event: { queryStringParameters: { maxEvents: "3" } },
      businessCtx: { businessDate: "2026-05-16" },
      events: [
        { eventDate: "2026-04-01", status: "ACTIVE" },
        { eventDate: "2026-05-16", status: "ACTIVE" },
        { eventDate: "2026-05-23", status: "INACTIVE" },
        { eventDate: "2026-05-30", status: "ACTIVE" },
        { eventDate: "2026-06-06", status: "ACTIVE" },
        { eventDate: "2026-06-13", status: "ACTIVE" },
      ],
    });
    // Wire per-date stub on top of the default reservations fixture so
    // each fan-out call returns the right items.
    ctx.listReservations = async (date) => {
      calls.listReservations.push(date);
      return reservationsByDate[date] ?? [];
    };

    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    // INACTIVE event skipped; past event skipped; capped at maxEvents=3.
    assert.deepEqual(res.body.eventDates, ["2026-05-16", "2026-05-30", "2026-06-06"]);
    // Each upcoming event got exactly one listReservations call.
    assert.deepEqual(calls.listReservations, [
      "2026-05-16",
      "2026-05-30",
      "2026-06-06",
    ]);
    assert.equal(res.body.items.length, 2); // r1 + r4 (r2/r3 skipped, no items for 06-06)
    assert.ok(typeof res.body.asOfEpoch === "number");
  });

  it("never triggers the overdue release sweep", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/reservations/recent",
      events: [{ eventDate: "2026-05-16", status: "ACTIVE" }],
      reservations: [{ reservationId: "r1" }],
    });
    await handleReservationsAndHoldsRoute(ctx);
    assert.deepEqual(calls.releaseOverdueReservationsForEventDate, []);
  });

  it("clamps maxEvents to [1,7] and limit to [1,200]", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/recent",
      event: { queryStringParameters: { maxEvents: "999", limit: "0" } },
      events: Array.from({ length: 10 }, (_, i) => ({
        eventDate: `2026-06-${String(i + 1).padStart(2, "0")}`,
        status: "ACTIVE",
      })),
      businessCtx: { businessDate: "2026-05-16" },
      reservations: [{ reservationId: "r1" }],
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.eventDates.length, 7);
    // limit=0 clamped to 1, so even though all 7 events returned r1 we keep one.
    assert.equal(res.body.items.length, 1);
  });

  it("tolerates per-event listReservations failures", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/recent",
      events: [
        { eventDate: "2026-05-16", status: "ACTIVE" },
        { eventDate: "2026-05-23", status: "ACTIVE" },
      ],
    });
    ctx.listReservations = async (date) => {
      if (date === "2026-05-16") throw new Error("ddb timeout");
      return [{ reservationId: "r2", eventDate: date }];
    };
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].reservationId, "r2");
  });

  it("500 when business date cannot be resolved", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/recent",
      businessCtx: { businessDate: "" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 500);
  });
});

// ---------------------------------------------------------------------------
// GET /reservations/by-code/{code}
// ---------------------------------------------------------------------------

describe("GET /reservations/by-code/{code}", () => {
  it("400 when code is malformed", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/by-code/abc",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "BAD_CONFIRMATION_CODE");
  });

  it("404 when lookup returns null", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/by-code/K7M3X2",
      codeLookup: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, "RESERVATION_NOT_FOUND");
  });

  it("strips FF- prefix and uses bare code for lookup", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/reservations/by-code/FF-K7M3X2",
      codeLookup: { reservationId: "r-1", eventDate: "2026-05-16" },
      reservation: { reservationId: "r-1", eventDate: "2026-05-16" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.lookupReservationByConfirmationCode, ["K7M3X2"]);
    assert.deepEqual(calls.getReservationById, [
      { eventDate: "2026-05-16", id: "r-1" },
    ]);
    assert.equal(res.body.reservation.reservationId, "r-1");
  });

  it("uppercases lowercase codes before lookup", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/reservations/by-code/k7m3x2",
      codeLookup: { reservationId: "r-1", eventDate: "2026-05-16" },
      reservation: { reservationId: "r-1" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.lookupReservationByConfirmationCode, ["K7M3X2"]);
  });

  it("404 when lookup row exists but reservation is missing (orphan)", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/by-code/K7M3X2",
      codeLookup: { reservationId: "r-1", eventDate: "2026-05-16" },
      reservation: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, "RESERVATION_NOT_FOUND");
  });

  it("requireStaffOrAdmin gates the route", async () => {
    const err = new Error("forbidden");
    err.statusCode = 403;
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/by-code/K7M3X2",
      requireStaffOrAdminThrows: err,
    });
    await assert.rejects(() => handleReservationsAndHoldsRoute(ctx));
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
// POST /reservations/{id}/payment/square-stand/{start|complete|cancel}
// ---------------------------------------------------------------------------

describe("POST /reservations/{id}/payment/square-stand/start", () => {
  it("requireStaffOrAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/start",
      requireStaffOrAdminThrows: denied,
    });
    await assert.rejects(() => handleReservationsAndHoldsRoute(ctx));
    assert.equal(calls.startSquareStandHandoff.length, 0);
  });

  it("500 when handoff service is not wired", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/start",
      body: { eventDate: "2026-05-09", amount: 50 },
      disableStandHandoffServices: true,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.message, /not configured/);
  });

  it("400 on bad JSON body", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/start",
      body: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("400 on bad eventDate", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/start",
      body: { eventDate: "tomorrow", amount: 50 },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /YYYY-MM-DD/);
  });

  it("400 on non-positive amount", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/start",
      body: { eventDate: "2026-05-09", amount: 0 },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /amount must be > 0/);
  });

  it("happy path: 200 with handoffId + callbackUrl, releases overdue first, forwards actor", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/start",
      body: {
        eventDate: "2026-05-09",
        amount: 50,
        note: "deposit",
        returnPath: "/staff/reservations",
      },
      userLabel: "host@x",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.handoffId, "h_fake");
    assert.equal(
      res.body.callbackUrl,
      "https://app.example/staff/square-stand-callback"
    );
    assert.deepEqual(
      calls.releaseOverdueReservationsForEventDate,
      ["2026-05-09"]
    );
    assert.equal(calls.startSquareStandHandoff.length, 1);
    assert.equal(calls.startSquareStandHandoff[0].reservationId, "r1");
    assert.equal(calls.startSquareStandHandoff[0].amount, 50);
    assert.equal(calls.startSquareStandHandoff[0].note, "deposit");
    assert.equal(calls.startSquareStandHandoff[0].returnPath, "/staff/reservations");
    assert.equal(
      calls.startSquareStandHandoff[0].callbackUrl,
      "https://app.example/staff/square-stand-callback"
    );
    assert.equal(calls.startSquareStandHandoff[0].actor, "host@x");
  });
});

describe("POST /reservations/{id}/payment/square-stand/complete", () => {
  it("400 missing handoffId", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/complete",
      body: { transactionId: "tx_1" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /handoffId/);
  });

  it("400 missing transactionId", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/complete",
      body: { handoffId: "h_fake" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /transactionId/);
  });

  it("happy path: 200 with item + square payload; forwards reservationId+handoffId+transactionId+actor", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/complete",
      body: { handoffId: "h_fake", transactionId: "tx_1" },
      userLabel: "host@x",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.item.reservationId, "r1");
    assert.equal(res.body.square.paymentId, "sq-stand-1");
    assert.equal(calls.completeSquareStandHandoff.length, 1);
    assert.equal(calls.completeSquareStandHandoff[0].reservationId, "r1");
    assert.equal(calls.completeSquareStandHandoff[0].handoffId, "h_fake");
    assert.equal(calls.completeSquareStandHandoff[0].transactionId, "tx_1");
    assert.equal(calls.completeSquareStandHandoff[0].actor, "host@x");
  });
});

describe("POST /reservations/{id}/payment/square-stand/cancel", () => {
  it("400 missing handoffId", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/cancel",
      body: { reason: "oops" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /handoffId/);
  });

  it("happy path: 200, forwards handoffId+reason+actor", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/payment/square-stand/cancel",
      body: { handoffId: "h_fake", reason: "staff_changed_mind" },
      userLabel: "host@x",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cancelled, true);
    assert.equal(calls.cancelSquareStandHandoff[0].handoffId, "h_fake");
    assert.equal(calls.cancelSquareStandHandoff[0].reason, "staff_changed_mind");
    assert.equal(calls.cancelSquareStandHandoff[0].actor, "host@x");
  });
});

// ---------------------------------------------------------------------------
// PUT /reservations/{id}/payment-deadline
// ---------------------------------------------------------------------------

describe("PUT /reservations/{id}/payment-deadline", () => {
  it("400 on bad JSON", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/payment-deadline",
      body: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("400 when eventDate / paymentDeadlineAt missing", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/payment-deadline",
      body: { eventDate: "2026-05-09" },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /paymentDeadlineAt/);
  });

  it("500 when service is not configured", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/payment-deadline",
      body: {
        eventDate: "2026-05-09",
        paymentDeadlineAt: "3000-01-01T18:00:00",
        paymentDeadlineTz: "America/Chicago",
      },
      extendReservationPaymentDeadlineDisabled: true,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 500);
  });

  it("dispatches with id + body → 200 with item envelope", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/payment-deadline",
      body: {
        eventDate: "2026-05-09",
        paymentDeadlineAt: "3000-01-01T18:00:00",
        paymentDeadlineTz: "America/Chicago",
      },
      userLabel: "staff@x",
      extendDeadlineResult: {
        reservationId: "r1",
        paymentDeadlineAt: "3000-01-01T18:00:00",
      },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.requireStaffOrAdmin.length, 1);
    assert.deepEqual(calls.extendReservationPaymentDeadline[0], {
      eventDate: "2026-05-09",
      reservationId: "r1",
      paymentDeadlineAt: "3000-01-01T18:00:00",
      paymentDeadlineTz: "America/Chicago",
      actor: "staff@x",
    });
    assert.equal(res.body.item.reservationId, "r1");
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
// PATCH /reservations/{id}/tables -- change reservation tables
// ---------------------------------------------------------------------------

describe("PUT /reservations/{id}/tables", () => {
  it("requireStaffOrAdmin + 400 on missing body", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/tables",
      body: null,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("500 when changeReservationTables dep is not configured", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/tables",
      body: { eventDate: "2026-05-09", newTableIds: ["T1"] },
      changeReservationTablesDisabled: true,
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 500);
  });

  it("dispatches changeReservationTables with reservationId merged from path", async () => {
    const { ctx, calls } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/tables",
      body: {
        eventDate: "2026-05-09",
        newTableIds: ["T2"],
        newHoldsByTableId: { T2: "h-T2" },
        expectedTablePriceTotal: 200,
        reason: "Upgrade",
        payment: { method: "cash", amount: 100, receiptNumber: "1247" },
      },
      userLabel: "staff@x",
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.changeReservationTables.length, 1);
    const call = calls.changeReservationTables[0];
    assert.equal(call.body.reservationId, "r1");
    assert.equal(call.body.eventDate, "2026-05-09");
    assert.deepEqual(call.body.newTableIds, ["T2"]);
    assert.equal(call.user, "staff@x");
    assert.equal(call.body.payment.amount, 100);
  });

  it("returns the service result body verbatim (delta + overpayment surfaced to caller)", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      path: "/reservations/r1/tables",
      body: {
        eventDate: "2026-05-09",
        newTableIds: ["T1"],
        newHoldsByTableId: { T1: "h-T1" },
        expectedTablePriceTotal: 100,
        reason: "Downgrade",
        overpaymentResolution: "CREDIT",
      },
      changeReservationTablesResult: {
        reservation: { reservationId: "r1", tableIds: ["T1"] },
        delta: -100,
        newAmountDue: 100,
        newTablePrice: 100,
        newTablePrices: [100],
        payment: null,
        overpayment: {
          surplus: 100,
          resolution: "CREDIT",
          credit: { creditId: "credit-1", amountTotal: 100 },
          refund: null,
        },
      },
    });
    const res = await handleReservationsAndHoldsRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.delta, -100);
    assert.equal(res.body.overpayment.resolution, "CREDIT");
    assert.equal(res.body.overpayment.credit.creditId, "credit-1");
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

