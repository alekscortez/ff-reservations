// Tests for the pure helpers extracted from services-sms-notifications.mjs.
// Pin the 10DLC compliance suffix in every transactional template,
// the TTL phrase formatter (24hr / 1hr / N min thresholds), the date
// label, the legacy phone normalizer, and the sender-id validator.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCheckInPassMessage,
  buildPaymentLinkExpiredMessage,
  buildPaymentLinkMessage,
  formatEventDateLabel,
  formatTtlPhrase,
  isValidSenderId,
  normalizeE164Phone,
  OPT_OUT_SUFFIX,
} from "./services-sms-notifications-pure.mjs";

// ---------------------------------------------------------------------------
// OPT_OUT_SUFFIX constant + 10DLC compliance regression
// ---------------------------------------------------------------------------

describe("OPT_OUT_SUFFIX (10DLC compliance)", () => {
  it("is the exact phrase carriers expect", () => {
    assert.equal(OPT_OUT_SUFFIX, "Reply STOP to opt out.");
  });
});

// ---------------------------------------------------------------------------
// formatEventDateLabel
// ---------------------------------------------------------------------------

describe("formatEventDateLabel", () => {
  it("formats YYYY-MM-DD as Mon D, YYYY", () => {
    assert.equal(formatEventDateLabel("2026-05-09"), "May 9, 2026");
    assert.equal(formatEventDateLabel("2026-12-25"), "Dec 25, 2026");
    assert.equal(formatEventDateLabel("2026-01-01"), "Jan 1, 2026");
  });
  it("returns input unchanged when not parseable", () => {
    assert.equal(formatEventDateLabel("garbage"), "garbage");
    assert.equal(formatEventDateLabel("2026/05/09"), "2026/05/09");
  });
  it("trims whitespace before parsing", () => {
    assert.equal(formatEventDateLabel("  2026-05-09  "), "May 9, 2026");
  });
  it("returns empty for empty / null input", () => {
    assert.equal(formatEventDateLabel(""), "");
    assert.equal(formatEventDateLabel(null), "");
    assert.equal(formatEventDateLabel(undefined), "");
  });
  it("preserves single-digit day without leading zero", () => {
    assert.equal(formatEventDateLabel("2026-05-09"), "May 9, 2026");
  });
});

// ---------------------------------------------------------------------------
// normalizeE164Phone — legacy-record best-effort normalization
// ---------------------------------------------------------------------------

describe("normalizeE164Phone", () => {
  it("preserves +-prefixed input verbatim (digits only)", () => {
    assert.equal(normalizeE164Phone("+12025550100"), "+12025550100");
    assert.equal(normalizeE164Phone("+1 (202) 555-0100"), "+12025550100");
  });
  it("adds +1 to 10-digit US numbers", () => {
    assert.equal(normalizeE164Phone("2025550100"), "+12025550100");
    assert.equal(normalizeE164Phone("(202) 555-0100"), "+12025550100");
  });
  it("recognizes 11-digit numbers starting with 1 as US", () => {
    assert.equal(normalizeE164Phone("12025550100"), "+12025550100");
  });
  it("recognizes 12-digit numbers starting with 52 as MX", () => {
    assert.equal(normalizeE164Phone("528991054670"), "+528991054670");
  });
  it("recognizes 13-digit numbers starting with 521 as MX mobile", () => {
    assert.equal(normalizeE164Phone("5218991054670"), "+5218991054670");
  });
  it("falls through to + + digits for other lengths", () => {
    // 9 digits — falls through (best-effort), not great but documented behavior
    assert.equal(normalizeE164Phone("123456789"), "+123456789");
  });
  it("returns empty for empty / null / digit-less input", () => {
    assert.equal(normalizeE164Phone(""), "");
    assert.equal(normalizeE164Phone(null), "");
    assert.equal(normalizeE164Phone("---"), "");
    assert.equal(normalizeE164Phone("abc"), "");
  });
});

// ---------------------------------------------------------------------------
// isValidSenderId — SNS SenderID rules
// ---------------------------------------------------------------------------

describe("isValidSenderId", () => {
  it("accepts 1-11 alphanumeric chars", () => {
    assert.equal(isValidSenderId("FF"), true);
    assert.equal(isValidSenderId("FAMOSO"), true);
    assert.equal(isValidSenderId("FAMOSOFUEGO"), true); // exactly 11
  });
  it("rejects 12+ chars", () => {
    assert.equal(isValidSenderId("FAMOSOFUEGO1"), false);
  });
  it("rejects empty / whitespace-only", () => {
    assert.equal(isValidSenderId(""), false);
    assert.equal(isValidSenderId("   "), false);
    assert.equal(isValidSenderId(null), false);
  });
  it("rejects punctuation / spaces inside", () => {
    assert.equal(isValidSenderId("FAMOSO FUEGO"), false);
    assert.equal(isValidSenderId("FAMOSO-FUEGO"), false);
    assert.equal(isValidSenderId("FF!"), false);
  });
});

