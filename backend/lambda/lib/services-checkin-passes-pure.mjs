// Pure helpers extracted from services-checkin-passes.mjs so they can
// be unit-tested without instantiating the full factory (which needs
// a DDB client + env). All functions here are stateless and have no
// dependency on env, randomUUID, nowEpoch, or `this`.
//
// What stays in the factory closure
// - resolvePassTtlDays / resolvePassExpiryEpoch (env-dependent)
// - generateToken (uses randomUUID dep)
// - buildPassUrl / resolvePassBaseUrl (env-dependent — but the URL math
//   is exposed here as buildPassUrlFromBaseUrl so it can be tested)
// - toPassResponse (calls buildPassUrl from the closure)

import { createHash } from "crypto";

export function normalizeTokenInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^ffr-checkin:/i.test(raw)) {
    return raw.replace(/^ffr-checkin:/i, "").trim();
  }

  if (!raw.includes("://")) {
    const match = raw.match(/(?:^|[?&])token=([^&]+)/i);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
    return raw;
  }

  try {
    const parsed = new URL(raw);
    const queryToken = String(parsed.searchParams.get("token") ?? "").trim();
    return queryToken || raw;
  } catch {
    return raw;
  }
}

export function hashToken(token) {
  return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

export function sanitizeHistoryValue(value) {
  if (value === null) return null;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeHistoryValue(item))
      .filter((item) => item !== undefined);
  }
  if (valueType === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = sanitizeHistoryValue(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return undefined;
}

export function toHistorySk(reservationId, at, eventId) {
  const ts = String(Number(at ?? 0) || 0).padStart(12, "0");
  return `HIST#${reservationId}#${ts}#${eventId}`;
}

export function isPassActive(item, now) {
  if (!item) return false;
  if (String(item.status ?? "").toUpperCase() !== "ISSUED") return false;
  const expiresAt = Number(item.expiresAt ?? 0);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

// Returns a copy of `item` with status flipped to EXPIRED if the pass
// is past its expiry. The DB row itself isn't updated until the next
// scan or a deliberate revoke/expire transition.
export function normalizePassForRead(item, now) {
  if (!item) return null;
  const status = String(item.status ?? "").toUpperCase();
  const expiresAt = Number(item.expiresAt ?? 0);
  if (
    status === "ISSUED" &&
    Number.isFinite(expiresAt) &&
    expiresAt > 0 &&
    expiresAt <= now
  ) {
    return { ...item, status: "EXPIRED" };
  }
  return item;
}

// Pure URL builder for check-in pass links. Three branches:
// 1. baseUrl contains "{token}" → template substitution
// 2. baseUrl is a parseable URL → set ?token=... via URL.searchParams
// 3. baseUrl is a non-URL string → append ?token= or &token= depending
//    on whether ? is already present
// Returns null when baseUrl is empty (caller decides whether that's an
// error or a "no link" state).
export function buildPassUrlFromBaseUrl(baseUrl, token) {
  if (!baseUrl) return null;

  if (baseUrl.includes("{token}")) {
    return baseUrl.replace("{token}", encodeURIComponent(token));
  }

  try {
    const parsed = new URL(baseUrl);
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    const joiner = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${joiner}token=${encodeURIComponent(token)}`;
  }
}
