// Tests for the pure helpers extracted from services-square-payments.mjs.
// Cover the security-critical pieces (HMAC signature build, timing-safe
// comparison, replay window) and the parsing helpers (note extraction,
// payment ref extraction, webhook URL fan-out, currency conversion).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";

import {
  addWebhookUrlCandidates,
  buildSquareSignature,
  DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS,
  evaluateWebhookReplayWindowPure,
  extractReservationFromNote,
  extractReservationRefFromPayment,
  formatEventDateForLabel,
  isIsoDate,
  isUuidLike,
  MAX_FUTURE_CLOCK_SKEW_SECONDS,
  normalizeWebhookUrl,
  parseBooleanEnv,
  parseJsonPayload,
  parseSquareErrorMessage,
  resolveSquareApiBaseUrl,
  signaturesEqual,
  toMajorAmount,
  toSquareBuyerPhone,
} from "./services-square-payments-pure.mjs";

const VALID_UUID = "12345678-1234-4abc-89de-123456789012";
const VALID_DATE = "2026-05-09";

// ---------------------------------------------------------------------------
// resolveSquareApiBaseUrl
// ---------------------------------------------------------------------------

describe("resolveSquareApiBaseUrl", () => {
  it("returns production URL for production", () => {
    assert.equal(resolveSquareApiBaseUrl("production"), "https://connect.squareup.com");
  });
  it("returns sandbox URL for sandbox / anything else", () => {
    assert.equal(resolveSquareApiBaseUrl("sandbox"), "https://connect.squareupsandbox.com");
    assert.equal(resolveSquareApiBaseUrl("garbage"), "https://connect.squareupsandbox.com");
    assert.equal(resolveSquareApiBaseUrl(""), "https://connect.squareupsandbox.com");
  });
});

// ---------------------------------------------------------------------------
// parseBooleanEnv
// ---------------------------------------------------------------------------

describe("parseBooleanEnv", () => {
  it("parses truthy values case-insensitively", () => {
    for (const v of ["1", "true", "TRUE", "Yes", " on "]) {
      assert.equal(parseBooleanEnv(v), true);
    }
  });
  it("parses falsy values case-insensitively", () => {
    for (const v of ["0", "false", "FALSE", "no", " off "]) {
      assert.equal(parseBooleanEnv(v), false);
    }
  });
  it("returns fallback for empty / unknown inputs", () => {
    assert.equal(parseBooleanEnv(""), false);
    assert.equal(parseBooleanEnv("", true), true);
    assert.equal(parseBooleanEnv(null, true), true);
    assert.equal(parseBooleanEnv("maybe", true), true);
    assert.equal(parseBooleanEnv("maybe"), false);
  });
});

// ---------------------------------------------------------------------------
// toSquareBuyerPhone
// ---------------------------------------------------------------------------

describe("toSquareBuyerPhone", () => {
  it("passes through valid E.164 phones", () => {
    assert.equal(toSquareBuyerPhone("+12025550100"), "+12025550100");
    assert.equal(toSquareBuyerPhone("+528991054670"), "+528991054670");
  });
  it("returns null for non-E.164 phones (national, dirty, empty)", () => {
    assert.equal(toSquareBuyerPhone("2025550100"), null);
    assert.equal(toSquareBuyerPhone("(202) 555-0100"), null);
    assert.equal(toSquareBuyerPhone("+0123456789"), null); // leading 0 in country code
    assert.equal(toSquareBuyerPhone(""), null);
    assert.equal(toSquareBuyerPhone(null), null);
  });
  it("returns null for too-short / too-long E.164", () => {
    assert.equal(toSquareBuyerPhone("+1234567"), null); // 7 national digits, too short
    assert.equal(toSquareBuyerPhone("+1" + "1".repeat(20)), null);
  });
});

// ---------------------------------------------------------------------------
// formatEventDateForLabel
// ---------------------------------------------------------------------------

describe("formatEventDateForLabel", () => {
  it("formats a valid YYYY-MM-DD as Weekday, Month D, Year", () => {
    // 2026-05-09 was a Saturday
    assert.equal(formatEventDateForLabel("2026-05-09"), "Sat, May 9, 2026");
  });
  it("returns input unchanged when not parseable", () => {
    assert.equal(formatEventDateForLabel("garbage"), "garbage");
    assert.equal(formatEventDateForLabel(""), "");
    assert.equal(formatEventDateForLabel(null), "");
  });
});

// ---------------------------------------------------------------------------
// parseJsonPayload + parseSquareErrorMessage
// ---------------------------------------------------------------------------

