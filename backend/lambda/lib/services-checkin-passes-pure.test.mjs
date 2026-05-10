// Tests for the pure helpers extracted from services-checkin-passes.mjs.
// Cover token normalization (multiple URL/prefix formats), hashing
// (SHA-256 reproducibility), pass-status predicates (security: rejects
// non-ISSUED + expired), history sanitization (DDB-safe types), and
// URL templating.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";

import {
  buildPassUrlFromBaseUrl,
  hashToken,
  isPassActive,
  normalizePassForRead,
  normalizeTokenInput,
  sanitizeHistoryValue,
  toHistorySk,
} from "./services-checkin-passes-pure.mjs";

const FIXED_NOW = 1_700_000_000;
const FUTURE = FIXED_NOW + 3600;
const PAST = FIXED_NOW - 3600;

// ---------------------------------------------------------------------------
// normalizeTokenInput
// ---------------------------------------------------------------------------

describe("normalizeTokenInput", () => {
  it("strips ffr-checkin: prefix (case-insensitive)", () => {
    assert.equal(normalizeTokenInput("ffr-checkin:abc123"), "abc123");
    assert.equal(normalizeTokenInput("FFR-CHECKIN:abc123"), "abc123");
  });

  it("returns raw token when no prefix or URL", () => {
    assert.equal(normalizeTokenInput("plain-token-123"), "plain-token-123");
  });

  it("extracts token from a query-string-like input", () => {
    assert.equal(normalizeTokenInput("?token=abc123"), "abc123");
    assert.equal(normalizeTokenInput("foo&token=abc123"), "abc123");
  });

  it("decodes URL-encoded token from query string", () => {
    assert.equal(normalizeTokenInput("?token=hello%20world"), "hello world");
  });

  it("extracts token from a full URL", () => {
    assert.equal(
      normalizeTokenInput("https://app.example.com/check-in?token=abc123"),
      "abc123"
    );
  });

  it("returns the raw URL when no token query param", () => {
    assert.equal(
      normalizeTokenInput("https://app.example.com/check-in"),
      "https://app.example.com/check-in"
    );
  });

  it("falls back to the raw input on URL parse errors", () => {
    assert.equal(normalizeTokenInput("https://[bad-url"), "https://[bad-url");
  });

  it("returns empty string for empty / null input", () => {
    assert.equal(normalizeTokenInput(""), "");
    assert.equal(normalizeTokenInput(null), "");
    assert.equal(normalizeTokenInput(undefined), "");
    assert.equal(normalizeTokenInput("   "), "");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normalizeTokenInput("  ffr-checkin:abc  "), "abc");
  });
});

// ---------------------------------------------------------------------------
// hashToken
// ---------------------------------------------------------------------------

describe("hashToken", () => {
  it("returns SHA-256 hex of input", () => {
    const expected = createHash("sha256").update("hello", "utf8").digest("hex");
    assert.equal(hashToken("hello"), expected);
  });

  it("is deterministic", () => {
    assert.equal(hashToken("xyz"), hashToken("xyz"));
  });

  it("produces different hashes for different inputs (sanity)", () => {
    assert.notEqual(hashToken("a"), hashToken("b"));
  });

  it("treats empty / null input as empty string", () => {
    const expected = createHash("sha256").update("", "utf8").digest("hex");
    assert.equal(hashToken(""), expected);
    assert.equal(hashToken(null), expected);
    assert.equal(hashToken(undefined), expected);
  });
});

// ---------------------------------------------------------------------------
// sanitizeHistoryValue
// ---------------------------------------------------------------------------

describe("sanitizeHistoryValue", () => {
  it("passes through scalar primitives", () => {
    assert.equal(sanitizeHistoryValue("str"), "str");
    assert.equal(sanitizeHistoryValue(42), 42);
    assert.equal(sanitizeHistoryValue(true), true);
    assert.equal(sanitizeHistoryValue(null), null);
  });

  it("returns undefined for unsupported types (function, symbol, undefined)", () => {
    assert.equal(sanitizeHistoryValue(undefined), undefined);
    assert.equal(sanitizeHistoryValue(() => {}), undefined);
    assert.equal(sanitizeHistoryValue(Symbol("x")), undefined);
  });

  it("recursively sanitizes arrays", () => {
    assert.deepEqual(
      sanitizeHistoryValue(["a", 1, undefined, () => {}, true]),
      ["a", 1, true]
    );
  });

  it("recursively sanitizes objects, drops undefined-yielding keys", () => {
    const out = sanitizeHistoryValue({
      a: "x",
      b: undefined,
      c: () => {},
      d: { e: 1, f: undefined },
    });
    assert.deepEqual(out, { a: "x", d: { e: 1 } });
  });

  it("preserves null values explicitly (null != undefined for DDB)", () => {
    assert.deepEqual(sanitizeHistoryValue({ a: null, b: undefined }), { a: null });
  });
});

// ---------------------------------------------------------------------------
// toHistorySk
// ---------------------------------------------------------------------------

describe("toHistorySk", () => {
  it("formats with 12-digit zero-padded epoch", () => {
    assert.equal(
      toHistorySk("res-1", 1_700_000_000, "evt-1"),
      "HIST#res-1#001700000000#evt-1"
    );
  });
  it("treats invalid epoch as 0 (still 12 zero pad)", () => {
    assert.equal(
      toHistorySk("res-1", "garbage", "evt-1"),
      "HIST#res-1#000000000000#evt-1"
    );
  });
  it("works with null/undefined epoch", () => {
    assert.equal(
      toHistorySk("res-1", null, "evt-1"),
      "HIST#res-1#000000000000#evt-1"
    );
  });
});

