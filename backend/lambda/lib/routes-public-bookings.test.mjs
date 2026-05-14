// Focused tests for routes-public-bookings.mjs. Stubs are minimal —
// happy-path integration is verified via curl smoke after Lambda deploy.
// These cover the gating + validation + token-verification invariants
// that aren't easy to exercise in production without burning a Square
// payment link.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handlePublicBookingsRoute } from "./routes-public-bookings.mjs";

function makeJson() {
  const calls = [];
  return {
    calls,
    json: (statusCode, body, headers) => {
      const result = { statusCode, body, headers };
      calls.push(result);
      return result;
    },
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

const NOOP_FN = async () => null;
const FAIL_FN = (label) => async () => {
  throw new Error(`${label} called unexpectedly`);
};

const PASS_TURNSTILE = async () => ({ success: true, errorCodes: [] });
const FAIL_TURNSTILE = async () => ({
  success: false,
  errorCodes: ["timeout-or-duplicate"],
});

const ALWAYS_VALID_TOKEN = (_res, t) => Boolean(t);
const NEVER_VALID_TOKEN = () => false;

function baseCtx({
  json,
  settings,
  bodyOverride,
  pathOverride,
  methodOverride,
  queryOverride,
  acquireSlot,
  createHold,
  createReservation,
  createSquarePaymentLink,
  releaseHold,
  releaseSlot,
  getReservationById,
  verifyCustomerToken,
  cancelReservation,
  appendReservationHistory,
  verifyTurnstileToken,
  loadTurnstileSecret,
  getEventByDate,
}) {
  return {
    method: methodOverride ?? "POST",
    path: pathOverride ?? "/public/reservations",
    event: {
      requestContext: { http: { sourceIp: "203.0.113.5" } },
      queryStringParameters: queryOverride ?? null,
    },
    cors: {},
    json,
    httpError,
    getBody: async () => bodyOverride ?? {},
    randomUUID: () => "uuid-fixed-1",
    normalizePhoneE164: (raw) => {
      if (!raw) return "";
      if (raw === "+18557656160") return "+18557656160";
      if (raw === "garbage") return "";
      return "+1" + String(raw).replace(/\D/g, "").slice(-10);
    },
    normalizePhoneCountry: () => "US",
    getEventByDate:
      getEventByDate ??
      (async () => ({
        eventId: "evt-1",
        eventDate: "2026-05-16",
        eventName: "Saturday Night",
      })),
    getTablePriceForEvent: () => 100,
    createHold:
      createHold ??
      (async () => {
        return { holdId: "hold-1" };
      }),
    releaseHold: releaseHold ?? (async () => undefined),
    createReservation:
      createReservation ??
      (async () => ({
        reservationId: "res-1",
        checkInPass: null,
      })),
    cancelReservation: cancelReservation ?? (async () => undefined),
    createSquarePaymentLink:
      createSquarePaymentLink ??
      (async () => ({
        paymentLink: { id: "pl-1", url: "https://square/pay" },
        squareEnv: "production",
      })),
    setReservationPaymentLinkWindow: async () => undefined,
    acquireAnonBookingPhoneSlot:
      acquireSlot ??
      (async () => undefined),
    releaseAnonBookingPhoneSlot:
      releaseSlot ?? (async () => undefined),
    verifyCustomerToken: verifyCustomerToken ?? ALWAYS_VALID_TOKEN,
    verifyTurnstileToken: verifyTurnstileToken ?? PASS_TURNSTILE,
    loadTurnstileSecret:
      loadTurnstileSecret ?? (async () => "test-secret"),
    getReservationById:
      getReservationById ??
      (async () => ({
        reservationId: "res-1",
        eventDate: "2026-05-16",
        customerToken: "tok",
        paymentStatus: "PENDING",
        status: "CONFIRMED",
        amountDue: 100,
        depositAmount: 0,
        tableIds: ["12"],
        customerName: "Maria",
      })),
    walletPassEnabled: () => true,
    getActivePassForReservation: async () => ({ token: "pass-tok" }),
    issuePassForReservation: async () => ({ pass: { token: "pass-tok" } }),
    generateWalletPass: async () => ({
      filename: "ffr-res-1.pkpass",
      contentType: "application/vnd.apple.pkpass",
      pkpassBase64: "AAAA",
      byteLength: 4,
    }),
    upsertCrmClient: NOOP_FN,
    appendReservationHistory: appendReservationHistory ?? NOOP_FN,
    getAppSettings: async () =>
      settings ?? {
        allowAnonymousPublicBooking: true,
        anonymousMaxTablesPerBooking: 4,
        anonymousHoldTtlSeconds: 600,
        turnstileSiteKey: "0x4AAAA",
        operatingTz: "America/Chicago",
      },
  };
}

const VALID_BODY = {
  eventDate: "2026-05-16",
  tableIds: ["12"],
  customer: { name: "Maria", phone: "+18557656160", email: "" },
  turnstileToken: "tok-abc",
};

describe("POST /public/reservations — gating + validation", () => {
  it("410 BOOKING_DISABLED when settings flag is off", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: VALID_BODY,
        settings: { allowAnonymousPublicBooking: false },
      })
    );
    assert.equal(out.statusCode, 410);
    assert.equal(out.body.code, "BOOKING_DISABLED");
  });

  it("400 on bad eventDate", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: { ...VALID_BODY, eventDate: "not-a-date" },
      })
    );
    assert.equal(out.statusCode, 400);
    assert.match(out.body.message, /eventDate/);
  });

  it("400 on empty tableIds", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({ json: j.json, bodyOverride: { ...VALID_BODY, tableIds: [] } })
    );
    assert.equal(out.statusCode, 400);
    assert.match(out.body.message, /tableIds is required/);
  });

  it("400 MAX_TABLES_EXCEEDED when over the per-booking cap", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: {
          ...VALID_BODY,
          tableIds: ["1", "2", "3", "4", "5"], // > anonymousMaxTablesPerBooking=4
        },
      })
    );
    assert.equal(out.statusCode, 400);
    assert.equal(out.body.code, "MAX_TABLES_EXCEEDED");
  });

  it("400 on duplicate tableIds", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: { ...VALID_BODY, tableIds: ["12", "12"] },
      })
    );
    assert.equal(out.statusCode, 400);
    assert.match(out.body.message, /unique/);
  });

  it("400 INVALID_PHONE on garbage phone input", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: {
          ...VALID_BODY,
          customer: { ...VALID_BODY.customer, phone: "garbage" },
        },
      })
    );
    assert.equal(out.statusCode, 400);
    assert.equal(out.body.code, "INVALID_PHONE");
  });

  it("403 TURNSTILE_FAILED when token missing + site key configured", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: { ...VALID_BODY, turnstileToken: "" },
      })
    );
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.code, "TURNSTILE_FAILED");
  });

  it("403 TURNSTILE_FAILED when verifier rejects the token", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: VALID_BODY,
        verifyTurnstileToken: FAIL_TURNSTILE,
      })
    );
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.code, "TURNSTILE_FAILED");
    assert.deepEqual(out.body.errorCodes, ["timeout-or-duplicate"]);
  });

  it("404 EVENT_NOT_FOUND when event lookup returns null", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: VALID_BODY,
        getEventByDate: async () => null,
      })
    );
    assert.equal(out.statusCode, 404);
    assert.equal(out.body.code, "EVENT_NOT_FOUND");
  });

  it("429 ACTIVE_HOLD_EXISTS when phone slot is held", async () => {
    const j = makeJson();
    const conflict = httpError(429, "An active unpaid hold exists");
    conflict.code = "ACTIVE_HOLD_EXISTS";
    conflict.details = {
      existingReservationId: "res-other",
      existingExpiresAt: 1_700_000_999,
    };
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: VALID_BODY,
        acquireSlot: async () => {
          throw conflict;
        },
      })
    );
    assert.equal(out.statusCode, 429);
    assert.equal(out.body.code, "ACTIVE_HOLD_EXISTS");
    assert.equal(out.body.existingReservationId, "res-other");
  });

  it("409 TABLE_NOT_AVAILABLE when a hold collides", async () => {
    const j = makeJson();
    let createHoldCalls = 0;
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: VALID_BODY,
        createHold: async () => {
          createHoldCalls += 1;
          throw httpError(409, "Table is already held or reserved");
        },
      })
    );
    assert.equal(out.statusCode, 409);
    assert.equal(out.body.code, "TABLE_NOT_AVAILABLE");
    assert.deepEqual(out.body.unavailableTableIds, ["12"]);
    assert.equal(createHoldCalls, 1);
  });

  it("Turnstile is skipped when site key is empty (local dev path)", async () => {
    const j = makeJson();
    let turnstileCalled = false;
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: { ...VALID_BODY, turnstileToken: "" },
        settings: {
          allowAnonymousPublicBooking: true,
          anonymousMaxTablesPerBooking: 4,
          anonymousHoldTtlSeconds: 600,
          turnstileSiteKey: "", // skip
          operatingTz: "America/Chicago",
        },
        verifyTurnstileToken: async () => {
          turnstileCalled = true;
          return { success: false, errorCodes: [] };
        },
      })
    );
    assert.equal(turnstileCalled, false);
    assert.equal(out.statusCode, 201);
  });

  it("happy path: 201 with reservationId + customerToken + paymentUrl", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: VALID_BODY,
      })
    );
    assert.equal(out.statusCode, 201);
    assert.ok(out.body.reservationId);
    assert.ok(out.body.customerToken);
    assert.equal(out.body.paymentUrl, "https://square/pay");
    assert.equal(out.body.amountDue, 100);
    assert.deepEqual(out.body.tableIds, ["12"]);
    assert.match(out.body.holdExpiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  // Locks down the /p/{slug} short URL routing — the customer-return URL
  // and the response shortUrl must point at the API host, not the SPA web
  // host, because /p is registered at API Gateway. Pointing at the web
  // host produced a 404 (SPA has no /p/:slug route) and stranded paying
  // customers — see audit finding 2.2.
  it("happy path: shortUrl uses the API host + Square sees the same redirect URL", async () => {
    const j = makeJson();
    let squareArgs = null;
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        bodyOverride: VALID_BODY,
        createSquarePaymentLink: async (args) => {
          squareArgs = args;
          return {
            paymentLink: { id: "pl-1", url: "https://square/pay" },
            squareEnv: "production",
          };
        },
      })
    );
    assert.equal(out.statusCode, 201);
    // Default shortUrlBase falls through to https://api.famosofuego.com
    // when neither publicBookingShortUrlBase nor publicBookingReturnBaseUrl
    // is supplied (test ctx doesn't set them).
    assert.match(
      out.body.shortUrl,
      /^https:\/\/api\.famosofuego\.com\/p\/[A-Za-z0-9]+$/,
      `expected shortUrl to use the API host, got ${out.body.shortUrl}`
    );
    // Square is given the same /p URL so the post-checkout redirect chains
    // server-side: api.famosofuego.com/p/{slug} → 302 → /r/{id}.
    assert.match(
      String(squareArgs?.redirectUrlOverride ?? ""),
      /^https:\/\/api\.famosofuego\.com\/p\//,
      "createSquarePaymentLink redirectUrlOverride should point at API host"
    );
    // Slug + base are forwarded to createPaymentLink so the payment_note
    // gets the "View your pass: …" line for customer recovery via the
    // Square email receipt + Cash App in-app receipt.
    assert.ok(squareArgs?.publicSlug, "publicSlug should be passed to Square");
    assert.equal(
      squareArgs?.shortUrlBase,
      "https://api.famosofuego.com",
      "shortUrlBase should be passed to Square"
    );
  });
});

