// Tests for routes-checkin.mjs. The check-in routes enforce the
// one-time-use scanner flow + the PAID-required gate for issuing
// passes. These are the entrypoints staff use during venue operations.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleCheckInRoute } from "./routes-checkin.mjs";

function makeCtx(overrides = {}) {
  const calls = {
    json: [],
    requireStaffOrAdmin: [],
    getBody: [],
    getUserLabel: [],
    getReservationById: [],
    issueCheckInPassForReservation: [],
    getActiveCheckInPassForReservation: [],
    getLatestCheckInPassForReservation: [],
    getPassPreviewByToken: [],
    verifyAndConsumeCheckInPass: [],
    generateGoogleWalletSaveUrl: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "GET",
      path: overrides.path ?? "/check-in/pass",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      json: (status, body, cors) => {
        calls.json.push({ status, body, cors });
        return { statusCode: status, body, cors };
      },
      getBody: overrides.getBody ?? ((event) => {
        calls.getBody.push(event);
        return overrides.body !== undefined ? overrides.body : null;
      }),
      getUserLabel:
        overrides.getUserLabel ??
        (async (event) => {
          calls.getUserLabel.push(event);
          return overrides.userLabel ?? "staff@x";
        }),
      requireStaffOrAdmin: (event) => {
        calls.requireStaffOrAdmin.push(event);
        if (overrides.requireStaffOrAdminThrows) {
          throw overrides.requireStaffOrAdminThrows;
        }
      },
      getReservationById:
        overrides.getReservationById ??
        (async (eventDate, reservationId) => {
          calls.getReservationById.push({ eventDate, reservationId });
          return overrides.reservation ?? null;
        }),
      issueCheckInPassForReservation:
        overrides.issueCheckInPassForReservation ??
        (async (args) => {
          calls.issueCheckInPassForReservation.push(args);
          return overrides.issueResult ?? { issued: true, reused: false, pass: { passId: "pass-1" } };
        }),
      getActiveCheckInPassForReservation:
        overrides.getActiveCheckInPassForReservation ??
        (async (reservationId, opts) => {
          calls.getActiveCheckInPassForReservation.push({ reservationId, opts });
          return overrides.activePass ?? null;
        }),
      getLatestCheckInPassForReservation:
        overrides.getLatestCheckInPassForReservation ??
        (async (reservationId, opts) => {
          calls.getLatestCheckInPassForReservation.push({ reservationId, opts });
          return overrides.latestPass ?? null;
        }),
      getPassPreviewByToken:
        overrides.getPassPreviewByToken ??
        (async (token) => {
          calls.getPassPreviewByToken.push(token);
          return overrides.passPreview ?? null;
        }),
      verifyAndConsumeCheckInPass:
        overrides.verifyAndConsumeCheckInPass ??
        (async (args) => {
          calls.verifyAndConsumeCheckInPass.push(args);
          return overrides.verifyResult ?? { ok: true, code: "CHECKED_IN" };
        }),
      generateGoogleWalletSaveUrl:
        overrides.generateGoogleWalletSaveUrl ??
        (async (args) => {
          calls.generateGoogleWalletSaveUrl.push(args);
          return overrides.googleWalletResult ?? {
            saveUrl: "https://pay.google.com/gp/v/save/stub-jwt",
            classId: "3388.ff-event-2026-06-13",
            objectId: "3388.res-uuid",
          };
        }),
      googleWalletEnabled:
        overrides.googleWalletEnabled ?? (() => overrides.googleWalletIsEnabled ?? true),
    },
  };
}

// ---------------------------------------------------------------------------
// Path mismatch
// ---------------------------------------------------------------------------

describe("handleCheckInRoute — path mismatch", () => {
  it("returns null when path doesn't match any check-in route", async () => {
    const { ctx } = makeCtx({ method: "POST", path: "/something/else" });
    assert.equal(await handleCheckInRoute(ctx), null);
  });

  it("returns null on PUT (no PUT handlers)", async () => {
    const { ctx } = makeCtx({ method: "PUT", path: "/check-in" });
    assert.equal(await handleCheckInRoute(ctx), null);
  });
});

// ---------------------------------------------------------------------------
// GET /check-in/pass (public, token-based preview)
// ---------------------------------------------------------------------------