describe("parseJsonPayload", () => {
  it("parses valid JSON", () => {
    assert.deepEqual(parseJsonPayload('{"a":1}'), { a: 1 });
  });
  it("returns {} for empty input", () => {
    assert.deepEqual(parseJsonPayload(""), {});
  });
  it("returns {raw} on parse error", () => {
    assert.deepEqual(parseJsonPayload("{bad"), { raw: "{bad" });
  });
});

describe("parseSquareErrorMessage", () => {
  it("prefers errors[0].detail", () => {
    const out = parseSquareErrorMessage(
      { errors: [{ detail: "Bad amount", code: "INVALID" }] },
      "fallback"
    );
    assert.equal(out, "Bad amount");
  });
  it("falls back to errors[0].code when detail is missing", () => {
    const out = parseSquareErrorMessage({ errors: [{ code: "INVALID" }] }, "fallback");
    assert.equal(out, "INVALID");
  });
  it("returns fallback when no errors array", () => {
    assert.equal(parseSquareErrorMessage({}, "fallback"), "fallback");
    assert.equal(parseSquareErrorMessage(null, "fallback"), "fallback");
  });
});

// ---------------------------------------------------------------------------
// normalizeWebhookUrl + addWebhookUrlCandidates
// ---------------------------------------------------------------------------

describe("normalizeWebhookUrl", () => {
  it("trims whitespace", () => {
    assert.equal(normalizeWebhookUrl("  https://x  "), "https://x");
  });
  it("returns empty string for null / undefined", () => {
    assert.equal(normalizeWebhookUrl(null), "");
    assert.equal(normalizeWebhookUrl(undefined), "");
  });
});

describe("addWebhookUrlCandidates", () => {
  it("adds both trailing-slash variants", () => {
    const set = new Set();
    addWebhookUrlCandidates(set, "https://api.example.com/webhooks/square");
    assert.deepEqual(
      [...set].sort(),
      [
        "https://api.example.com/webhooks/square",
        "https://api.example.com/webhooks/square/",
      ].sort()
    );
  });
  it("strips trailing slash when present", () => {
    const set = new Set();
    addWebhookUrlCandidates(set, "https://api.example.com/webhooks/square/");
    assert.deepEqual(
      [...set].sort(),
      [
        "https://api.example.com/webhooks/square",
        "https://api.example.com/webhooks/square/",
      ].sort()
    );
  });
  it("no-ops on empty input", () => {
    const set = new Set();
    addWebhookUrlCandidates(set, "");
    addWebhookUrlCandidates(set, null);
    assert.equal(set.size, 0);
  });
});

// ---------------------------------------------------------------------------
// signaturesEqual + buildSquareSignature (HMAC — security-critical)
// ---------------------------------------------------------------------------

describe("signaturesEqual", () => {
  it("returns true for byte-identical strings", () => {
    assert.equal(signaturesEqual("abc123", "abc123"), true);
  });
  it("returns false for different strings of the same length", () => {
    assert.equal(signaturesEqual("abc123", "xyz456"), false);
  });
  it("returns false for length mismatch (no timing leak)", () => {
    assert.equal(signaturesEqual("short", "longer"), false);
  });
  it("returns false for empty inputs", () => {
    assert.equal(signaturesEqual("", ""), false);
    assert.equal(signaturesEqual("abc", ""), false);
    assert.equal(signaturesEqual("", "abc"), false);
  });
  it("trims whitespace before comparing", () => {
    assert.equal(signaturesEqual("  abc  ", "abc"), true);
  });
});

describe("buildSquareSignature", () => {
  it("produces a base64 HMAC-SHA256 of (notificationUrl + rawBody)", () => {
    const signatureKey = "test-key-xyz";
    const notificationUrl = "https://api.example.com/webhooks/square";
    const rawBody = '{"event":"payment.updated","payment_id":"p1"}';
    const out = buildSquareSignature({ signatureKey, notificationUrl, rawBody });
    // Cross-check by computing the same HMAC manually
    const expected = createHmac("sha256", signatureKey)
      .update(notificationUrl + rawBody, "utf8")
      .digest("base64");
    assert.equal(out, expected);
  });
  it("produces different signatures for different bodies", () => {
    const args = { signatureKey: "k", notificationUrl: "u" };
    const a = buildSquareSignature({ ...args, rawBody: '{"a":1}' });
    const b = buildSquareSignature({ ...args, rawBody: '{"a":2}' });
    assert.notEqual(a, b);
  });
  it("produces different signatures for different keys", () => {
    const args = { notificationUrl: "u", rawBody: "body" };
    const a = buildSquareSignature({ ...args, signatureKey: "k1" });
    const b = buildSquareSignature({ ...args, signatureKey: "k2" });
    assert.notEqual(a, b);
  });
  it("end-to-end: signaturesEqual recognises a self-built signature", () => {
    const args = {
      signatureKey: "mykey",
      notificationUrl: "https://api.example.com/wh",
      rawBody: '{"t":"x"}',
    };
    const sig = buildSquareSignature(args);
    assert.equal(signaturesEqual(sig, buildSquareSignature(args)), true);
  });
});

