// Run: `node --test backend/lambda/lib/` from the repo root.
// Pure-function tests for core-utils. No AWS / network mocks needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addDaysToIsoDate,
  buildPhoneSearchCandidates,
  detectPhoneCountryFromE164,
  getBody,
  httpError,
  normalizeNameForSearch,
  normalizePhone,
  normalizePhoneCountry,
  normalizePhoneE164,
  nowEpoch,
  requiredEnv,
  roundToCents,
  safeStringEquals,
  toMajorUnits,
  toMinorUnits,
} from "./core-utils.mjs";

describe("normalizePhoneCountry", () => {
  it("accepts US and MX", () => {
    assert.equal(normalizePhoneCountry("US"), "US");
    assert.equal(normalizePhoneCountry("MX"), "MX");
    assert.equal(normalizePhoneCountry("us"), "US");
  });

  it("falls back to US for unknown / empty / nullish", () => {
    assert.equal(normalizePhoneCountry(null), "US");
    assert.equal(normalizePhoneCountry(undefined), "US");
    assert.equal(normalizePhoneCountry(""), "US");
    assert.equal(normalizePhoneCountry("CA"), "US");
    assert.equal(normalizePhoneCountry("123"), "US");
  });
});

describe("normalizePhoneE164", () => {
  it("returns +1 for 10-digit US national input", () => {
    assert.equal(normalizePhoneE164("2025550123", "US"), "+12025550123");
    assert.equal(normalizePhoneE164("(202) 555-0123", "US"), "+12025550123");
    assert.equal(normalizePhoneE164("202-555-0123", "US"), "+12025550123");
  });

  it("returns +52 for 10-digit MX national input when country hint is MX", () => {
    assert.equal(normalizePhoneE164("8991054670", "MX"), "+528991054670");
  });

  it("strips +1 / +52 international prefix correctly", () => {
    assert.equal(normalizePhoneE164("+12025550123"), "+12025550123");
    assert.equal(normalizePhoneE164("+528991054670"), "+528991054670");
  });

  it("collapses MX cellular leading-1 (12-digit +52 form)", () => {
    // +52 1 899 105 4670 → +528991054670 (Mexico cell often dialed with extra 1)
    assert.equal(normalizePhoneE164("+5218991054670"), "+528991054670");
  });

  it("converts 00-prefixed to +", () => {
    assert.equal(normalizePhoneE164("0012025550123"), "+12025550123");
  });

  it("returns empty for invalid lengths", () => {
    assert.equal(normalizePhoneE164("12345"), "");
    assert.equal(normalizePhoneE164(""), "");
    assert.equal(normalizePhoneE164(null), "");
    assert.equal(normalizePhoneE164(undefined), "");
  });

  it("rejects unknown country prefixes", () => {
    // +44 (UK) is not in our supported set
    assert.equal(normalizePhoneE164("+447911123456"), "");
  });
});

describe("normalizePhone", () => {
  it("returns digit-only normalized form", () => {
    assert.equal(normalizePhone("+1 (202) 555-0123"), "12025550123");
    assert.equal(normalizePhone("8991054670", "MX"), "528991054670");
  });

  it("returns empty for invalid input", () => {
    assert.equal(normalizePhone("12345"), "");
    assert.equal(normalizePhone(null), "");
  });
});

describe("detectPhoneCountryFromE164", () => {
  it("identifies US and MX", () => {
    assert.equal(detectPhoneCountryFromE164("+12025550123"), "US");
    assert.equal(detectPhoneCountryFromE164("+528991054670"), "MX");
  });

  it("returns null for unknown / invalid", () => {
    assert.equal(detectPhoneCountryFromE164("+447911123456"), null);
    assert.equal(detectPhoneCountryFromE164(""), null);
    assert.equal(detectPhoneCountryFromE164(null), null);
  });
});

