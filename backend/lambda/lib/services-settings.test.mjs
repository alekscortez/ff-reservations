// Tests for the pure helpers in services-settings.mjs (newly exported
// for testability — no behavior change). Cover the value parsers,
// timezone validation, ISO date math, hex color validation, the
// section-color normalizer (throws on bad shape), buildDefaults env
// mapping, the per-key normalizer (with strictUnknown handling), and
// the patch normalizer.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDefaults,
  clampInteger,
  DEFAULT_SECTION_MAP_COLORS,
  isHexColor,
  isValidTimeZone,
  localPartsForZone,
  normalizeIsoDate,
  normalizePatch,
  normalizeSectionMapColors,
  normalizeValueForKey,
  parseBoolean,
  parseInteger,
  subtractOneIsoDay,
} from "./services-settings.mjs";

// ---------------------------------------------------------------------------
// parseBoolean
// ---------------------------------------------------------------------------

describe("parseBoolean", () => {
  it("passes through native booleans", () => {
    assert.equal(parseBoolean(true, false), true);
    assert.equal(parseBoolean(false, true), false);
  });
  it("treats numbers: 0 → false, anything else → true", () => {
    assert.equal(parseBoolean(0, true), false);
    assert.equal(parseBoolean(1, false), true);
    assert.equal(parseBoolean(-5, false), true);
  });
  it("parses common string truthy values", () => {
    for (const v of ["true", "TRUE", "1", "yes", "YES", "on", "enabled"]) {
      assert.equal(parseBoolean(v, false), true);
    }
  });
  it("parses common string falsy values", () => {
    for (const v of ["false", "FALSE", "0", "no", "off", "disabled"]) {
      assert.equal(parseBoolean(v, true), false);
    }
  });
  it("falls back on empty string", () => {
    assert.equal(parseBoolean("", true), true);
    assert.equal(parseBoolean("   ", true), true);
  });
  it("falls back on unknown string", () => {
    assert.equal(parseBoolean("maybe", true), true);
    assert.equal(parseBoolean("maybe", false), false);
  });
  it("falls back on null/undefined/object", () => {
    assert.equal(parseBoolean(null, true), true);
    assert.equal(parseBoolean(undefined, false), false);
    assert.equal(parseBoolean({}, false), false);
  });
});

// ---------------------------------------------------------------------------
// parseInteger + clampInteger
// ---------------------------------------------------------------------------

describe("parseInteger", () => {
  it("rounds finite numbers", () => {
    assert.equal(parseInteger(1.4, 0), 1);
    assert.equal(parseInteger(1.6, 0), 2);
    assert.equal(parseInteger("3.7", 0), 4);
  });
  it("falls back on NaN / undefined / null=0 (Number(null) === 0)", () => {
    assert.equal(parseInteger(NaN, 99), 99);
    assert.equal(parseInteger(undefined, 99), 99);
    assert.equal(parseInteger(null, 99), 0); // Number(null) → 0, finite
  });
});

describe("clampInteger", () => {
  it("clamps to [min, max]", () => {
    assert.equal(clampInteger(50, 0, 100, 0), 50);
    assert.equal(clampInteger(-10, 0, 100, 0), 0);
    assert.equal(clampInteger(150, 0, 100, 0), 100);
  });
  it("rounds before clamping", () => {
    assert.equal(clampInteger(99.7, 0, 100, 0), 100);
  });
  it("falls back on NaN", () => {
    assert.equal(clampInteger(NaN, 0, 100, 42), 42);
  });
});

// ---------------------------------------------------------------------------
// isValidTimeZone
// ---------------------------------------------------------------------------

describe("isValidTimeZone", () => {
  it("accepts known IANA zones", () => {
    assert.equal(isValidTimeZone("America/Chicago"), true);
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Asia/Tokyo"), true);
  });
  it("rejects bogus zones", () => {
    assert.equal(isValidTimeZone("Mars/Olympus"), false);
    assert.equal(isValidTimeZone("Notreal"), false);
  });
  it("rejects empty/whitespace", () => {
    assert.equal(isValidTimeZone(""), false);
    assert.equal(isValidTimeZone("   "), false);
    assert.equal(isValidTimeZone(null), false);
  });
});

