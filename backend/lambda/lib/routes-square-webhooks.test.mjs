// Tests for routes-square-webhooks.mjs. The webhook receiver is the
// only public-facing route that accepts unauthenticated POST traffic
// from the internet — every guard here is a security boundary.
//
// Coverage:
// - Helper functions (getHeader case-insensitive, getRawBody base64
//   decoding, buildRequestUrl with x-forwarded headers)
// - GET /admin/square/webhook-health: requireAdmin gate
// - POST /webhooks/square: missing body 400, missing/invalid
//   signature 403, invalid JSON 400, valid signature dispatches to
//   processSquareWebhookEvent
// - Path mismatch returns null (router falls through)

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildRequestUrl,
  getHeader,
  getRawBody,
  handleSquareWebhookRoute,
} from "./routes-square-webhooks.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("getHeader", () => {
  it("matches headers case-insensitively", () => {
    const headers = { "X-Square-HMACSHA256-Signature": "sig123" };
    assert.equal(getHeader(headers, "x-square-hmacsha256-signature"), "sig123");
    assert.equal(getHeader(headers, "X-SQUARE-HMACSHA256-SIGNATURE"), "sig123");
  });
  it("trims values", () => {
    const headers = { Host: "  api.example.com  " };
    assert.equal(getHeader(headers, "host"), "api.example.com");
  });
  it("returns empty string for missing header", () => {
    assert.equal(getHeader({ Host: "x" }, "missing"), "");
  });
  it("returns empty string for null/non-object headers", () => {
    assert.equal(getHeader(null, "host"), "");
    assert.equal(getHeader(undefined, "host"), "");
    assert.equal(getHeader("string", "host"), "");
  });
  it("coerces non-string Value to string", () => {
    const headers = { "x-count": 42 };
    assert.equal(getHeader(headers, "x-count"), "42");
  });
});

describe("getRawBody", () => {
  it("returns empty string when body missing", () => {
    assert.equal(getRawBody({}), "");
    assert.equal(getRawBody({ body: null }), "");
    assert.equal(getRawBody(null), "");
  });
  it("returns body verbatim when not base64-encoded", () => {
    assert.equal(getRawBody({ body: '{"a":1}' }), '{"a":1}');
    assert.equal(
      getRawBody({ body: '{"a":1}', isBase64Encoded: false }),
      '{"a":1}'
    );
  });
  it("decodes base64 when isBase64Encoded=true", () => {
    const b64 = Buffer.from('{"a":1}', "utf8").toString("base64");
    assert.equal(getRawBody({ body: b64, isBase64Encoded: true }), '{"a":1}');
  });
});

describe("buildRequestUrl", () => {
  it("builds https URL from x-forwarded-host + rawPath", () => {
    const event = {
      headers: { host: "api.famosofuego.com" },
      rawPath: "/webhooks/square",
    };
    assert.equal(buildRequestUrl(event), "https://api.famosofuego.com/webhooks/square");
  });

  it("prefers x-forwarded-proto over default https", () => {
    const event = {
      headers: { "x-forwarded-proto": "http", host: "x.com" },
      rawPath: "/wh",
    };
    assert.equal(buildRequestUrl(event), "http://x.com/wh");
  });

  it("prefers x-forwarded-host over host", () => {
    const event = {
      headers: {
        "x-forwarded-host": "public.example.com",
        host: "internal.example.com",
      },
      rawPath: "/wh",
    };
    assert.equal(buildRequestUrl(event), "https://public.example.com/wh");
  });

  it("appends rawQueryString when present", () => {
    const event = {
      headers: { host: "x.com" },
      rawPath: "/wh",
      rawQueryString: "ref=abc&token=xyz",
    };
    assert.equal(buildRequestUrl(event), "https://x.com/wh?ref=abc&token=xyz");
  });

  it("falls back to requestContext.http.path when rawPath empty", () => {
    const event = {
      headers: { host: "x.com" },
      requestContext: { http: { path: "/from-context" } },
    };
    assert.equal(buildRequestUrl(event), "https://x.com/from-context");
  });

  it("defaults path to '/' when neither rawPath nor requestContext is set", () => {
    const event = { headers: { host: "x.com" } };
    assert.equal(buildRequestUrl(event), "https://x.com/");
  });

  it("returns empty string when host is missing (security: don't construct relative URLs)", () => {
    const event = { headers: {}, rawPath: "/wh" };
    assert.equal(buildRequestUrl(event), "");
  });
});

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
  const calls = {
    requireAdmin: [],
    getSquareWebhookHealthSummary: [],
    verifySquareWebhookSignature: [],
    processSquareWebhookEvent: [],
    addReservationPayment: [],
    json: [],
  };
  return {
    calls,
    ctx: {
      method: overrides.method ?? "POST",
      path: overrides.path ?? "/webhooks/square",
      event: overrides.event ?? {},
      cors: { "Access-Control-Allow-Origin": "*" },
      json: (status, body, cors) => {
        calls.json.push({ status, body, cors });
        return { statusCode: status, body, cors };
      },
      requireAdmin: (event) => {
        calls.requireAdmin.push(event);
        if (overrides.requireAdminThrows) throw overrides.requireAdminThrows;
      },
      getSquareWebhookHealthSummary:
        overrides.getSquareWebhookHealthSummary ??
        (async () => {
          calls.getSquareWebhookHealthSummary.push(true);
          return { ok: true };
        }),
      verifySquareWebhookSignature:
        overrides.verifySquareWebhookSignature ??
        (async (args) => {
          calls.verifySquareWebhookSignature.push(args);
          return overrides.signatureValid ?? true;
        }),
      processSquareWebhookEvent:
        overrides.processSquareWebhookEvent ??
        (async (args) => {
          calls.processSquareWebhookEvent.push(args);
          return overrides.processResult ?? { processed: true };
        }),
      addReservationPayment:
        overrides.addReservationPayment ?? (async () => ({})),
      ...overrides.ctxOverrides,
    },
  };
}

