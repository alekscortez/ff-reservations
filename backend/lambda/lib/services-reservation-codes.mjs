// Human-readable confirmation code + URL slug helpers for reservations.
//
// Two distinct shortened identifiers per reservation:
//
// 1. confirmationCode (6 chars, alphabet excludes 0/O/1/I/L) — readable
//    over the phone, fits on a receipt as "Booking #FF-XXXXXX". 31^6 ≈
//    887M combinations, plenty for our scale + safe to brute-force
//    against because the code only routes; the actual auth credential
//    is still the 256-bit customerToken on the reservation row.
//
// 2. publicSlug (16 chars, base62) — used as the SMS/WhatsApp short URL.
//    GET /p/{slug} looks the slug up and 302s to the canonical
//    /r/{reservationId}?t={customerToken}&eventDate=YYYY-MM-DD URL.
//    62^16 ≈ 4.8e28 combinations, ~95 bits of entropy — comparable to
//    a UUID for collision resistance and brute-force.
//
// Storage: lookup rows live in RES_TABLE under PK="CODE" / PK="SLUG"
// so they're in the same physical table as reservations but in their
// own partitions. Each lookup row carries the reservationId, eventDate,
// and (slug only) customerToken so /p/{slug} can build the redirect
// URL without a second DDB hit on the reservation.
//
// Generators use crypto.randomBytes — bias from `byte % alphabet.length`
// is negligible because alphabet sizes are reasonably close to a power
// of 2 (31 vs 32, 62 vs 64). Caller-supplied randomBytes makes it
// testable.

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars
const CODE_LENGTH = 6;
const SLUG_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; // 62 chars
const SLUG_LENGTH = 16;

const CODE_REGEX = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const SLUG_REGEX = new RegExp(`^[${SLUG_ALPHABET}]{${SLUG_LENGTH}}$`);

export function generateConfirmationCode(randomBytesFn) {
  const bytes = randomBytesFn(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

export function generatePublicSlug(randomBytesFn) {
  const bytes = randomBytesFn(SLUG_LENGTH);
  let slug = "";
  for (let i = 0; i < SLUG_LENGTH; i += 1) {
    slug += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return slug;
}

export function isValidConfirmationCode(value) {
  return typeof value === "string" && CODE_REGEX.test(value);
}

export function isValidPublicSlug(value) {
  return typeof value === "string" && SLUG_REGEX.test(value);
}

// Pull a confirmation code out of a free-form string. Matches:
// - "FF-XXXXXX" (preferred, with prefix to disambiguate)
// - Bare "XXXXXX" only if it's the whole string (anchored)
// Returns the code in canonical form (uppercased) or null.
export function extractConfirmationCodeFromText(textRaw) {
  const text = String(textRaw ?? "").trim();
  if (!text) return null;
  const prefixed = text.match(
    new RegExp(`FF-([${CODE_ALPHABET}]{${CODE_LENGTH}})`, "i")
  );
  if (prefixed) return prefixed[1].toUpperCase();
  const upper = text.toUpperCase();
  if (CODE_REGEX.test(upper)) return upper;
  return null;
}

export function buildCodeLookupKey(code) {
  return { PK: "CODE", SK: `CODE#${code}` };
}

export function buildSlugLookupKey(slug) {
  return { PK: "SLUG", SK: `SLUG#${slug}` };
}

// Format the customer-facing confirmation reference for receipts / UI.
// "FF-K7M3X2" — prefix anchors it as a Famoso Fuego booking + helps
// disambiguate when search/parsers see the code in free-form text.
export function formatPublicConfirmationCode(code) {
  const value = String(code ?? "").trim().toUpperCase();
  if (!CODE_REGEX.test(value)) return "";
  return `FF-${value}`;
}