// ---------------------------------------------------------------------------
// normalizeIsoDate
// ---------------------------------------------------------------------------

describe("normalizeIsoDate", () => {
  it("accepts YYYY-MM-DD", () => {
    assert.equal(normalizeIsoDate("2026-05-09"), "2026-05-09");
  });
  it("trims whitespace", () => {
    assert.equal(normalizeIsoDate("  2026-05-09  "), "2026-05-09");
  });
  it("rejects other formats", () => {
    assert.equal(normalizeIsoDate("2026/05/09"), null);
    assert.equal(normalizeIsoDate("2026-5-9"), null);
    assert.equal(normalizeIsoDate("2026-05-09T00:00:00"), null);
    assert.equal(normalizeIsoDate(""), null);
    assert.equal(normalizeIsoDate(null), null);
  });
});

// ---------------------------------------------------------------------------
// isHexColor
// ---------------------------------------------------------------------------

describe("isHexColor", () => {
  it("accepts 3-digit and 6-digit hex (#abc, #aabbcc)", () => {
    assert.equal(isHexColor("#abc"), true);
    assert.equal(isHexColor("#ABC"), true);
    assert.equal(isHexColor("#abcdef"), true);
    assert.equal(isHexColor("#FF00aa"), true);
  });
  it("rejects no-#, bad chars, wrong length", () => {
    assert.equal(isHexColor("abc"), false);
    assert.equal(isHexColor("#abcd"), false);
    assert.equal(isHexColor("#ggg"), false);
    assert.equal(isHexColor("#1234567"), false);
  });
  it("rejects empty / null", () => {
    assert.equal(isHexColor(""), false);
    assert.equal(isHexColor(null), false);
  });
});

// ---------------------------------------------------------------------------
// normalizeSectionMapColors
// ---------------------------------------------------------------------------

describe("normalizeSectionMapColors", () => {
  it("returns DEFAULT colors when value is null", () => {
    const out = normalizeSectionMapColors(null);
    assert.deepEqual(out, { ...DEFAULT_SECTION_MAP_COLORS });
  });
  it("merges fallback over DEFAULT, then merges valid hex from value", () => {
    const out = normalizeSectionMapColors(
      { A: "#FFFFFF" },
      { A: "#000000", B: "#222222" }
    );
    assert.equal(out.A, "#ffffff"); // value overrides fallback
    assert.equal(out.B, "#222222"); // fallback overrides DEFAULT
    assert.equal(out.C, DEFAULT_SECTION_MAP_COLORS.C); // DEFAULT for unspecified
  });
  it("uses fallback color for empty-string section value", () => {
    const out = normalizeSectionMapColors({ A: "  " }, { A: "#abcdef" });
    assert.equal(out.A, "#abcdef");
  });
  it("throws on non-object value", () => {
    assert.throws(() => normalizeSectionMapColors("not object"), /must be an object/);
    assert.throws(() => normalizeSectionMapColors([1, 2, 3]), /must be an object/);
  });
  it("throws on bad hex per-key", () => {
    assert.throws(
      () => normalizeSectionMapColors({ A: "not-a-color" }),
      /sectionMapColors\.A must be HEX/
    );
  });
  it("ignores unknown section keys (not in A-E)", () => {
    const out = normalizeSectionMapColors({ Z: "#FFFFFF" });
    assert.equal(out.Z, undefined); // Z not in SECTION_KEYS
  });
});

// ---------------------------------------------------------------------------
// subtractOneIsoDay
// ---------------------------------------------------------------------------