// ---------------------------------------------------------------------------
// isPassActive
// ---------------------------------------------------------------------------

describe("isPassActive", () => {
  it("rejects null / undefined", () => {
    assert.equal(isPassActive(null, FIXED_NOW), false);
    assert.equal(isPassActive(undefined, FIXED_NOW), false);
  });

  it("rejects non-ISSUED status (USED, REVOKED, EXPIRED)", () => {
    assert.equal(isPassActive({ status: "USED", expiresAt: FUTURE }, FIXED_NOW), false);
    assert.equal(isPassActive({ status: "REVOKED", expiresAt: FUTURE }, FIXED_NOW), false);
    assert.equal(isPassActive({ status: "EXPIRED", expiresAt: FUTURE }, FIXED_NOW), false);
  });

  it("accepts case-variants of ISSUED", () => {
    assert.equal(isPassActive({ status: "issued", expiresAt: FUTURE }, FIXED_NOW), true);
    assert.equal(isPassActive({ status: "ISSUED", expiresAt: FUTURE }, FIXED_NOW), true);
  });

  it("rejects past expiry (==now is also rejected)", () => {
    assert.equal(isPassActive({ status: "ISSUED", expiresAt: PAST }, FIXED_NOW), false);
    assert.equal(
      isPassActive({ status: "ISSUED", expiresAt: FIXED_NOW }, FIXED_NOW),
      false
    );
  });

  it("rejects non-finite expiresAt", () => {
    assert.equal(isPassActive({ status: "ISSUED", expiresAt: "bad" }, FIXED_NOW), false);
    assert.equal(isPassActive({ status: "ISSUED", expiresAt: null }, FIXED_NOW), false);
  });
});

// ---------------------------------------------------------------------------
// normalizePassForRead
// ---------------------------------------------------------------------------

describe("normalizePassForRead", () => {
  it("flips ISSUED + past-expiry to EXPIRED (read-time only, doesn't mutate)", () => {
    const item = { status: "ISSUED", expiresAt: PAST, foo: "bar" };
    const out = normalizePassForRead(item, FIXED_NOW);
    assert.equal(out.status, "EXPIRED");
    assert.equal(out.foo, "bar");
    assert.equal(item.status, "ISSUED", "original is not mutated");
  });

  it("leaves ISSUED + future-expiry untouched", () => {
    const item = { status: "ISSUED", expiresAt: FUTURE };
    assert.equal(normalizePassForRead(item, FIXED_NOW), item);
  });

  it("leaves USED / REVOKED / EXPIRED untouched", () => {
    for (const status of ["USED", "REVOKED", "EXPIRED"]) {
      const item = { status, expiresAt: PAST };
      assert.equal(normalizePassForRead(item, FIXED_NOW), item);
    }
  });

  it("returns null for null input", () => {
    assert.equal(normalizePassForRead(null, FIXED_NOW), null);
  });

  it("does not flip when expiresAt is 0 (treat as not-set)", () => {
    const item = { status: "ISSUED", expiresAt: 0 };
    assert.equal(normalizePassForRead(item, FIXED_NOW), item);
  });
});

// ---------------------------------------------------------------------------
// buildPassUrlFromBaseUrl
// ---------------------------------------------------------------------------

describe("buildPassUrlFromBaseUrl", () => {
  it("returns null for empty base URL", () => {
    assert.equal(buildPassUrlFromBaseUrl("", "abc"), null);
    assert.equal(buildPassUrlFromBaseUrl(null, "abc"), null);
  });

  it("substitutes {token} placeholder when present", () => {
    assert.equal(
      buildPassUrlFromBaseUrl("https://app.x/check-in/{token}", "abc"),
      "https://app.x/check-in/abc"
    );
  });

  it("URL-encodes the token in placeholder substitution", () => {
    assert.equal(
      buildPassUrlFromBaseUrl("https://app.x/{token}", "hello world"),
      "https://app.x/hello%20world"
    );
  });

  it("uses URL.searchParams when base is a parseable URL without placeholder", () => {
    const out = buildPassUrlFromBaseUrl("https://app.x/check-in", "abc");
    assert.equal(out, "https://app.x/check-in?token=abc");
  });

  it("merges with existing query string in URL form", () => {
    const out = buildPassUrlFromBaseUrl("https://app.x/check-in?ref=email", "abc");
    assert.match(out, /ref=email/);
    assert.match(out, /token=abc/);
  });

  it("falls back to string concat when base is not a parseable URL", () => {
    // No protocol, no URL.parse — fallback path
    const out = buildPassUrlFromBaseUrl("/check-in", "abc");
    assert.equal(out, "/check-in?token=abc");
  });

  it("uses & joiner when fallback base already has ?", () => {
    const out = buildPassUrlFromBaseUrl("/check-in?ref=email", "abc");
    assert.equal(out, "/check-in?ref=email&token=abc");
  });

  it("URL-encodes token in fallback path", () => {
    assert.equal(
      buildPassUrlFromBaseUrl("/check-in", "hello world"),
      "/check-in?token=hello%20world"
    );
  });
});