describe("buildPhoneSearchCandidates", () => {
  it("returns multiple candidate digit forms for a 10-digit US number", () => {
    const candidates = buildPhoneSearchCandidates("2025550123", "US");
    assert.ok(candidates.includes("2025550123"));
    assert.ok(candidates.includes("12025550123"));
    assert.ok(candidates.includes("522025550123"));
  });

  it("adds 1{digits} and 52{digits} variants for partial 4-9 digit prefixes", () => {
    // Without this the staff form finds nothing when typing a partial phone
    // because all CRM rows are keyed PHONE#1XXXXXXXXXX (begins_with("956")
    // doesn't match begins_with("1956")).
    const c4 = buildPhoneSearchCandidates("9566");
    assert.ok(c4.includes("9566"));
    assert.ok(c4.includes("19566"));
    assert.ok(c4.includes("529566"));

    const c7 = buildPhoneSearchCandidates("9566014");
    assert.ok(c7.includes("9566014"));
    assert.ok(c7.includes("19566014"));
    assert.ok(c7.includes("529566014"));
  });

  it("does not pad < 4 digit input (avoids overly-broad scans)", () => {
    const c3 = buildPhoneSearchCandidates("956");
    assert.ok(c3.includes("956"));
    assert.ok(!c3.includes("1956"));
    assert.ok(!c3.includes("52956"));
  });

  it("returns empty for empty input", () => {
    assert.deepEqual(buildPhoneSearchCandidates(""), []);
    assert.deepEqual(buildPhoneSearchCandidates(null), []);
  });

  it("strips MX 521 cellular leading", () => {
    const candidates = buildPhoneSearchCandidates("5218991054670");
    assert.ok(candidates.includes("8991054670"));
    assert.ok(candidates.includes("528991054670"));
  });
});

describe("addDaysToIsoDate", () => {
  it("advances calendar dates correctly across DST", () => {
    // US spring-forward 2026 (Sun Mar 8)
    assert.equal(addDaysToIsoDate("2026-03-07", 1), "2026-03-08");
    assert.equal(addDaysToIsoDate("2026-03-08", 1), "2026-03-09");
    // US fall-back 2026 (Sun Nov 1)
    assert.equal(addDaysToIsoDate("2026-10-31", 1), "2026-11-01");
    assert.equal(addDaysToIsoDate("2026-11-01", 1), "2026-11-02");
  });

  it("handles negative days (subtraction)", () => {
    assert.equal(addDaysToIsoDate("2026-03-09", -1), "2026-03-08");
    assert.equal(addDaysToIsoDate("2026-01-01", -1), "2025-12-31");
  });

  it("handles year boundaries", () => {
    assert.equal(addDaysToIsoDate("2026-12-31", 1), "2027-01-01");
  });

  it("handles 30-day jumps", () => {
    assert.equal(addDaysToIsoDate("2026-01-15", 30), "2026-02-14");
  });

  it("returns the input untouched for malformed dates", () => {
    assert.equal(addDaysToIsoDate("not-a-date", 1), "not-a-date");
    assert.equal(addDaysToIsoDate("", 1), "");
  });

  it("treats missing days as 0", () => {
    assert.equal(addDaysToIsoDate("2026-05-09"), "2026-05-09");
  });
});

describe("toMinorUnits / toMajorUnits / roundToCents", () => {
  it("toMinorUnits dodges the 10.005 float trap", () => {
    assert.equal(toMinorUnits(10.005), 1001);
    assert.equal(toMinorUnits(10.004), 1000);
    assert.equal(toMinorUnits(10.0), 1000);
  });

  it("toMinorUnits handles 0.1 + 0.2 cleanly", () => {
    assert.equal(toMinorUnits(0.1 + 0.2), 30);
  });

  it("toMinorUnits handles common round amounts", () => {
    assert.equal(toMinorUnits(50), 5000);
    assert.equal(toMinorUnits(125.99), 12599);
  });

  it("toMinorUnits returns 0 for non-numeric", () => {
    assert.equal(toMinorUnits(NaN), 0);
    assert.equal(toMinorUnits(Infinity), 0);
    assert.equal(toMinorUnits("abc"), 0);
  });

  it("toMajorUnits round-trips integer cents", () => {
    assert.equal(toMajorUnits(1001), 10.01);
    assert.equal(toMajorUnits(0), 0);
    assert.equal(toMajorUnits(12599), 125.99);
  });

  it("roundToCents trims float noise", () => {
    assert.equal(roundToCents(0.1 + 0.2), 0.3);
    assert.equal(roundToCents(10.005), 10.01);
    assert.equal(roundToCents(NaN), 0);
  });
});