describe("GET /public/reservations/{id}?t={token}", () => {
  function getCtx({ json, queryOverride, getReservationById, verifyCustomerToken }) {
    return baseCtx({
      json,
      methodOverride: "GET",
      pathOverride: "/public/reservations/res-1",
      queryOverride,
      getReservationById,
      verifyCustomerToken,
    });
  }

  it("401 INVALID_TOKEN when ?t is missing", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      getCtx({ json: j.json, queryOverride: { eventDate: "2026-05-16" } })
    );
    assert.equal(out.statusCode, 401);
    assert.equal(out.body.code, "INVALID_TOKEN");
  });

  it("400 MISSING_EVENT_DATE without eventDate query", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      getCtx({ json: j.json, queryOverride: { t: "token" } })
    );
    assert.equal(out.statusCode, 400);
    assert.equal(out.body.code, "MISSING_EVENT_DATE");
  });

  it("404 RESERVATION_NOT_FOUND when DB has no row", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      getCtx({
        json: j.json,
        queryOverride: { t: "token", eventDate: "2026-05-16" },
        getReservationById: async () => {
          throw httpError(404, "Reservation not found");
        },
      })
    );
    assert.equal(out.statusCode, 404);
    assert.equal(out.body.code, "RESERVATION_NOT_FOUND");
  });

  it("401 INVALID_TOKEN when token doesn't match", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      getCtx({
        json: j.json,
        queryOverride: { t: "wrong", eventDate: "2026-05-16" },
        verifyCustomerToken: NEVER_VALID_TOKEN,
      })
    );
    assert.equal(out.statusCode, 401);
    assert.equal(out.body.code, "INVALID_TOKEN");
  });

  it("410 RESERVATION_CANCELLED when status=CANCELLED", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      getCtx({
        json: j.json,
        queryOverride: { t: "tok", eventDate: "2026-05-16" },
        getReservationById: async () => ({
          reservationId: "res-1",
          customerToken: "tok",
          status: "CANCELLED",
          paymentStatus: "PENDING",
        }),
      })
    );
    assert.equal(out.statusCode, 410);
    assert.equal(out.body.code, "RESERVATION_CANCELLED");
    // Frontend branches on paymentStatus to differentiate auto-release
    // (PENDING) from paid-but-cancelled (PAID/PARTIAL/COURTESY).
    assert.equal(out.body.reservation.paymentStatus, "PENDING");
    // customerContact null when settings doesn't have a contact phone.
    assert.equal(out.body.customerContact, null);
  });

  it("410 paid-but-cancelled exposes paymentStatus so /r can show recovery copy", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        methodOverride: "GET",
        pathOverride: "/public/reservations/res-1",
        queryOverride: { t: "tok", eventDate: "2026-05-16" },
        settings: {
          allowAnonymousPublicBooking: true,
          customerContactPhoneE164: "+19561234567",
        },
        getReservationById: async () => ({
          reservationId: "res-1",
          customerToken: "tok",
          status: "CANCELLED",
          paymentStatus: "PAID",
        }),
      })
    );
    assert.equal(out.statusCode, 410);
    assert.equal(out.body.reservation.paymentStatus, "PAID");
    assert.deepEqual(out.body.customerContact, { phone: "+19561234567" });
  });

  it("200 happy path returns sanitized reservation", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      getCtx({
        json: j.json,
        queryOverride: { t: "tok", eventDate: "2026-05-16" },
      })
    );
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.reservation.reservationId, "res-1");
    assert.equal(out.body.reservation.eventName, "Saturday Night");
    assert.equal(out.body.reservation.tablesLabel, "Table 12");
    assert.equal(out.body.reservation.paymentStatus, "PENDING");
    // customerContact field is included (null when settings doesn't carry it).
    assert.equal("customerContact" in out.body, true);
    assert.equal(out.body.customerContact, null);
  });

  it("200 includes customerContact when settings has customerContactPhoneE164", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      baseCtx({
        json: j.json,
        methodOverride: "GET",
        pathOverride: "/public/reservations/res-1",
        queryOverride: { t: "tok", eventDate: "2026-05-16" },
        settings: {
          allowAnonymousPublicBooking: true,
          customerContactPhoneE164: "+19561234567",
        },
      })
    );
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body.customerContact, { phone: "+19561234567" });
  });
});

