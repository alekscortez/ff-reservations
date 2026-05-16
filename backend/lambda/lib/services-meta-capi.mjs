// Meta Conversions API (CAPI) — server-side companion to the browser
// Pixel. Sends the same funnel events Meta's algorithm needs to
// optimize the ad, but from Lambda so it survives ad-blockers, ITP,
// and the 30-50% of mobile sessions where the Pixel never loads.
//
// Layered design:
// - This module owns the wire format: builds the JSON payload for
//   POST {graph_api}/{pixel_id}/events, hashes PII per Meta's spec,
//   handles retry on 5xx + transient network errors.
// - Callers (telemetry handler, Square webhook) decide WHEN events
//   fire and WHICH user_data fields they have available.
// - Graceful no-op when META_PIXEL_ID + META_CAPI_TOKEN_SECRET_ARN
//   are unconfigured — lets us ship the wiring before the user has
//   created the Pixel in Events Manager.
//
// Pinned to **Graph API v23.0** (released 2025; valid through ~late
// 2027). Meta deprecates Graph API versions on a rolling 2-year
// window — re-check the changelog before bumping past v25.
//
// Reference docs (verified May 2026):
// - https://developers.facebook.com/docs/marketing-api/conversions-api/get-started/
// - https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
// - https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc

import { createHash } from "node:crypto";

const GRAPH_API_VERSION = "v23.0";
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_RETRIES = 2; // total 3 attempts including the initial

// Per Meta spec: lowercase + trimmed + SHA-256 hex. Email gets normalized
// (trim + lowercase); phone gets digits-only (strip + and any separators).
// These are the two highest-value identifiers for Event Match Quality.
function hashEmail(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  return createHash("sha256").update(s).digest("hex");
}
function hashPhone(raw) {
  // E.164 minus the leading "+" — Meta wants digits only.
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return createHash("sha256").update(digits).digest("hex");
}
function hashGeneric(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  return createHash("sha256").update(s).digest("hex");
}