describe("handleSquareWebhookRoute — path mismatch", () => {
  it("returns null when method/path don't match (router falls through)", async () => {
    const { ctx } = makeCtx({ method: "GET", path: "/something/else" });
    const out = await handleSquareWebhookRoute(ctx);
    assert.equal(out, null);
  });

  it("returns null on POST to a different path", async () => {
    const { ctx } = makeCtx({ method: "POST", path: "/other" });
    const out = await handleSquareWebhookRoute(ctx);
    assert.equal(out, null);
  });
});

describe("handleSquareWebhookRoute — GET /admin/square/webhook-health", () => {
  it("calls requireAdmin then returns the summary", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/admin/square/webhook-health",
      getSquareWebhookHealthSummary: async () => ({ ok: true, lastEvent: 12345 }),
    });
    const res = await handleSquareWebhookRoute(ctx);
    assert.equal(calls.requireAdmin.length, 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, lastEvent: 12345 });
  });

  it("propagates requireAdmin errors (no health call)", async () => {
    const { ctx, calls } = makeCtx({
      method: "GET",
      path: "/admin/square/webhook-health",
      requireAdminThrows: Object.assign(new Error("not admin"), { statusCode: 403 }),
    });
    await assert.rejects(
      () => handleSquareWebhookRoute(ctx),
      (err) => err?.statusCode === 403
    );
    assert.equal(calls.getSquareWebhookHealthSummary.length, 0);
  });

  it("matches with trailing slash variant", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      path: "/admin/square/webhook-health/",
    });
    const res = await handleSquareWebhookRoute(ctx);
    assert.equal(res.statusCode, 200);
  });
});

