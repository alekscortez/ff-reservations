import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client';
import { getAttribution } from '../analytics/attribution';

// Whitelisted event names. The backend keeps the same list at
// routes-public-bookings.mjs (POST /public/telemetry handler) — adding a
// new event here without adding it to the backend whitelist results in a
// silent 204 with the event dropped.
//
// The funnel mirrors the backend's emitFunnel (`public_booking_event`):
//   map_loaded → modal_opened → modal_submitted → modal_redirect_to_square
//                                    ↓
//                       (backend created event)
//                                    ↓
//                       (Square checkout — invisible to us)
//                                    ↓
//                       r_page_loaded → r_status_paid_seen
//
// Read both halves together with one CW Insights query:
//   filter @message like "_funnel_event"
//   | stats count() by event
export type TelemetryEvent =
  | 'map_loaded'
  | 'map_pending_hold_seen'
  | 'modal_opened'
  | 'modal_validation_error'
  | 'modal_submitted'
  | 'modal_active_hold_recovery_shown'
  | 'modal_active_hold_release_clicked'
  | 'modal_redirect_to_square'
  | 'pending_release_clicked'
  | 'pending_release_confirmed'
  | 'r_page_loaded'
  | 'r_status_paid_seen'
  | 'r_status_cancelled_seen'
  | 'r_release_clicked'
  | 'r_wallet_clicked'
  // Find-modal flow (Tier S, 2026-05-14). Tracks both Phone and
  // Booking-code lookup paths so we can compare which one customers
  // reach for + measure not-found rate per channel.
  | 'find_modal_opened'
  | 'find_modal_tab_changed'
  | 'find_by_phone_submitted'
  | 'find_by_phone_not_found'
  | 'find_by_phone_found'
  | 'find_by_code_submitted'
  | 'find_by_code_not_found'
  | 'find_by_code_found'
  // Staff auth-renew observability (2026-05-14). Lets us confirm in CW
  // that the visibility-driven refresh + interceptor 401 retry actually
  // fire in the field. `extra` carries source ('visibility' / 'focus' /
  // 'heartbeat' / 'event' / 'interceptor') + outcome ('ok' / 'error').
  | 'auth_renew_started'
  | 'auth_renew_succeeded'
  | 'auth_renew_failed'
  | 'auth_bootstrap_check'
  | 'auth_session_expired_redirect'
  // Phase 0 diagnostic (2026-05-14). Captures the raw Cognito response on
  // every request the OIDC library makes — /oauth2/token, /jwks.json,
  // /oauth2/userInfo, the authority discovery doc. The OIDC library wraps
  // the underlying HttpErrorResponse in `new Error(error)` before our
  // SessionWatcher sees it (status + error_description are destroyed), so
  // we observe at the HTTP layer instead.
  //
  // auth_cognito_observed → fires on success. Confirms the interceptor is
  //   wired and lets us see which Cognito URLs the library is hitting.
  //   `extra` carries: urlPath, status, method, elapsedMs.
  //
  // auth_cognito_token_error → fires on error (name kept for backwards
  //   compatibility — covers all Cognito errors, not just /oauth2/token).
  //   `extra` carries: urlPath, status, errorCode (Cognito's `error` field,
  //   e.g. invalid_grant), errorDescription, grantType, method, elapsedMs.
  | 'auth_cognito_observed'
  | 'auth_cognito_token_error'
  // Phase 1: direct /oauth2/token refresh that bypasses the OIDC library's
  // wipe-on-failure cascade. `source` lets us distinguish session-watcher
  // attempts ('direct') from bootstrap recovery attempts ('bootstrap').
  //
  // auth_shadow_refresh_* → the direct refresh client itself. Extras carry
  //   elapsedMs, attempts, and on failure status + errorCode + errorDescription.
  // auth_shadow_restored → the bootstrap recovery path detected the library's
  //   storage was wiped but the shadow vault held a refresh token; we used
  //   it to restore the session without a re-login. Extras: elapsedMs.
  | 'auth_shadow_refresh_started'
  | 'auth_shadow_refresh_succeeded'
  | 'auth_shadow_refresh_failed'
  | 'auth_shadow_restored'
  // Live-presence heartbeat (2026-05-15). Fired by /reserva every ~30s
  // while the tab is visible so the staff dashboard's "Live now" tile
  // can count active visitors. Pure presence signal — not part of the
  // funnel dashboard, just relayed to services-presence on the BE.
  | 'map_heartbeat';

interface TelemetryPayload {
  eventDate?: string | null;
  reservationId?: string | null;
  confirmationCode?: string | null;
  // Free-form extras. Stay JSON-serialisable. Avoid PII (no
  // phone/email/name) — sessionId is the join key for one customer's
  // journey, and the reservation row carries the human details.
  extra?: Record<string, unknown>;
}

const SESSION_KEY = 'ff-fe-session';

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

// Per-browser UUID. Persists across tabs/navs in localStorage; falls
// back to a per-page UUID if storage is unavailable (incognito etc.).
function readOrCreateSessionId(): string {
  const storage = safeStorage();
  if (!storage) {
    // No persistence — per-page id is still better than nothing for
    // grouping events within a single visit.
    return crypto.randomUUID();
  }
  try {
    const existing = storage.getItem(SESSION_KEY);
    if (existing && existing.length > 0) return existing;
    const fresh = crypto.randomUUID();
    storage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

@Injectable({ providedIn: 'root' })
export class TelemetryService {
  private api = inject(ApiClient);
  private sessionId: string | null = null;

  private getSessionId(): string {
    if (!this.sessionId) this.sessionId = readOrCreateSessionId();
    return this.sessionId;
  }

  // Fire-and-forget. Subscription is required for HttpClient to actually
  // execute the request; we discard both success + error so telemetry
  // never breaks the user flow. No await / no caller subscription —
  // callers just call and move on.
  fire(event: TelemetryEvent, payload: TelemetryPayload = {}): void {
    try {
      // Marketing attribution (Layer 2 — UTM capture). First-touch
      // snapshot from localStorage, auto-merged into every event's
      // `extra` so CloudWatch Insights can split funnel counts by
      // source (utm_source, fbclid, gclid). Null when the visitor
      // arrived with no tags — keeps payload size down for organic
      // traffic.
      const attribution = getAttribution();
      const extra = attribution
        ? { ...(payload.extra ?? {}), attribution }
        : payload.extra ?? null;

      this.api
        .post('/public/telemetry', {
          event,
          sessionId: this.getSessionId(),
          eventDate: payload.eventDate ?? null,
          reservationId: payload.reservationId ?? null,
          confirmationCode: payload.confirmationCode ?? null,
          extra,
        })
        .subscribe({
          next: () => undefined,
          error: () => undefined,
        });
    } catch {
      // Belt and suspenders.
    }
  }
}