describe("POST /public/reservations/{id}/release?t={token}", () => {
  function releaseCtx({
    json,
    queryOverride,
    bodyOverride,
    getReservationById,
    verifyCustomerToken,
    cancelReservation,
  }) {
    return baseCtx({
      json,
      methodOverride: "POST",
      pathOverride: "/public/reservations/res-1/release",
      queryOverride,
      bodyOverride,
      getReservationById,
      verifyCustomerToken,
      cancelReservation,
    });
  }

  it("401 when token missing", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      releaseCtx({
        json: j.json,
        queryOverride: {},
        bodyOverride: { eventDate: "2026-05-16" },
      })
    );
    assert.equal(out.statusCode, 401);
  });

  it("409 ALREADY_PAID when reservation is PAID", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      releaseCtx({
        json: j.json,
        queryOverride: { t: "tok" },
        bodyOverride: { eventDate: "2026-05-16" },
        getReservationById: async () => ({
          reservationId: "res-1",
          customerToken: "tok",
          paymentStatus: "PAID",
          status: "CONFIRMED",
        }),
      })
    );
    assert.equal(out.statusCode, 409);
    assert.equal(out.body.code, "ALREADY_PAID");
  });

  it("idempotent 200 when reservation already cancelled", async () => {
    const j = makeJson();
    let cancelCalled = false;
    const out = await handlePublicBookingsRoute(
      releaseCtx({
        json: j.json,
        queryOverride: { t: "tok" },
        bodyOverride: { eventDate: "2026-05-16" },
        getReservationById: async () => ({
          reservationId: "res-1",
          customerToken: "tok",
          paymentStatus: "PENDING",
          status: "CANCELLED",
        }),
        cancelReservation: async () => {
          cancelCalled = true;
        },
      })
    );
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.alreadyCancelled, true);
    assert.equal(cancelCalled, false);
  });

  it("happy path: 200 + cancelReservation called with positional args + anonymous-public actor", async () => {
    const j = makeJson();
    let cancelArgs = null;
    const out = await handlePublicBookingsRoute(
      releaseCtx({
        json: j.json,
        queryOverride: { t: "tok" },
        bodyOverride: { eventDate: "2026-05-16" },
        // Mirror the real positional signature in services-reservations.mjs:
        // cancelReservation(eventDate, reservationId, tableId, user, reason, options).
        // Earlier the mock used object-arg, which masked a real bug — the
        // route was calling with object-arg + the real function would 400.
        cancelReservation: async (
          eventDate,
          reservationId,
          tableId,
          user,
          reason,
          options
        ) => {
          cancelArgs = { eventDate, reservationId, tableId, user, reason, options };
        },
      })
    );
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.released, true);
    assert.equal(cancelArgs?.eventDate, "2026-05-16");
    assert.equal(cancelArgs?.reservationId, "res-1");
    assert.equal(cancelArgs?.tableId, null);
    assert.equal(cancelArgs?.user, "anonymous-public");
    assert.equal(cancelArgs?.reason, "Released by customer");
    assert.equal(cancelArgs?.options?.resolutionType, "CANCEL_NO_REFUND");
  });
});