// ---------------------------------------------------------------------------
// formatTtlPhrase — bucketed TTL display
// ---------------------------------------------------------------------------

describe("formatTtlPhrase", () => {
  it("returns 'Expires soon.' for invalid / non-positive minutes", () => {
    assert.equal(formatTtlPhrase(0), "Expires soon.");
    assert.equal(formatTtlPhrase(-10), "Expires soon.");
    assert.equal(formatTtlPhrase(NaN), "Expires soon.");
    assert.equal(formatTtlPhrase("bad"), "Expires soon.");
    assert.equal(formatTtlPhrase(null), "Expires soon.");
  });
  it("formats sub-hour minutes", () => {
    assert.equal(formatTtlPhrase(15), "Expires in 15 min.");
    assert.equal(formatTtlPhrase(45), "Expires in 45 min.");
    assert.equal(formatTtlPhrase(59), "Expires in 59 min.");
  });
  it("rounds non-integer minutes", () => {
    assert.equal(formatTtlPhrase(15.7), "Expires in 16 min.");
  });
  it("uses singular hour at exactly 60", () => {
    assert.equal(formatTtlPhrase(60), "Expires in 1 hour.");
  });
  it("plural hours for 90 / 120 / etc", () => {
    assert.equal(formatTtlPhrase(120), "Expires in 2 hours.");
    assert.equal(formatTtlPhrase(180), "Expires in 3 hours.");
  });
  it("rounds hour bucket", () => {
    assert.equal(formatTtlPhrase(90), "Expires in 2 hours.");
  });
  it("uses singular '24 hours' at exactly 1440 (not '1 day')", () => {
    assert.equal(formatTtlPhrase(1440), "Expires in 24 hours.");
  });
  it("plural days above 1440", () => {
    assert.equal(formatTtlPhrase(2880), "Expires in 2 days.");
    assert.equal(formatTtlPhrase(10080), "Expires in 7 days.");
  });
});

// ---------------------------------------------------------------------------
// buildPaymentLinkMessage
// ---------------------------------------------------------------------------

describe("buildPaymentLinkMessage", () => {
  it("includes greeting, date, table, URL, TTL, confirms-after-payment, and OPT_OUT_SUFFIX", () => {
    const out = buildPaymentLinkMessage({
      customerName: "Alice",
      eventDate: "2026-05-09",
      tableId: "A1",
      paymentLinkUrl: "https://sq.link/abc",
      ttlMinutes: 60,
    });
    assert.match(out, /^Hi Alice,/);
    assert.match(out, /May 9, 2026/);
    assert.match(out, /Table A1/);
    assert.match(out, /https:\/\/sq\.link\/abc/);
    assert.match(out, /Expires in 1 hour\./);
    assert.match(out, /Reservation confirms after payment\./);
    assert.ok(out.endsWith(OPT_OUT_SUFFIX), `expected to end with OPT_OUT_SUFFIX, got: ${out}`);
  });
  it("falls back to 'Hi,' when customer name is missing", () => {
    const out = buildPaymentLinkMessage({
      customerName: "",
      eventDate: "2026-05-09",
      tableId: "A1",
      paymentLinkUrl: "https://x",
      ttlMinutes: 30,
    });
    assert.match(out, /^Hi, pay /);
  });
  it("omits date/table block when both are empty", () => {
    const out = buildPaymentLinkMessage({
      customerName: "Alice",
      eventDate: "",
      tableId: "",
      paymentLinkUrl: "https://x",
      ttlMinutes: 30,
    });
    assert.match(out, /^Hi Alice, pay https:\/\/x\./);
  });
  it("always ends with OPT_OUT_SUFFIX (10DLC compliance regression)", () => {
    const out = buildPaymentLinkMessage({
      customerName: "Alice",
      eventDate: "2026-05-09",
      tableId: "A1",
      paymentLinkUrl: "https://x",
      ttlMinutes: 60,
    });
    assert.ok(out.includes(OPT_OUT_SUFFIX));
  });
});

// ---------------------------------------------------------------------------
// buildPaymentLinkExpiredMessage
// ---------------------------------------------------------------------------

