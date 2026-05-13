// Pure helpers extracted from services-square-payments.mjs so they can
// be unit-tested without instantiating the full factory (which needs a
// SecretsManager client + fetch + env). All functions here have zero
// dependencies on Lambda env, AWS SDK clients, or `this`/closure state.
//
// What's deliberately NOT here
// - toAmountMoney + parseSecretPayload — they call `httpError(...)`
//   from the closure, so they need the factory's deps. Tested via
//   factory instantiation (or left for now).
// - resolveWebhookReplayWindowSeconds + the replay-window evaluator
//   that depends on it — they read from env. Same story.

import { createHmac, timingSafeEqual } from "crypto";
import { toMajorUnits } from "./core-utils.mjs";

export const DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS = 10 * 60;
export const MAX_FUTURE_CLOCK_SKEW_SECONDS = 2 * 60;

export function resolveSquareApiBaseUrl(squareEnv) {
  return squareEnv === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

export function parseBooleanEnv(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export function toSquareBuyerPhone(phone) {
  const raw = String(phone ?? "").trim();
  if (!raw) return null;
  // Square expects E.164 formatted phone numbers.
  if (!/^\+[1-9]\d{7,14}$/.test(raw)) return null;
  return raw;
}

export function formatEventDateForLabel(eventDate) {
  const raw = String(eventDate ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  const [, yyyy, mm, dd] = match;
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const dateUtc = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  const weekday = weekdayNames[dateUtc.getUTCDay()] ?? "";
  const monthIndex = Number(mm) - 1;
  const month = monthNames[monthIndex] ?? mm;
  return `${weekday}, ${month} ${Number(dd)}, ${yyyy}`;
}

export function parseJsonPayload(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export function parseSquareErrorMessage(payload, fallback) {
  return (
    payload?.errors?.[0]?.detail ||
    payload?.errors?.[0]?.code ||
    fallback
  );
}

export function normalizeWebhookUrl(url) {
  return String(url ?? "").trim();
}

export function addWebhookUrlCandidates(set, url) {
  const normalized = normalizeWebhookUrl(url);
  if (!normalized) return;
  set.add(normalized);
  if (normalized.endsWith("/")) {
    set.add(normalized.slice(0, -1));
  } else {
    set.add(`${normalized}/`);
  }
}

export function signaturesEqual(a, b) {
  const left = Buffer.from(String(a ?? "").trim(), "utf8");
  const right = Buffer.from(String(b ?? "").trim(), "utf8");
  if (!left.length || !right.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function buildSquareSignature({ signatureKey, notificationUrl, rawBody }) {
  return createHmac("sha256", signatureKey)
    .update(`${notificationUrl}${rawBody}`, "utf8")
    .digest("base64");
}

export function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value ?? "").trim()
  );
}

export function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim());
}

export function extractReservationFromNote(noteRaw) {
  const note = String(noteRaw ?? "").trim();
  if (!note) return null;
  // Accept both "Reservation <id> · <date>" (legacy operator-internal
  // wording) and "Booking <id> • <date>" (current customer-friendly
  // wording) so payments still in flight when the receipt copy
  // changed continue to land on the right reservation. Separator
  // class accepts middle-dot, bullet, hyphen, or pipe.
  const match = note.match(
    /(?:reservation|booking)\s+([0-9a-fA-F-]{36})\s*[·•\-|]\s*(\d{4}-\d{2}-\d{2})/i
  );
  if (!match) return null;
  const reservationId = String(match[1] ?? "").trim();
  const eventDate = String(match[2] ?? "").trim();
  if (!isUuidLike(reservationId) || !isIsoDate(eventDate)) return null;
  return { reservationId, eventDate };
}

// Pull a confirmation code (e.g. K7M3X2) out of a free-form string.
// Mirror of services-reservation-codes:extractConfirmationCodeFromText
// but pure-fn-only so this module stays test-light. Matches the
// "FF-XXXXXX" prefix form because customers may also paste a bare
// code into a contact form and we'd want to recognize that elsewhere.
const CODE_ALPHABET_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const FF_CODE_REGEX = new RegExp(
  `FF-([${CODE_ALPHABET_CHARS}]{6})`,
  "i"
);

export function extractConfirmationCodeFromText(textRaw) {
  const text = String(textRaw ?? "").trim();
  if (!text) return null;
  const match = text.match(FF_CODE_REGEX);
  return match ? match[1].toUpperCase() : null;
}

// Extract a reservation reference from a Square payment, in priority order:
//   1. payment.metadata.reservationId + eventDate (preferred shape)
//   2. confirmationCode in payment.note ("Booking #FF-XXXXXX") — callers
//      must follow up with a DDB lookup against PK="CODE" to resolve
//      reservationId + eventDate. We return `{ confirmationCode }` so the
//      caller can distinguish from a direct hit.
//   3. UUID in payment.note ("Booking <uuid> · <date>", legacy) — direct.
//   4. payment.reference_id + metadata.eventDate fallback.
//
// Returns one of:
//   { reservationId, eventDate }  — caller can use directly
//   { confirmationCode }          — caller must look up
//   null                          — no reference found
export function extractReservationRefFromPayment(payment) {
  const metadata =
    payment?.metadata && typeof payment.metadata === "object" ? payment.metadata : {};
  const mdReservationId = String(metadata?.reservationId ?? "").trim();
  const mdEventDate = String(metadata?.eventDate ?? "").trim();
  if (isUuidLike(mdReservationId) && isIsoDate(mdEventDate)) {
    return { reservationId: mdReservationId, eventDate: mdEventDate };
  }

  const codeFromNote = extractConfirmationCodeFromText(payment?.note);
  if (codeFromNote) {
    return { confirmationCode: codeFromNote };
  }

  const noteRef = extractReservationFromNote(payment?.note);
  if (noteRef) return noteRef;

  const referenceId = String(payment?.reference_id ?? "").trim();
  if (isUuidLike(referenceId) && isIsoDate(mdEventDate)) {
    return { reservationId: referenceId, eventDate: mdEventDate };
  }

  return null;
}

export function toMajorAmount(amountMinor) {
  const minor = Number(amountMinor ?? 0);
  if (!Number.isFinite(minor) || minor <= 0) return 0;
  return toMajorUnits(minor);
}

// Pure version of evaluateWebhookReplayWindow — caller passes in the
// resolved replay-window seconds instead of reading from env.
export function evaluateWebhookReplayWindowPure({
  webhookCreatedAt,
  replayWindowSeconds,
  nowMs = Date.now(),
}) {
  const createdAtRaw = String(webhookCreatedAt ?? "").trim();
  if (!createdAtRaw) {
    return { ok: false, reason: "missing_created_at", replayWindowSeconds };
  }
  const createdAtMs = Date.parse(createdAtRaw);
  if (!Number.isFinite(createdAtMs)) {
    return { ok: false, reason: "invalid_created_at", replayWindowSeconds };
  }
  const ageSeconds = Math.floor((nowMs - createdAtMs) / 1000);
  if (ageSeconds > replayWindowSeconds) {
    return {
      ok: false,
      reason: "outside_replay_window",
      replayWindowSeconds,
      ageSeconds,
    };
  }
  if (ageSeconds < -MAX_FUTURE_CLOCK_SKEW_SECONDS) {
    return {
      ok: false,
      reason: "created_at_in_future",
      replayWindowSeconds,
      ageSeconds,
    };
  }
  return { ok: true, replayWindowSeconds, ageSeconds };
}
