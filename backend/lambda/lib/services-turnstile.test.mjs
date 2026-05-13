// Tests for the Cloudflare Turnstile verifier (services-turnstile.mjs).
// fetch is dependency-injected so the tests run offline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTurnstileService } from "./services-turnstile.mjs";

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

const SILENT_LOGGER = { warn: () => undefined };

function makeFakeFetch(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[i] ?? responses[responses.length - 1];
    i += 1;
    if (typeof next === "function") return next();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("createTurnstileService.verifyTurnstileToken", () => {
  it("happy path: returns success=true with the parsed body", async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      jsonResponse({
        success: true,
        hostname: "famosofuego.com",
        challenge_ts: "2026-05-13T12:34:56.000Z",
      }),
    ]);
    const svc = createTurnstileService({
      fetchImpl,
      httpError,
      logger: SILENT_LOGGER,
    });
    const out = await svc.verifyTurnstileToken({
      token: "tok-abc",
      secret: "sec-xyz",
      remoteIp: "203.0.113.1",
    });
    assert.equal(out.success, true);
    assert.equal(out.hostname, "famosofuego.com");
    assert.equal(out.challengeTs, "2026-05-13T12:34:56.000Z");
    assert.deepEqual(out.errorCodes, []);

    // Form-encoded with secret + response + remoteip
    const body = String(calls[0].init?.body ?? "");
    assert.match(body, /secret=sec-xyz/);
    assert.match(body, /response=tok-abc/);
    assert.match(body, /remoteip=203\.0\.113\.1/);
  });

  it("returns success=false + errorCodes when Turnstile rejects the token", async () => {
    const { fetchImpl } = makeFakeFetch([
      jsonResponse({
        success: false,
        "error-codes": ["timeout-or-duplicate"],
      }),
    ]);
    const svc = createTurnstileService({
      fetchImpl,
      httpError,
      logger: SILENT_LOGGER,
    });
    const out = await svc.verifyTurnstileToken({
      token: "tok-old",
      secret: "sec-xyz",
    });
    assert.equal(out.success, false);
    assert.deepEqual(out.errorCodes, ["timeout-or-duplicate"]);
  });

  it("missing token returns success=false without hitting fetch", async () => {
    const { fetchImpl, calls } = makeFakeFetch([
      jsonResponse({ success: true }),
    ]);
    const svc = createTurnstileService({
      fetchImpl,
      httpError,
      logger: SILENT_LOGGER,
    });
    const out = await svc.verifyTurnstileToken({ token: "", secret: "sec" });
    assert.equal(out.success, false);
    assert.deepEqual(out.errorCodes, ["missing-input-response"]);
    assert.equal(calls.length, 0);
  });

  it("missing secret throws 500 (deploy misconfiguration)", async () => {
    const { fetchImpl } = makeFakeFetch([jsonResponse({ success: true })]);
    const svc = createTurnstileService({
      fetchImpl,
      httpError,
      logger: SILENT_LOGGER,
    });
    await assert.rejects(
      svc.verifyTurnstileToken({ token: "tok", secret: "" }),
      /TURNSTILE secret is not configured/
    );
  });

  it("network failure throws 503 (fail closed, not silent allow)", async () => {
    const { fetchImpl } = makeFakeFetch([new Error("ECONNREFUSED")]);
    const svc = createTurnstileService({
      fetchImpl,
      httpError,
      logger: SILENT_LOGGER,
    });
    await assert.rejects(
      svc.verifyTurnstileToken({ token: "tok", secret: "sec" }),
      /Could not reach Turnstile verifier/
    );
  });

  it("non-2xx HTTP throws 503", async () => {
    const { fetchImpl } = makeFakeFetch([
      jsonResponse({ message: "internal" }, { status: 500 }),
    ]);
    const svc = createTurnstileService({
      fetchImpl,
      httpError,
      logger: SILENT_LOGGER,
    });
    await assert.rejects(
      svc.verifyTurnstileToken({ token: "tok", secret: "sec" }),
      /Turnstile verifier returned non-2xx/
    );
  });

  it("invalid JSON throws 503", async () => {
    const { fetchImpl } = makeFakeFetch([
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      },
    ]);
    const svc = createTurnstileService({
      fetchImpl,
      httpError,
      logger: SILENT_LOGGER,
    });
    await assert.rejects(
      svc.verifyTurnstileToken({ token: "tok", secret: "sec" }),
      /Turnstile verifier returned invalid JSON/
    );
  });

  it("constructor throws when fetchImpl is missing", () => {
    assert.throws(
      () => createTurnstileService({ fetchImpl: null, httpError }),
      /fetchImpl is required/
    );
  });
});