describe("buildPaymentLinkExpiredMessage", () => {
  it("includes greeting, expired phrase, table, call-us instruction, OPT_OUT_SUFFIX", () => {
    const out = buildPaymentLinkExpiredMessage({
      customerName: "Alice",
      tableId: "A1",
    });
    assert.equal(
      out,
      "Hi Alice, your payment link for Table A1 expired. Please call us to request a new link. " +
        OPT_OUT_SUFFIX
    );
  });
  it("omits 'for Table X' when table is empty", () => {
    const out = buildPaymentLinkExpiredMessage({
      customerName: "Alice",
      tableId: "",
    });
    assert.equal(
      out,
      "Hi Alice, your payment link expired. Please call us to request a new link. " +
        OPT_OUT_SUFFIX
    );
  });
  it("falls back to 'Hi,' when name is missing", () => {
    const out = buildPaymentLinkExpiredMessage({ customerName: "", tableId: "A1" });
    assert.match(out, /^Hi, /);
  });
  it("ends with OPT_OUT_SUFFIX (10DLC regression)", () => {
    const out = buildPaymentLinkExpiredMessage({ customerName: "X", tableId: "Y" });
    assert.ok(out.endsWith(OPT_OUT_SUFFIX));
  });
});

// ---------------------------------------------------------------------------
// buildCheckInPassMessage
// ---------------------------------------------------------------------------

describe("multi-table SMS labels", () => {
  it("buildPaymentLinkMessage renders 'Tables 1, 2, 3' when tableIds[] is supplied", () => {
    const out = buildPaymentLinkMessage({
      customerName: "Alice",
      eventDate: "2026-05-09",
      tableIds: ["A1", "B3", "C2"],
      paymentLinkUrl: "https://sq.link/abc",
      ttlMinutes: 60,
    });
    assert.match(out, /Tables A1, B3, C2/);
    assert.ok(!out.match(/Table A1[^,]/));
  });
  it("buildPaymentLinkMessage falls back to scalar tableId when tableIds[] is empty", () => {
    const out = buildPaymentLinkMessage({
      customerName: "Alice",
      eventDate: "2026-05-09",
      tableId: "A1",
      tableIds: [],
      paymentLinkUrl: "https://x",
      ttlMinutes: 30,
    });
    assert.match(out, /Table A1/);
  });
  it("buildPaymentLinkMessage prefers tableIds[] over scalar tableId", () => {
    const out = buildPaymentLinkMessage({
      customerName: "Alice",
      eventDate: "2026-05-09",
      tableId: "OLD",
      tableIds: ["A1", "B3"],
      paymentLinkUrl: "https://x",
      ttlMinutes: 30,
    });
    assert.match(out, /Tables A1, B3/);
    assert.ok(!out.includes("OLD"));
  });
  it("buildPaymentLinkExpiredMessage renders multi-table label", () => {
    const out = buildPaymentLinkExpiredMessage({
      customerName: "Alice",
      tableIds: ["A1", "B3"],
    });
    assert.match(out, /for Tables A1, B3/);
  });
  it("buildCheckInPassMessage renders multi-table label", () => {
    const out = buildCheckInPassMessage({
      customerName: "Alice",
      eventDate: "2026-05-09",
      tableIds: ["A1", "B3", "C2"],
      passUrl: "https://app/pass?t=xyz",
    });
    assert.match(out, /Tables A1, B3, C2/);
  });
});

describe("buildCheckInPassMessage", () => {
  it("includes greeting, thanks, date, table, URL, OPT_OUT_SUFFIX", () => {
    const out = buildCheckInPassMessage({
      customerName: "Alice",
      eventDate: "2026-05-09",
      tableId: "A1",
      passUrl: "https://app/pass?t=xyz",
    });
    assert.match(out, /^Hi Alice,/);
    assert.match(out, /thank you for your reservation/);
    assert.match(out, /May 9, 2026/);
    assert.match(out, /Table A1/);
    assert.match(out, /https:\/\/app\/pass\?t=xyz/);
    assert.ok(out.endsWith(OPT_OUT_SUFFIX));
  });
  it("falls back to 'Hi,' when name is missing", () => {
    const out = buildCheckInPassMessage({
      customerName: "",
      eventDate: "2026-05-09",
      tableId: "A1",
      passUrl: "https://x",
    });
    assert.match(out, /^Hi, /);
  });
  it("omits date/table block when both are empty", () => {
    const out = buildCheckInPassMessage({
      customerName: "Alice",
      eventDate: "",
      tableId: "",
      passUrl: "https://x",
    });
    // Should NOT include "Table " or any month abbreviation
    assert.ok(!out.includes("Table "));
    assert.ok(!out.match(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/));
  });
  it("ends with OPT_OUT_SUFFIX (10DLC regression)", () => {
    const out = buildCheckInPassMessage({
      customerName: "Alice",
      eventDate: "2026-05-09",
      tableId: "A1",
      passUrl: "https://x",
    });
    assert.ok(out.endsWith(OPT_OUT_SUFFIX));
  });
});