// ---------------------------------------------------------------------------
// isUuidLike + isIsoDate
// ---------------------------------------------------------------------------

describe("isUuidLike", () => {
  it("accepts canonical RFC 4122 UUIDs (v1-v5)", () => {
    assert.equal(isUuidLike("12345678-1234-4abc-89de-123456789012"), true);
    assert.equal(isUuidLike("00000000-0000-1000-8000-000000000000"), true);
  });
  it("rejects non-RFC-4122 UUIDs (wrong version digit / wrong variant nibble)", () => {
    assert.equal(isUuidLike("12345678-1234-9abc-89de-123456789012"), false);
    assert.equal(isUuidLike("12345678-1234-4abc-79de-123456789012"), false);
  });
  it("rejects malformed strings", () => {
    assert.equal(isUuidLike("not-a-uuid"), false);
    assert.equal(isUuidLike(""), false);
    assert.equal(isUuidLike(null), false);
  });
  it("trims whitespace before checking", () => {
    assert.equal(isUuidLike("  12345678-1234-4abc-89de-123456789012  "), true);
  });
});

describe("isIsoDate", () => {
  it("accepts YYYY-MM-DD", () => {
    assert.equal(isIsoDate("2026-05-09"), true);
    assert.equal(isIsoDate("0001-01-01"), true);
  });
  it("rejects other formats", () => {
    assert.equal(isIsoDate("2026/05/09"), false);
    assert.equal(isIsoDate("2026-5-9"), false);
    assert.equal(isIsoDate("2026-05-09T00:00:00"), false);
    assert.equal(isIsoDate(""), false);
  });
});

// ---------------------------------------------------------------------------
// extractReservationFromNote + extractReservationRefFromPayment
// ---------------------------------------------------------------------------

describe("extractReservationFromNote", () => {
  it("extracts reservationId + eventDate from a well-formed note", () => {
    const out = extractReservationFromNote(`Reservation ${VALID_UUID} · ${VALID_DATE}`);
    assert.deepEqual(out, { reservationId: VALID_UUID, eventDate: VALID_DATE });
  });
  it("works with hyphen separator", () => {
    const out = extractReservationFromNote(`reservation ${VALID_UUID} - ${VALID_DATE}`);
    assert.deepEqual(out, { reservationId: VALID_UUID, eventDate: VALID_DATE });
  });
  it("works with pipe separator", () => {
    const out = extractReservationFromNote(`Reservation ${VALID_UUID} | ${VALID_DATE}`);
    assert.deepEqual(out, { reservationId: VALID_UUID, eventDate: VALID_DATE });
  });
  it("returns null on bad uuid", () => {
    const out = extractReservationFromNote(
      "Reservation not-a-uuid-not-a-uuid-not-a-uuid-bad · 2026-05-09"
    );
    assert.equal(out, null);
  });
  it("returns null on bad date", () => {
    const out = extractReservationFromNote(`Reservation ${VALID_UUID} · 99-99-99`);
    assert.equal(out, null);
  });
  it("returns null on empty / missing note", () => {
    assert.equal(extractReservationFromNote(""), null);
    assert.equal(extractReservationFromNote(null), null);
  });
});

describe("extractReservationRefFromPayment", () => {
  it("prefers metadata when both reservationId + eventDate are present and valid", () => {
    const payment = {
      metadata: { reservationId: VALID_UUID, eventDate: VALID_DATE },
      note: `Reservation ${VALID_UUID} · 2025-01-01`,
    };
    const out = extractReservationRefFromPayment(payment);
    // Should pick metadata's eventDate, not the note's
    assert.deepEqual(out, { reservationId: VALID_UUID, eventDate: VALID_DATE });
  });
  it("falls through to note when metadata is missing", () => {
    const payment = { note: `Reservation ${VALID_UUID} · ${VALID_DATE}` };
    const out = extractReservationRefFromPayment(payment);
    assert.deepEqual(out, { reservationId: VALID_UUID, eventDate: VALID_DATE });
  });
  it("falls through to reference_id + metadata.eventDate when both note and metadata.reservationId are missing", () => {
    const payment = {
      reference_id: VALID_UUID,
      metadata: { eventDate: VALID_DATE },
    };
    const out = extractReservationRefFromPayment(payment);
    assert.deepEqual(out, { reservationId: VALID_UUID, eventDate: VALID_DATE });
  });
  it("returns null when nothing parseable is present", () => {
    assert.equal(extractReservationRefFromPayment({}), null);
    assert.equal(extractReservationRefFromPayment({ note: "no ref here" }), null);
    assert.equal(extractReservationRefFromPayment(null), null);
  });
  it("ignores invalid metadata reservationId (rejects malformed UUIDs)", () => {
    const payment = {
      metadata: { reservationId: "bad-uuid", eventDate: VALID_DATE },
    };
    assert.equal(extractReservationRefFromPayment(payment), null);
  });
});