describe("subtractOneIsoDay", () => {
  it("subtracts 1 day in UTC", () => {
    assert.equal(subtractOneIsoDay("2026-05-09"), "2026-05-08");
  });
  it("crosses month boundary", () => {
    assert.equal(subtractOneIsoDay("2026-06-01"), "2026-05-31");
  });
  it("crosses year boundary", () => {
    assert.equal(subtractOneIsoDay("2026-01-01"), "2025-12-31");
  });
  it("crosses leap-day boundary", () => {
    assert.equal(subtractOneIsoDay("2024-03-01"), "2024-02-29");
    assert.equal(subtractOneIsoDay("2025-03-01"), "2025-02-28");
  });
  it("returns input unchanged when not parseable", () => {
    assert.equal(subtractOneIsoDay("garbage"), "garbage");
    assert.equal(subtractOneIsoDay(""), "");
  });
});

// ---------------------------------------------------------------------------
// localPartsForZone
// ---------------------------------------------------------------------------

describe("localPartsForZone", () => {
  it("returns date + time parts for a valid zone", () => {
    // 2026-05-09T12:34:56Z in UTC
    const nowMs = Date.parse("2026-05-09T12:34:56Z");
    const parts = localPartsForZone(nowMs, "UTC");
    assert.equal(parts.isoDate, "2026-05-09");
    assert.equal(parts.hour, 12);
    assert.equal(parts.minute, 34);
    assert.equal(parts.second, 56);
  });
  it("converts UTC to America/Chicago (CDT in May = UTC-5)", () => {
    const nowMs = Date.parse("2026-05-09T12:00:00Z");
    const parts = localPartsForZone(nowMs, "America/Chicago");
    assert.equal(parts.isoDate, "2026-05-09");
    assert.equal(parts.hour, 7); // 12:00 UTC - 5h = 07:00 local
  });
});

// ---------------------------------------------------------------------------
// buildDefaults — env mapping (verifies the bounds + types of all settings)
// ---------------------------------------------------------------------------

describe("buildDefaults", () => {
  it("returns a complete defaults object with empty env (no overrides)", () => {
    const out = buildDefaults({});
    // operating
    assert.equal(out.operatingTz, "America/Chicago");
    assert.equal(out.operatingDayCutoffHour, 5);
    // hold + payment links
    assert.equal(out.holdTtlSeconds, 300);
    assert.equal(out.paymentLinkTtlMinutes, 10);
    assert.equal(out.frequentPaymentLinkTtlMinutes, 1440);
    // SMS
    assert.equal(out.smsEnabled, true);
    assert.equal(out.autoSendSquareLinkSms, false);
    assert.equal(out.cashReceiptNumberRequired, true);
    // deadlines
    assert.equal(out.defaultPaymentDeadlineHour, 0);
    assert.equal(out.rescheduleCutoffHour, 22);
    // square (sandbox by default)
    assert.equal(out.squareEnvMode, "sandbox");
    assert.equal(out.squareApplicationId, "");
    // sectionMapColors
    assert.deepEqual(out.sectionMapColors, { ...DEFAULT_SECTION_MAP_COLORS });
  });
  it("respects env overrides (and clamps values to bounds)", () => {
    const out = buildDefaults({
      OPERATING_TZ: "Asia/Tokyo",
      HOLD_TTL_SECONDS: "5000", // above 1800 max → clamped
      PAYMENT_LINK_TTL_MINUTES: "30",
      SMS_ENABLED: "false",
      SQUARE_ENV: "production",
      SQUARE_APPLICATION_ID: "sq0aaa",
      SECTION_COLOR_A: "#000000",
    });
    assert.equal(out.operatingTz, "Asia/Tokyo");
    assert.equal(out.holdTtlSeconds, 1800); // clamped
    assert.equal(out.paymentLinkTtlMinutes, 30);
    assert.equal(out.smsEnabled, false);
    assert.equal(out.squareEnvMode, "production");
    assert.equal(out.squareApplicationId, "sq0aaa");
    assert.equal(out.sectionMapColors.A, "#000000");
  });
  it("falls back to America/Chicago for invalid OPERATING_TZ", () => {
    const out = buildDefaults({ OPERATING_TZ: "Mars/Olympus" });
    assert.equal(out.operatingTz, "America/Chicago");
  });
  it("customerContactPhoneE164: normalizes from env, empty when unset", () => {
    assert.equal(buildDefaults({}).customerContactPhoneE164, "");
    assert.equal(
      buildDefaults({ CUSTOMER_CONTACT_PHONE_E164: "+18557656160" })
        .customerContactPhoneE164,
      "+18557656160"
    );
    assert.equal(
      buildDefaults({ CUSTOMER_CONTACT_PHONE_E164: "(855) 765-6160" })
        .customerContactPhoneE164,
      "+18557656160"
    );
  });
  it("anonymous booking: defaults are conservative, env can override", () => {
    const out = buildDefaults({});
    assert.equal(out.allowAnonymousPublicBooking, false);
    assert.equal(out.anonymousHoldTtlSeconds, 600);
    assert.equal(out.anonymousMaxTablesPerBooking, 4);
    assert.equal(out.turnstileSiteKey, "");
  });
  it("anonymous booking: env overrides + clamps", () => {
    const out = buildDefaults({
      ALLOW_ANONYMOUS_PUBLIC_BOOKING: "true",
      ANONYMOUS_HOLD_TTL_SECONDS: "9999", // above 1800 max → clamped
      ANONYMOUS_MAX_TABLES_PER_BOOKING: "0", // below 1 min → clamped
      TURNSTILE_SITE_KEY: "  0x4AAA  ",
    });
    assert.equal(out.allowAnonymousPublicBooking, true);
    assert.equal(out.anonymousHoldTtlSeconds, 1800);
    assert.equal(out.anonymousMaxTablesPerBooking, 1);
    assert.equal(out.turnstileSiteKey, "0x4AAA");
  });
});