// Build the `user_data` block. Hashed fields go in as-is; unhashed
// fields (fbc, fbp, client_ip_address, client_user_agent) go in plain
// per Meta's spec. external_id is hashed (recommended ≥ v18).
function buildUserData({
  email,
  phone,
  fbc,
  fbp,
  clientIp,
  clientUserAgent,
  externalId,
}) {
  const out = {};
  const em = hashEmail(email);
  if (em) out.em = [em];
  const ph = hashPhone(phone);
  if (ph) out.ph = [ph];
  if (fbc) out.fbc = String(fbc).trim() || undefined;
  if (fbp) out.fbp = String(fbp).trim() || undefined;
  if (clientIp) out.client_ip_address = String(clientIp).trim();
  if (clientUserAgent) out.client_user_agent = String(clientUserAgent).slice(0, 1000);
  const eid = hashGeneric(externalId);
  if (eid) out.external_id = [eid];
  // Strip undefined keys so we don't ship "key: undefined" pairs.
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export function createMetaCapiService({
  env,
  secretClient,
  nowEpoch,
  fetchImpl = globalThis.fetch,
}) {
  const pixelId = String(env?.META_PIXEL_ID ?? "").trim();
  const secretArn = String(env?.META_CAPI_TOKEN_SECRET_ARN ?? "").trim();
  // Optional: when set, events go to Meta's "Test Events" tab in Events
  // Manager instead of production attribution. Use during the bring-up
  // week to verify dedupe + EMQ without polluting real ad data.
  const testEventCode = String(env?.META_CAPI_TEST_EVENT_CODE ?? "").trim() || null;

  let cachedToken = null;

  function isEnabled() {
    return Boolean(pixelId && secretArn);
  }

  async function resolveAccessToken() {
    if (cachedToken) return cachedToken;
    if (!secretClient || typeof secretClient.send !== "function") {
      throw new Error("Meta CAPI secret client unavailable");
    }
    const { GetSecretValueCommand } = await import(
      "@aws-sdk/client-secrets-manager"
    );
    const result = await secretClient.send(
      new GetSecretValueCommand({ SecretId: secretArn })
    );
    const raw = String(result?.SecretString ?? "").trim();
    if (!raw) throw new Error("Meta CAPI secret is empty");
    // Accept either a raw token string OR a JSON object with a
    // `token` field — keeps Secrets Manager flexible.
    let token = raw;
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        token = String(parsed?.token ?? parsed?.access_token ?? "").trim();
      } catch {
        // fall through with raw
      }
    }
    if (!token) throw new Error("Meta CAPI secret missing token field");
    cachedToken = token;
    return token;
  }

  // Fire a single event to Meta. Throws on persistent failure so the
  // caller can warn-log it; callers should always wrap in try/catch so
  // CAPI failures never break the user flow.
  //
  // event: { event_name, event_id, event_time?, event_source_url?,
  //          user_data, custom_data?, action_source? }
  async function sendEvent(event) {
    if (!isEnabled()) return { skipped: true, reason: "not_configured" };
    const eventName = String(event?.event_name ?? "").trim();
    const eventId = String(event?.event_id ?? "").trim();
    if (!eventName) throw new Error("event_name is required");
    if (!eventId) throw new Error("event_id is required (dedup key)");

    const token = await resolveAccessToken();
    const payload = {
      data: [
        {
          event_name: eventName,
          event_time:
            Number.isFinite(event?.event_time) && event.event_time > 0
              ? Number(event.event_time)
              : nowEpoch(),
          event_id: eventId,
          // Per Meta: required field. "website" is correct for browser-
          // initiated funnels even when the event itself fires from
          // Lambda (the originating action was on our website).
          action_source: String(event?.action_source ?? "website"),
          ...(event?.event_source_url
            ? { event_source_url: String(event.event_source_url) }
            : {}),
          user_data: event?.user_data ?? {},
          ...(event?.custom_data
            ? { custom_data: event.custom_data }
            : {}),
        },
      ],
      ...(testEventCode ? { test_event_code: testEventCode } : {}),
    };

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(
      pixelId
    )}/events?access_token=${encodeURIComponent(token)}`;

    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      let permanentError = null;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = { rawBody: text };
        }
        if (res.ok) {
          return { ok: true, status: res.status, body, attempt };
        }
        // 4xx = caller bug (bad payload / invalid token / pixel ID
        // typo). Don't retry — surface immediately.
        if (res.status >= 400 && res.status < 500) {
          permanentError = new Error(
            `Meta CAPI ${res.status}: ${
              body?.error?.message ?? body?.error?.error_user_msg ?? text
            }`
          );
        } else {
          // 5xx = transient; record and retry.
          lastErr = new Error(`Meta CAPI ${res.status} (transient)`);
        }
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        // AbortError + network errors fall through to retry below.
      }
      if (permanentError) throw permanentError;
      if (attempt < MAX_RETRIES) {
        // Tiny backoff — Lambda's 15s timeout caps the total wait.
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error("Meta CAPI failed without error");
  }

  // Higher-level wrappers — one per funnel event type. Callers fill
  // in only what they have; missing user_data fields are simply
  // omitted and Meta's matching falls back to what's available.

  async function trackViewContent({
    eventId,
    eventSourceUrl,
    userData = {},
    contentName = "/reserva",
  }) {
    return sendEvent({
      event_name: "ViewContent",
      event_id: eventId,
      event_source_url: eventSourceUrl,
      user_data: buildUserData(userData),
      custom_data: { content_name: contentName, content_type: "product" },
    });
  }

  async function trackInitiateCheckout({
    eventId,
    eventSourceUrl,
    userData = {},
    value,
    currency = "USD",
  }) {
    return sendEvent({
      event_name: "InitiateCheckout",
      event_id: eventId,
      event_source_url: eventSourceUrl,
      user_data: buildUserData(userData),
      custom_data: {
        ...(Number.isFinite(value) ? { value: Number(value), currency } : {}),
      },
    });
  }

  async function trackPurchase({
    eventId,
    eventSourceUrl,
    userData = {},
    value,
    currency = "USD",
    contentIds,
    orderId,
  }) {
    return sendEvent({
      event_name: "Purchase",
      event_id: eventId,
      event_source_url: eventSourceUrl,
      user_data: buildUserData(userData),
      custom_data: {
        // Purchase REQUIRES value + currency per Meta spec.
        value: Number(value),
        currency,
        ...(Array.isArray(contentIds) && contentIds.length > 0
          ? { content_ids: contentIds, contents: contentIds.map((id) => ({ id, quantity: 1 })) }
          : {}),
        ...(orderId ? { order_id: String(orderId) } : {}),
      },
    });
  }

  return {
    isEnabled,
    sendEvent,
    trackViewContent,
    trackInitiateCheckout,
    trackPurchase,
    // exposed for tests
    _hashEmail: hashEmail,
    _hashPhone: hashPhone,
    _buildUserData: buildUserData,
    _GRAPH_API_VERSION: GRAPH_API_VERSION,
    _resetCacheForTests: () => {
      cachedToken = null;
    },
  };
}