describe("GET /check-in/pass (public preview)", () => {
  it("400 when token query param is missing", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/check-in/pass",
      event: { queryStringParameters: {} },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /token is required/);
    // Importantly: NO requireStaffOrAdmin (this is the public preview route)
    assert.equal(calls.requireStaffOrAdmin.length, 0);
    assert.equal(calls.getPassPreviewByToken.length, 0);
  });

  it("400 when token is whitespace-only", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/check-in/pass",
      event: { queryStringParameters: { token: "   " } },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
  });

  it("happy path: returns the pass preview (no auth required, public route)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/check-in/pass",
      event: { queryStringParameters: { token: "abc123" } },
      passPreview: { reservationId: "r1", customerName: "Alice" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.pass, { reservationId: "r1", customerName: "Alice" });
    assert.equal(calls.getPassPreviewByToken[0], "abc123");
    assert.equal(calls.requireStaffOrAdmin.length, 0, "no staff/admin gate on public route");
  });

  it("matches with trailing slash variant", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/check-in/pass/",
      event: { queryStringParameters: { token: "abc" } },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// POST /check-in or /check-in/verify (staff scanner)
// ---------------------------------------------------------------------------

describe("POST /check-in (staff scanner)", () => {
  it("calls requireStaffOrAdmin first, before any other work", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/check-in",
      requireStaffOrAdminThrows: denied,
    });
    await assert.rejects(
      () => handleCheckInRoute(ctx),
      (err) => err?.statusCode === 403
    );
    assert.equal(calls.verifyAndConsumeCheckInPass.length, 0, "no scanner work on auth fail");
    assert.equal(calls.getBody.length, 0, "body never read");
  });

  it("400 on invalid JSON body", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/check-in",
      body: null, // getBody returns null on parse fail
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Invalid JSON/);
    assert.equal(calls.verifyAndConsumeCheckInPass.length, 0);
  });

  it("happy path: dispatches with token, scannerUser, scannerDevice", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/check-in",
      body: { token: "ffr-checkin:abc123", scannerDevice: "device-1" },
      userLabel: "scanner@x",
      verifyResult: { ok: true, code: "CHECKED_IN" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.result, { ok: true, code: "CHECKED_IN" });
    assert.equal(calls.verifyAndConsumeCheckInPass.length, 1);
    assert.deepEqual(calls.verifyAndConsumeCheckInPass[0], {
      token: "ffr-checkin:abc123",
      scannerUser: "scanner@x",
      scannerDevice: "device-1",
    });
  });

  it("scannerDevice null when not provided", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/check-in",
      body: { token: "abc" },
    });
    await handleCheckInRoute(ctx);
    assert.equal(calls.verifyAndConsumeCheckInPass[0].scannerDevice, null);
  });

  it("token: extracts from `qr` field as fallback", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/check-in",
      body: { qr: "ffr-checkin:from-qr" },
    });
    await handleCheckInRoute(ctx);
    assert.equal(calls.verifyAndConsumeCheckInPass[0].token, "ffr-checkin:from-qr");
  });

  it("token: extracts from `code` field as second fallback", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/check-in",
      body: { code: "from-code" },
    });
    await handleCheckInRoute(ctx);
    assert.equal(calls.verifyAndConsumeCheckInPass[0].token, "from-code");
  });

  it("matches /check-in/verify path variant", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/check-in/verify",
      body: { token: "abc" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
  });

  it("matches with trailing slash on /check-in/", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/check-in/",
      body: { token: "abc" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// POST /reservations/{id}/check-in-pass (staff issue/reissue)
// ---------------------------------------------------------------------------

describe("POST /reservations/{id}/check-in-pass (issue)", () => {
  it("requireStaffOrAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/check-in-pass",
      requireStaffOrAdminThrows: denied,
    });
    await assert.rejects(() => handleCheckInRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.issueCheckInPassForReservation.length, 0);
  });

  it("400 on invalid JSON body", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/check-in-pass",
      body: null,
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Invalid JSON/);
  });

  it("400 on bad eventDate format", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/check-in-pass",
      body: { eventDate: "garbage" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /YYYY-MM-DD/);
  });

  it("400 when reservation status is not CONFIRMED", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/check-in-pass",
      body: { eventDate: "2026-05-09" },
      reservation: { status: "CANCELLED", paymentStatus: "REFUNDED" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /confirmed/i);
    assert.equal(calls.issueCheckInPassForReservation.length, 0);
  });

  it("400 when reservation paymentStatus is PENDING/PARTIAL/empty (PAID + COURTESY still pass)", async () => {
    for (const paymentStatus of ["PARTIAL", "PENDING", ""]) {
      const { ctx, calls } = makeCtx({
        method: "POST",
        path: "/reservations/r1/check-in-pass",
        body: { eventDate: "2026-05-09" },
        reservation: { status: "CONFIRMED", paymentStatus },
      });
      const res = await handleCheckInRoute(ctx);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.message, /paid or marked courtesy/i);
      assert.equal(calls.issueCheckInPassForReservation.length, 0);
    }
  });

  it("happy path: issues pass with reissue=false by default", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/check-in-pass",
      body: { eventDate: "2026-05-09" },
      reservation: { status: "CONFIRMED", paymentStatus: "PAID" },
      userLabel: "staff@x",
      issueResult: { issued: true, reused: false, pass: { passId: "pass-1" } },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.issued, true);
    assert.equal(calls.issueCheckInPassForReservation.length, 1);
    const args = calls.issueCheckInPassForReservation[0];
    assert.equal(args.reservation.status, "CONFIRMED");
    assert.equal(args.issuedBy, "staff@x");
    assert.equal(args.reissue, false);
  });

  it("COURTESY reservations can be issued a check-in pass", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/check-in-pass",
      body: { eventDate: "2026-05-09" },
      reservation: { status: "CONFIRMED", paymentStatus: "COURTESY" },
      issueResult: {
        issued: true,
        reused: false,
        pass: { passId: "pass-courtesy" },
      },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.issued, true);
    assert.equal(res.body.pass.passId, "pass-courtesy");
    assert.equal(calls.issueCheckInPassForReservation.length, 1);
    assert.equal(
      calls.issueCheckInPassForReservation[0].reservation.paymentStatus,
      "COURTESY"
    );
  });

  it("reissue=true when body.reissue truthy", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/check-in-pass",
      body: { eventDate: "2026-05-09", reissue: true },
      reservation: { status: "CONFIRMED", paymentStatus: "PAID" },
    });
    await handleCheckInRoute(ctx);
    assert.equal(calls.issueCheckInPassForReservation[0].reissue, true);
  });

  it("uses CONFIRMED + PAID strings case-insensitively (mixed-case from DB)", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/check-in-pass",
      body: { eventDate: "2026-05-09" },
      reservation: { status: "Confirmed", paymentStatus: "Paid" }, // mixed case
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// GET /reservations/{id}/check-in-pass (staff fetch active+latest)
// ---------------------------------------------------------------------------

describe("GET /reservations/{id}/check-in-pass (fetch)", () => {
  it("requireStaffOrAdmin first", async () => {
    const denied = Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/reservations/r1/check-in-pass",
      requireStaffOrAdminThrows: denied,
    });
    await assert.rejects(() => handleCheckInRoute(ctx), (err) => err?.statusCode === 403);
    assert.equal(calls.getActiveCheckInPassForReservation.length, 0);
  });

  it("400 on missing/bad eventDate query param", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/r1/check-in-pass",
      event: { queryStringParameters: { eventDate: "garbage" } },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /YYYY-MM-DD/);
  });

  it("400 when reservation isn't CONFIRMED + (PAID or COURTESY)", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/r1/check-in-pass",
      event: { queryStringParameters: { eventDate: "2026-05-09" } },
      reservation: { status: "CONFIRMED", paymentStatus: "PARTIAL" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /paid or marked courtesy/i);
  });

  it("GET allows COURTESY reservations", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/reservations/r1/check-in-pass",
      event: { queryStringParameters: { eventDate: "2026-05-09" } },
      reservation: { status: "CONFIRMED", paymentStatus: "COURTESY" },
      activePass: { passId: "active-courtesy", token: "tok-c" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.pass.passId, "active-courtesy");
  });

  it("happy path: returns active + latest pass (active includeToken=true, latest includeToken=false)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/reservations/r1/check-in-pass",
      event: { queryStringParameters: { eventDate: "2026-05-09" } },
      reservation: { status: "CONFIRMED", paymentStatus: "PAID" },
      activePass: { passId: "active-1", token: "tok" },
      latestPass: { passId: "latest-1" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.issued, false);
    assert.equal(res.body.reused, false);
    assert.equal(res.body.pass.passId, "active-1");
    assert.equal(res.body.latestPass.passId, "latest-1");

    // Active pass call: includeToken=true (so staff can re-display the QR)
    assert.equal(
      calls.getActiveCheckInPassForReservation[0].opts.includeToken,
      true
    );
    // Latest pass call: includeToken=false (history view doesn't need the token)
    assert.equal(
      calls.getLatestCheckInPassForReservation[0].opts.includeToken,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// POST /reservations/{id}/google-wallet-pass (staff)
// ---------------------------------------------------------------------------

describe("POST /reservations/{id}/google-wallet-pass — staff", () => {
  it("400 when eventDate is missing or malformed", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/google-wallet-pass",
      body: { eventDate: "not-a-date" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /eventDate must be YYYY-MM-DD/);
  });

  it("501 when Google Wallet is not configured", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/google-wallet-pass",
      body: { eventDate: "2026-06-13" },
      googleWalletIsEnabled: false,
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 501);
    assert.equal(res.body.code, "GOOGLE_WALLET_NOT_CONFIGURED");
  });

  it("400 when reservation is not CONFIRMED", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/google-wallet-pass",
      body: { eventDate: "2026-06-13" },
      reservation: { status: "CANCELLED", paymentStatus: "PAID" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Only confirmed/);
  });

  it("400 when paymentStatus is PENDING (ineligible)", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/google-wallet-pass",
      body: { eventDate: "2026-06-13" },
      reservation: { status: "CONFIRMED", paymentStatus: "PENDING" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /paid or marked courtesy/i);
  });

  it("happy path: PAID returns saveUrl + objectId + classId", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/google-wallet-pass",
      body: { eventDate: "2026-06-13" },
      reservation: {
        reservationId: "r1",
        eventDate: "2026-06-13",
        status: "CONFIRMED",
        paymentStatus: "PAID",
        customerName: "Alice",
        confirmationCode: "ABC123",
        tableIds: ["1"],
      },
      activePass: { passId: "p1", token: "abcdef" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.body.saveUrl,
      "https://pay.google.com/gp/v/save/stub-jwt"
    );
    assert.equal(calls.generateGoogleWalletSaveUrl.length, 1);
  });

  it("happy path: COURTESY is accepted (eligibility helper)", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/google-wallet-pass",
      body: { eventDate: "2026-06-13" },
      reservation: {
        reservationId: "r1",
        eventDate: "2026-06-13",
        status: "CONFIRMED",
        paymentStatus: "COURTESY",
        tableIds: ["1"],
      },
      activePass: { passId: "p1", token: "tok" },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.saveUrl.startsWith("https://pay.google.com/"));
  });

  it("auto-issues a pass when no active pass exists yet", async () => {
    const { ctx, calls } = makeCtx({
      method: "POST",
      path: "/reservations/r1/google-wallet-pass",
      body: { eventDate: "2026-06-13" },
      reservation: {
        reservationId: "r1",
        eventDate: "2026-06-13",
        status: "CONFIRMED",
        paymentStatus: "PAID",
        tableIds: ["1"],
      },
      activePass: null,
      issueResult: {
        issued: true,
        pass: { passId: "freshly-issued", token: "tok" },
      },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.issueCheckInPassForReservation.length, 1);
    assert.equal(calls.generateGoogleWalletSaveUrl.length, 1);
  });

  it("404 when no pass is available + auto-issue couldn't produce a token", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/reservations/r1/google-wallet-pass",
      body: { eventDate: "2026-06-13" },
      reservation: {
        reservationId: "r1",
        eventDate: "2026-06-13",
        status: "CONFIRMED",
        paymentStatus: "PAID",
        tableIds: ["1"],
      },
      activePass: null,
      issueResult: { issued: true, pass: { passId: "no-token", token: "" } },
    });
    const res = await handleCheckInRoute(ctx);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, "PASS_NOT_READY");
  });
});