describe("POST /public/reservations/{id}/wallet-pass?t={token}", () => {
  function walletCtx(overrides = {}) {
    return baseCtx({
      ...overrides,
      methodOverride: "POST",
      pathOverride: "/public/reservations/res-1/wallet-pass",
    });
  }

  it("401 when token missing", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      walletCtx({
        json: j.json,
        queryOverride: {},
        bodyOverride: { eventDate: "2026-05-16" },
      })
    );
    assert.equal(out.statusCode, 401);
  });

  it("400 RESERVATION_NOT_PAID for unpaid reservation", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      walletCtx({
        json: j.json,
        queryOverride: { t: "tok" },
        bodyOverride: { eventDate: "2026-05-16" },
        getReservationById: async () => ({
          reservationId: "res-1",
          customerToken: "tok",
          status: "CONFIRMED",
          paymentStatus: "PENDING",
        }),
      })
    );
    assert.equal(out.statusCode, 400);
    assert.equal(out.body.code, "RESERVATION_NOT_PAID");
  });

  it("happy path: 200 with pkpassBase64", async () => {
    const j = makeJson();
    const out = await handlePublicBookingsRoute(
      walletCtx({
        json: j.json,
        queryOverride: { t: "tok" },
        bodyOverride: { eventDate: "2026-05-16" },
        getReservationById: async () => ({
          reservationId: "res-1",
          customerToken: "tok",
          status: "CONFIRMED",
          paymentStatus: "PAID",
        }),
      })
    );
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.contentType, "application/vnd.apple.pkpass");
    assert.equal(out.body.pkpassBase64, "AAAA");
  });
});