// ---------------------------------------------------------------------------
// toMajorAmount
// ---------------------------------------------------------------------------

describe("toMajorAmount", () => {
  it("converts cents to dollars (integer)", () => {
    assert.equal(toMajorAmount(10000), 100);
    assert.equal(toMajorAmount(199), 1.99);
  });
  it("returns 0 for non-positive / non-finite", () => {
    assert.equal(toMajorAmount(0), 0);
    assert.equal(toMajorAmount(-100), 0);
    assert.equal(toMajorAmount(NaN), 0);
    assert.equal(toMajorAmount(undefined), 0);
    assert.equal(toMajorAmount(null), 0);
  });
});

// ---------------------------------------------------------------------------
// evaluateWebhookReplayWindowPure (replay protection — security-critical)
// ---------------------------------------------------------------------------

describe("evaluateWebhookReplayWindowPure", () => {
  const REPLAY_SECONDS = 600;
  const NOW_MS = Date.parse("2026-05-09T18:00:00Z");

  it("accepts a webhook within the window", () => {
    const out = evaluateWebhookReplayWindowPure({
      webhookCreatedAt: "2026-05-09T17:55:00Z", // 5 min ago
      replayWindowSeconds: REPLAY_SECONDS,
      nowMs: NOW_MS,
    });
    assert.equal(out.ok, true);
    assert.equal(out.replayWindowSeconds, REPLAY_SECONDS);
    assert.equal(out.ageSeconds, 300);
  });

  it("rejects a webhook outside the window (too old)", () => {
    const out = evaluateWebhookReplayWindowPure({
      webhookCreatedAt: "2026-05-09T17:30:00Z", // 30 min ago
      replayWindowSeconds: REPLAY_SECONDS,
      nowMs: NOW_MS,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "outside_replay_window");
    assert.equal(out.ageSeconds, 1800);
  });

  it("rejects a webhook with createdAt in the future beyond clock-skew tolerance", () => {
    const out = evaluateWebhookReplayWindowPure({
      // 5 min in the future, beyond MAX_FUTURE_CLOCK_SKEW_SECONDS (2 min)
      webhookCreatedAt: "2026-05-09T18:05:00Z",
      replayWindowSeconds: REPLAY_SECONDS,
      nowMs: NOW_MS,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "created_at_in_future");
    assert.equal(out.ageSeconds, -300);
  });

  it("accepts a webhook within the future-skew tolerance window", () => {
    const out = evaluateWebhookReplayWindowPure({
      // 1 min in the future — within MAX_FUTURE_CLOCK_SKEW_SECONDS
      webhookCreatedAt: "2026-05-09T18:01:00Z",
      replayWindowSeconds: REPLAY_SECONDS,
      nowMs: NOW_MS,
    });
    assert.equal(out.ok, true);
    assert.equal(out.ageSeconds, -60);
  });

  it("rejects empty / missing createdAt", () => {
    assert.equal(
      evaluateWebhookReplayWindowPure({
        webhookCreatedAt: "",
        replayWindowSeconds: REPLAY_SECONDS,
        nowMs: NOW_MS,
      }).reason,
      "missing_created_at"
    );
    assert.equal(
      evaluateWebhookReplayWindowPure({
        webhookCreatedAt: null,
        replayWindowSeconds: REPLAY_SECONDS,
        nowMs: NOW_MS,
      }).reason,
      "missing_created_at"
    );
  });

  it("rejects unparseable createdAt", () => {
    const out = evaluateWebhookReplayWindowPure({
      webhookCreatedAt: "not-a-date",
      replayWindowSeconds: REPLAY_SECONDS,
      nowMs: NOW_MS,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "invalid_created_at");
  });
});

// ---------------------------------------------------------------------------
// Constants regression
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS is 10 minutes", () => {
    assert.equal(DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS, 600);
  });
  it("MAX_FUTURE_CLOCK_SKEW_SECONDS is 2 minutes", () => {
    assert.equal(MAX_FUTURE_CLOCK_SKEW_SECONDS, 120);
  });
});
