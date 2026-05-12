export function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function noContent(statusCode = 204, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...extraHeaders },
    body: "",
  };
}

// Distinguish "no body" (returns null — caller decides if that's a 400)
// from "malformed JSON" (throws 400 here so we don't conflate the two).
// Previously both returned null and route handlers couldn't tell.
export function getBody(event) {
  if (!event.body) return null;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : String(event.body);
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

export function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

// Currency helpers. All money in app code is dollars (number, 2 decimals);
// Square API expects minor units. Naive `Math.round(n * 100)` hits the
// classic float trap (e.g. `10.005 * 100` = 1000.4999...). Routing through
// a base-10 exponent string sidesteps it: `Number("10.005e2")` parses to
// 1000.5 exactly, which Math.round handles correctly.
//
// All call sites validate the amount is > 0 before reaching these, so the
// half-toward-positive-infinity behavior of Math.round on negatives doesn't
// matter in practice. If that ever changes, switch to half-away-from-zero.
export function toMinorUnits(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Number(`${n}e2`));
}

export function toMajorUnits(minorAmount) {
  const n = Number(minorAmount);
  if (!Number.isFinite(n)) return 0;
  return Number((n / 100).toFixed(2));
}

export function roundToCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

const SUPPORTED_PHONE_COUNTRIES = new Set(["US", "MX"]);

export function normalizePhoneCountry(country) {
  const value = String(country ?? "").trim().toUpperCase();
  return SUPPORTED_PHONE_COUNTRIES.has(value) ? value : "US";
}

function parseInternationalDigitsToE164(digitsOnly) {
  const digits = String(digitsOnly ?? "").replace(/\D/g, "");
  if (!digits) return "";

  if (digits.startsWith("1")) {
    const national = digits.slice(1);
    if (national.length === 10) return `+1${national}`;
    return "";
  }

  if (digits.startsWith("52")) {
    const national = digits.slice(2);
    if (national.length === 10) return `+52${national}`;
    if (national.length === 11 && national.startsWith("1")) return `+52${national.slice(1)}`;
    return "";
  }

  return "";
}

function parseNationalDigitsToE164(digitsOnly, countryHint) {
  const digits = String(digitsOnly ?? "").replace(/\D/g, "");
  if (!digits) return "";

  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith("521")) return `+52${digits.slice(3)}`;

  const country = normalizePhoneCountry(countryHint);
  if (digits.length !== 10) return "";
  if (country === "MX") return `+52${digits}`;
  return `+1${digits}`;
}

export function normalizePhoneE164(phone, countryHint = "US") {
  const raw = String(phone ?? "").trim();
  if (!raw) return "";

  let cleaned = raw.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("00")) cleaned = `+${cleaned.slice(2)}`;

  if (cleaned.startsWith("+")) {
    return parseInternationalDigitsToE164(cleaned.slice(1));
  }

  return parseNationalDigitsToE164(cleaned, countryHint);
}

export function detectPhoneCountryFromE164(phone) {
  const e164 = normalizePhoneE164(phone);
  if (e164.startsWith("+52")) return "MX";
  if (e164.startsWith("+1")) return "US";
  return null;
}

export function normalizePhone(phone, countryHint = "US") {
  const e164 = normalizePhoneE164(phone, countryHint);
  return e164 ? e164.replace(/\D/g, "") : "";
}

export function buildPhoneSearchCandidates(phone, countryHint = "US") {
  const raw = String(phone ?? "").trim();
  if (!raw) return [];

  const digits = raw.replace(/\D/g, "");
  if (!digits) return [];

  const set = new Set();
  set.add(digits);

  const normalizedDigits = normalizePhone(raw, countryHint);
  if (normalizedDigits) set.add(normalizedDigits);

  // For partial-prefix searches (4-9 digits) and full national 10-digit input,
  // also try the +1 (US/CA) and +52 (MX) country-code-prefixed forms — that's
  // how rows are stored in DDB (PHONE#1XXXXXXXXXX or PHONE#52XXXXXXXXXX).
  // Without this, typing "956" finds nothing because we only query for
  // begins_with(PHONE#956) when the actual SK starts with PHONE#1956.
  if (digits.length >= 4 && digits.length <= 10) {
    set.add(`1${digits}`);
    set.add(`52${digits}`);
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    set.add(digits.slice(1));
  }
  if (digits.length === 12 && digits.startsWith("52")) {
    set.add(digits.slice(2));
  }
  if (digits.length === 13 && digits.startsWith("521")) {
    set.add(digits.slice(3));
    set.add(`52${digits.slice(3)}`);
  }

  return [...set].filter(Boolean);
}

// Lowercase, accent-stripped, whitespace-normalized form for substring search
// across customer-typed name input. "Júlián  García " → "julian garcia"
export function normalizeNameForSearch(name) {
  if (name === null || name === undefined) return "";
  return String(name)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function addDaysToIsoDate(dateStr, days) {
  const parts = String(dateStr ?? "").split("-").map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return dateStr;
  const [year, month, day] = parts;
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function requiredEnv(name, value) {
  if (!value) throw httpError(500, `Missing env var ${name}`);
  return value;
}
