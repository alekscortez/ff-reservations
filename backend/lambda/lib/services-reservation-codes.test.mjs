// Pure-function tests for services-reservation-codes.mjs. Caller-injected
// random source means we can exercise specific code values deterministically
// without touching crypto.randomBytes directly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCodeLookupKey,
  buildSlugLookupKey,
  extractConfirmationCodeFromText,
  formatPublicConfirmationCode,
  generateConfirmationCode,
  generatePublicSlug,
  isValidConfirmationCode,
  isValidPublicSlug,
} from "./services-reservation-codes.mjs";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SLUG_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function fixedBytes(values) {
  return (n) => Buffer.from(values.slice(0, n));
}

describe("generateConfirmationCode", () => {
  it("returns 6 chars from the safe alphabet", () => {
    const out = generateConfirmationCode(fixedBytes([0, 1, 2, 3, 4, 5]));
    assert.equal(out.length, 6);
    for (const c of out) {
      assert.ok(CODE_ALPHABET.includes(c), `unexpected char: ${c}`);
    }
  });
  it("excludes ambiguous characters (0 O 1 I L)", () => {
    // Iterate enough samples to be confident, ambiguous chars never appear
    for (let i = 0; i < 200; i += 1) {
      const out = generateConfirmationCode(fixedBytes([i, i + 1, i + 2, i + 3, i + 4, i + 5]));
      assert.ok(!/[0OIL1]/.test(out), `bad char in: ${out}`);
    }
  });
  it("deterministic given the same bytes", () => {
    const a = generateConfirmationCode(fixedBytes([10, 20, 30, 40, 50, 60]));
    const b = generateConfirmationCode(fixedBytes([10, 20, 30, 40, 50, 60]));
    assert.equal(a, b);
  });
});

describe("generatePublicSlug", () => {
  it("returns 16 chars from base62", () => {
    const out = generatePublicSlug(
      fixedBytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    );
    assert.equal(out.length, 16);
    for (const c of out) {
      assert.ok(SLUG_ALPHABET.includes(c), `unexpected char: ${c}`);
    }
  });
});

describe("isValidConfirmationCode", () => {
  it("accepts well-formed codes", () => {
    assert.equal(isValidConfirmationCode("K7M3X2"), true);
    assert.equal(isValidConfirmationCode("AAAAAA"), true);
  });
  it("rejects wrong length", () => {
    assert.equal(isValidConfirmationCode("K7M3X"), false);
    assert.equal(isValidConfirmationCode("K7M3X2A"), false);
  });
  it("rejects ambiguous chars", () => {
    assert.equal(isValidConfirmationCode("K7M3O2"), false); // O
    assert.equal(isValidConfirmationCode("K7M3I2"), false); // I
    assert.equal(isValidConfirmationCode("K7M3L2"), false); // L
    assert.equal(isValidConfirmationCode("K7M302"), false); // 0
    assert.equal(isValidConfirmationCode("K7M312"), false); // 1
  });
  it("rejects lowercase + non-string", () => {
    assert.equal(isValidConfirmationCode("k7m3x2"), false);
    assert.equal(isValidConfirmationCode(null), false);
    assert.equal(isValidConfirmationCode(123456), false);
  });
});

describe("isValidPublicSlug", () => {
  it("accepts 16-char alphanumeric", () => {
    assert.equal(isValidPublicSlug("AbCdEf12GhJkLm34"), true);
  });
  it("rejects wrong length / special chars", () => {
    assert.equal(isValidPublicSlug("short"), false);
    assert.equal(isValidPublicSlug("AbCdEf12GhJkLm3-"), false);
    assert.equal(isValidPublicSlug(""), false);
    assert.equal(isValidPublicSlug(null), false);
  });
});

describe("extractConfirmationCodeFromText", () => {
  it("matches FF-XXXXXX format", () => {
    assert.equal(
      extractConfirmationCodeFromText("Booking #FF-K7M3X2 • Sat May 16, 2026"),
      "K7M3X2"
    );
  });
  it("matches case-insensitively (returns uppercase)", () => {
    assert.equal(
      extractConfirmationCodeFromText("booking #ff-k7m3x2 details"),
      "K7M3X2"
    );
  });
  it("matches the bare 6-char form when it's the whole string", () => {
    assert.equal(extractConfirmationCodeFromText("K7M3X2"), "K7M3X2");
  });
  it("returns null on no match / ambiguous chars", () => {
    assert.equal(extractConfirmationCodeFromText("no code here"), null);
    assert.equal(extractConfirmationCodeFromText("FF-K7M3O2"), null); // O is excluded
    assert.equal(extractConfirmationCodeFromText(""), null);
  });
});

describe("formatPublicConfirmationCode", () => {
  it("prefixes with FF-", () => {
    assert.equal(formatPublicConfirmationCode("K7M3X2"), "FF-K7M3X2");
  });
  it("uppercases lowercase input", () => {
    assert.equal(formatPublicConfirmationCode("k7m3x2"), "FF-K7M3X2");
  });
  it("returns empty on invalid input", () => {
    assert.equal(formatPublicConfirmationCode("K7M3X"), "");
    assert.equal(formatPublicConfirmationCode("K7M3O2"), "");
    assert.equal(formatPublicConfirmationCode(""), "");
  });
});

describe("buildCodeLookupKey + buildSlugLookupKey", () => {
  it("CODE lookup key uses PK=CODE", () => {
    assert.deepEqual(buildCodeLookupKey("K7M3X2"), {
      PK: "CODE",
      SK: "CODE#K7M3X2",
    });
  });
  it("SLUG lookup key uses PK=SLUG", () => {
    assert.deepEqual(buildSlugLookupKey("abc123"), {
      PK: "SLUG",
      SK: "SLUG#abc123",
    });
  });
});