// ---------------------------------------------------------------------------
// normalizeValueForKey — per-key validation + clamping
// ---------------------------------------------------------------------------

describe("normalizeValueForKey", () => {
  it("operatingTz: throws on invalid IANA, accepts valid", () => {
    assert.throws(
      () => normalizeValueForKey("operatingTz", "Mars/Olympus", "America/Chicago"),
      /valid IANA timezone/
    );
    assert.equal(
      normalizeValueForKey("operatingTz", "UTC", "America/Chicago"),
      "UTC"
    );
    assert.equal(
      normalizeValueForKey("operatingTz", "", "America/Chicago"),
      "America/Chicago"
    );
  });
  it("clampInteger keys: respects bounds", () => {
    assert.equal(normalizeValueForKey("operatingDayCutoffHour", 5, 5), 5);
    assert.equal(normalizeValueForKey("operatingDayCutoffHour", 99, 5), 23);
    assert.equal(normalizeValueForKey("holdTtlSeconds", 60, 300), 60);
    assert.equal(normalizeValueForKey("holdTtlSeconds", 9999, 300), 1800);
  });
  it("boolean keys: parse via parseBoolean", () => {
    assert.equal(normalizeValueForKey("smsEnabled", "off", true), false);
    assert.equal(normalizeValueForKey("autoSendSquareLinkSms", "true", false), true);
  });
  it("squareEnvMode / squareApplicationId / squareLocationId are env-managed (always returns fallback)", () => {
    assert.equal(
      normalizeValueForKey("squareEnvMode", "production", "sandbox"),
      "sandbox"
    );
    assert.equal(
      normalizeValueForKey("squareApplicationId", "x", "y"),
      "y"
    );
  });
  it("sectionMapColors: validates + returns merged", () => {
    const out = normalizeValueForKey(
      "sectionMapColors",
      { A: "#FFFFFF" },
      { ...DEFAULT_SECTION_MAP_COLORS }
    );
    assert.equal(out.A, "#ffffff");
    assert.equal(out.B, DEFAULT_SECTION_MAP_COLORS.B);
  });
  it("unknown key: returns fallback (no throw)", () => {
    assert.equal(normalizeValueForKey("nonsense", "value", "default"), "default");
  });
  it("checkInPassBaseUrl: trims whitespace", () => {
    assert.equal(
      normalizeValueForKey("checkInPassBaseUrl", "  https://x  ", ""),
      "https://x"
    );
  });
  it("customerContactPhoneE164: empty stays empty", () => {
    assert.equal(normalizeValueForKey("customerContactPhoneE164", "", "+1"), "");
    assert.equal(normalizeValueForKey("customerContactPhoneE164", "   ", "+1"), "");
  });
  it("customerContactPhoneE164: accepts E.164 + national US/MX format", () => {
    assert.equal(
      normalizeValueForKey("customerContactPhoneE164", "+18557656160", ""),
      "+18557656160"
    );
    assert.equal(
      normalizeValueForKey("customerContactPhoneE164", "(855) 765-6160", ""),
      "+18557656160"
    );
  });
  it("customerContactPhoneE164: throws on bad input", () => {
    assert.throws(
      () => normalizeValueForKey("customerContactPhoneE164", "garbage", ""),
      /must be an E\.164 phone number/
    );
  });
  it("allowAnonymousPublicBooking: parsed via parseBoolean", () => {
    assert.equal(normalizeValueForKey("allowAnonymousPublicBooking", "yes", false), true);
    assert.equal(normalizeValueForKey("allowAnonymousPublicBooking", "off", true), false);
    assert.equal(normalizeValueForKey("allowAnonymousPublicBooking", "", true), true);
  });
  it("anonymousHoldTtlSeconds: clamped 300-1800", () => {
    assert.equal(normalizeValueForKey("anonymousHoldTtlSeconds", 600, 600), 600);
    assert.equal(normalizeValueForKey("anonymousHoldTtlSeconds", 100, 600), 300);
    assert.equal(normalizeValueForKey("anonymousHoldTtlSeconds", 9999, 600), 1800);
  });
  it("anonymousMaxTablesPerBooking: clamped 1-10", () => {
    assert.equal(normalizeValueForKey("anonymousMaxTablesPerBooking", 4, 4), 4);
    assert.equal(normalizeValueForKey("anonymousMaxTablesPerBooking", 0, 4), 1);
    assert.equal(normalizeValueForKey("anonymousMaxTablesPerBooking", 99, 4), 10);
  });
  it("turnstileSiteKey: trims whitespace", () => {
    assert.equal(normalizeValueForKey("turnstileSiteKey", "  abc  ", ""), "abc");
    assert.equal(normalizeValueForKey("turnstileSiteKey", "", "x"), "");
  });
});