describe("getBody", () => {
  it("returns null for empty body", () => {
    assert.equal(getBody({ body: "" }), null);
    assert.equal(getBody({ body: null }), null);
    assert.equal(getBody({ body: "   " }), null);
  });

  it("parses valid JSON", () => {
    assert.deepEqual(getBody({ body: '{"a":1}' }), { a: 1 });
  });

  it("decodes base64-encoded JSON", () => {
    const b64 = Buffer.from('{"b":2}').toString("base64");
    assert.deepEqual(getBody({ body: b64, isBase64Encoded: true }), { b: 2 });
  });

  it("throws 400 on malformed JSON", () => {
    assert.throws(
      () => getBody({ body: "{a:" }),
      (err) => err?.statusCode === 400
    );
  });
});

describe("httpError + nowEpoch + requiredEnv", () => {
  it("httpError attaches statusCode", () => {
    const err = httpError(409, "conflict");
    assert.equal(err.message, "conflict");
    assert.equal(err.statusCode, 409);
    assert.ok(err instanceof Error);
  });

  it("nowEpoch returns current Unix seconds", () => {
    const before = Math.floor(Date.now() / 1000);
    const got = nowEpoch();
    const after = Math.floor(Date.now() / 1000);
    assert.ok(got >= before && got <= after);
  });

  it("requiredEnv passes through when value is set", () => {
    assert.equal(requiredEnv("FOO", "bar"), "bar");
  });

  it("requiredEnv throws 500 when value is empty", () => {
    assert.throws(
      () => requiredEnv("FOO", ""),
      (err) => err?.statusCode === 500 && /FOO/.test(err.message)
    );
    assert.throws(
      () => requiredEnv("FOO", null),
      (err) => err?.statusCode === 500
    );
    assert.throws(
      () => requiredEnv("FOO", undefined),
      (err) => err?.statusCode === 500
    );
  });
});

describe("normalizeNameForSearch", () => {
  it("lowercases", () => {
    assert.equal(normalizeNameForSearch("JULIO"), "julio");
    assert.equal(normalizeNameForSearch("Julio Torres"), "julio torres");
  });
  it("strips diacritics: á → a, ñ → n, ó → o, í → i, é → e, ü → u", () => {
    assert.equal(normalizeNameForSearch("Julián"), "julian");
    assert.equal(normalizeNameForSearch("Núñez"), "nunez");
    assert.equal(normalizeNameForSearch("José Hernández"), "jose hernandez");
    assert.equal(normalizeNameForSearch("Müller"), "muller");
  });
  it("collapses internal whitespace + trims", () => {
    assert.equal(normalizeNameForSearch("  Julio   Torres  "), "julio torres");
    assert.equal(normalizeNameForSearch("\tJulio\n"), "julio");
  });
  it("returns empty string for null / undefined / non-string", () => {
    assert.equal(normalizeNameForSearch(null), "");
    assert.equal(normalizeNameForSearch(undefined), "");
    assert.equal(normalizeNameForSearch(""), "");
    assert.equal(normalizeNameForSearch(123), "123");
  });
});

describe("safeStringEquals", () => {
  it("matches identical non-empty strings", () => {
    assert.equal(safeStringEquals("abc", "abc"), true);
    assert.equal(safeStringEquals("a".repeat(64), "a".repeat(64)), true);
  });
  it("rejects mismatched same-length strings", () => {
    assert.equal(safeStringEquals("abc", "abd"), false);
  });
  it("rejects different-length inputs (instead of throwing)", () => {
    assert.equal(safeStringEquals("abc", "abcd"), false);
    assert.equal(safeStringEquals("longer", "x"), false);
  });
  it("rejects empty inputs on either side", () => {
    assert.equal(safeStringEquals("", ""), false);
    assert.equal(safeStringEquals("abc", ""), false);
    assert.equal(safeStringEquals("", "abc"), false);
  });
  it("rejects non-string inputs", () => {
    assert.equal(safeStringEquals(null, "abc"), false);
    assert.equal(safeStringEquals("abc", undefined), false);
    assert.equal(safeStringEquals(123, "123"), false);
  });
});