describe("handleSquareWebhookRoute — POST /webhooks/square", () => {
  it("400 on missing body (no signature check)", async () => {
    const { ctx, calls } = makeCtx({
      event: { body: "" },
    });
    const res = await handleSquareWebhookRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Missing body/);
    // Signature was never checked
    assert.equal(calls.verifySquareWebhookSignature.length, 0);
  });

  it("403 when signature verification fails", async () => {
    const { ctx, calls } = makeCtx({
      event: {
        body: '{"type":"payment.updated"}',
        headers: { "x-square-hmacsha256-signature": "bad-sig" },
      },
      signatureValid: false,
    });
    const res = await handleSquareWebhookRoute(ctx);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.message, /Invalid signature/);
    // processSquareWebhookEvent was NEVER called (security boundary respected)
    assert.equal(calls.processSquareWebhookEvent.length, 0);
  });

  it("400 on invalid JSON body (after passing signature check)", async () => {
    const { ctx, calls } = makeCtx({
      event: {
        body: "{not json",
        headers: { "x-square-hmacsha256-signature": "sig" },
      },
      signatureValid: true,
    });
    const res = await handleSquareWebhookRoute(ctx);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Invalid JSON/);
    assert.equal(calls.processSquareWebhookEvent.length, 0);
  });

  it("happy path: dispatches to processSquareWebhookEvent + returns audit", async () => {
    const { ctx, calls } = makeCtx({
      event: {
        body: '{"type":"payment.updated","event_id":"evt-1","data":{"id":"pay-1"}}',
        headers: { "x-square-hmacsha256-signature": "sig" },
        rawPath: "/webhooks/square",
      },
      signatureValid: true,
      processResult: {
        processed: true,
        type: "payment.updated",
        paymentId: "pay-1",
        reservationId: "res-1",
      },
    });
    const res = await handleSquareWebhookRoute(ctx);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    // Audit fields populated
    assert.equal(res.body.audit.handledAs, "processed");
    assert.equal(res.body.audit.eventType, "payment.updated");
    assert.equal(res.body.audit.eventId, "evt-1");
    assert.equal(res.body.audit.paymentId, "pay-1");
    assert.equal(res.body.audit.reservationId, "res-1");

    // verifySquareWebhookSignature was called with raw body (not parsed)
    assert.equal(calls.verifySquareWebhookSignature.length, 1);
    const sigArgs = calls.verifySquareWebhookSignature[0];
    assert.equal(sigArgs.signatureHeader, "sig");
    assert.equal(
      sigArgs.rawBody,
      '{"type":"payment.updated","event_id":"evt-1","data":{"id":"pay-1"}}'
    );

    // processSquareWebhookEvent called with parsed payload + addReservationPayment
    assert.equal(calls.processSquareWebhookEvent.length, 1);
    const procArgs = calls.processSquareWebhookEvent[0];
    assert.equal(procArgs.webhookEvent.type, "payment.updated");
    assert.equal(typeof procArgs.addReservationPayment, "function");
  });

  it("audit.handledAs='ignored' when processSquareWebhookEvent returns processed=false", async () => {
    const { ctx } = makeCtx({
      event: {
        body: '{"type":"unknown.event"}',
        headers: { "x-square-hmacsha256-signature": "sig" },
      },
      signatureValid: true,
      processResult: { processed: false, reason: "not_a_payment_event" },
    });
    const res = await handleSquareWebhookRoute(ctx);
    assert.equal(res.body.audit.handledAs, "ignored");
    assert.equal(res.body.audit.reason, "not_a_payment_event");
  });

  it("audit.paymentId falls back through payload paths (data.id, data.object.payment.id)", async () => {
    const { ctx } = makeCtx({
      event: {
        body: JSON.stringify({
          type: "payment.updated",
          data: { object: { payment: { id: "pay-from-object" } } },
        }),
        headers: { "x-square-hmacsha256-signature": "sig" },
      },
      signatureValid: true,
      processResult: { processed: true }, // no paymentId in result
    });
    const res = await handleSquareWebhookRoute(ctx);
    assert.equal(res.body.audit.paymentId, "pay-from-object");
  });

  it("decodes base64-encoded body before signature check", async () => {
    const rawBody = '{"type":"payment.updated"}';
    const b64 = Buffer.from(rawBody, "utf8").toString("base64");
    const { ctx, calls } = makeCtx({
      event: {
        body: b64,
        isBase64Encoded: true,
        headers: { "x-square-hmacsha256-signature": "sig" },
      },
      signatureValid: true,
    });
    await handleSquareWebhookRoute(ctx);
    // Signature verifier got the DECODED body
    assert.equal(calls.verifySquareWebhookSignature[0].rawBody, rawBody);
  });

  it("constructs the requestUrl from event headers + rawPath for signature validation", async () => {
    const { ctx, calls } = makeCtx({
      event: {
        body: '{"type":"x"}',
        headers: {
          "x-square-hmacsha256-signature": "sig",
          host: "api.famosofuego.com",
          "x-forwarded-proto": "https",
        },
        rawPath: "/webhooks/square",
      },
      signatureValid: true,
    });
    await handleSquareWebhookRoute(ctx);
    assert.equal(
      calls.verifySquareWebhookSignature[0].requestUrl,
      "https://api.famosofuego.com/webhooks/square"
    );
  });

  it("matches with trailing slash variant", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      path: "/webhooks/square/",
      event: {
        body: '{"type":"x"}',
        headers: { "x-square-hmacsha256-signature": "sig" },
      },
      signatureValid: true,
    });
    const res = await handleSquareWebhookRoute(ctx);
    assert.equal(res.statusCode, 200);
  });
});