// ---------------------------------------------------------------------------
// normalizePatch
// ---------------------------------------------------------------------------

describe("normalizePatch", () => {
  const current = {
    operatingTz: "America/Chicago",
    holdTtlSeconds: 300,
    smsEnabled: true,
    paymentLinkTtlMinutes: 10,
  };

  it("throws on non-object patch", () => {
    assert.throws(
      () => normalizePatch(current, null, { strictUnknown: false }),
      /must be an object/
    );
    assert.throws(
      () => normalizePatch(current, [1, 2], { strictUnknown: false }),
      /must be an object/
    );
  });

  it("applies known-key updates over current", () => {
    const out = normalizePatch(
      current,
      { holdTtlSeconds: 500, smsEnabled: false },
      { strictUnknown: false }
    );
    assert.equal(out.holdTtlSeconds, 500);
    assert.equal(out.smsEnabled, false);
    assert.equal(out.operatingTz, "America/Chicago"); // unchanged
  });

  it("strictUnknown=false: silently drops unknown keys", () => {
    const out = normalizePatch(
      current,
      { unknownField: "x", smsEnabled: false },
      { strictUnknown: false }
    );
    assert.equal(out.unknownField, undefined);
    assert.equal(out.smsEnabled, false);
  });

  it("strictUnknown=true: throws on unknown keys", () => {
    assert.throws(
      () =>
        normalizePatch(
          current,
          { unknownField: "x" },
          { strictUnknown: true }
        ),
      /Unknown setting key: unknownField/
    );
  });

  it("clamps known keys to their bounds", () => {
    const out = normalizePatch(
      current,
      { holdTtlSeconds: 99999 },
      { strictUnknown: false }
    );
    assert.equal(out.holdTtlSeconds, 1800);
  });
});
