// Meta Pixel — browser side of Conversions API.
//
// Two responsibilities:
// 1. Inject Meta's fbevents.js snippet on first init() call. The
//    snippet is the standard one from developers.facebook.com — we
//    don't reach for GTM, MTM, or any other tag-manager wrapper.
// 2. Expose typed wrappers around fbq('track', ...) so the funnel
//    sites (availability page, reserve modal) call
//    `pixel.trackViewContent({ eventId })` instead of touching the
//    global fbq function directly.
//
// Dedup contract: every Pixel event carries an `eventID` that the BE
// CAPI service uses as `event_id`. Same ID on both sides → Meta
// merges them in Events Manager and the visit/conversion only counts
// once for attribution + EMQ.
//
// Cookie reads: `_fbp` is always set by fbevents.js. `_fbc` only
// when the landing URL had `?fbclid=...`. Both are exposed here for
// the booking flow to attach to the BE telemetry/booking payloads so
// the CAPI side has fbc/fbp for matching.
//
// Graceful no-op: when APP_CONFIG.metaPixelId is empty, every method
// short-circuits without loading the script — lets the app ship
// before the Pixel exists in Events Manager.

import { Injectable } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & {
      callMethod?: (...args: unknown[]) => void;
      queue?: unknown[];
      push?: (...args: unknown[]) => unknown;
      loaded?: boolean;
      version?: string;
    };
    _fbq?: Window['fbq'];
  }
}

export interface PixelUserData {
  // Customer's first-party identifiers for Advanced Matching.
  // Pixel hashes these in the browser before sending — we pass plain.
  email?: string;
  phone?: string;
}

@Injectable({ providedIn: 'root' })
export class MetaPixelService {
  private initialized = false;

  isEnabled(): boolean {
    return Boolean(APP_CONFIG.metaPixelId);
  }

  // Idempotent. Safe to call on every navigation; the snippet is
  // injected once and subsequent calls just queue events via fbq.
  init(): void {
    if (!this.isEnabled() || this.initialized) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    try {
      this.injectSnippet();
      window.fbq?.('init', APP_CONFIG.metaPixelId);
      // PageView fires automatically on init per Meta's docs — they
      // tail-call it in the standard snippet. We also explicitly call
      // it here so route changes in the SPA register if we later wire
      // per-route Pixel events.
      window.fbq?.('track', 'PageView');
      this.initialized = true;
    } catch {
      // Pixel must never break the app.
    }
  }

  // Customer landed on /reserva (or refreshed it). eventId MUST match
  // what the BE telemetry handler forwards to CAPI for dedup.
  trackViewContent(eventId: string, userData: PixelUserData = {}): void {
    this.track('ViewContent', eventId, userData, {
      content_name: '/reserva',
      content_type: 'product',
    });
  }

  // Customer pressed "Confirm" and we're about to redirect to Square.
  trackInitiateCheckout(
    eventId: string,
    value: number | null,
    userData: PixelUserData = {}
  ): void {
    const customData: Record<string, unknown> = {};
    if (Number.isFinite(value) && (value as number) > 0) {
      customData['value'] = Number(value);
      customData['currency'] = 'USD';
    }
    this.track('InitiateCheckout', eventId, userData, customData);
  }

  // Read the Pixel-set cookies so the booking flow can attach them to
  // the BE payload for CAPI matching. Returns nulls if Pixel hasn't
  // run yet or the cookies are absent.
  readMatchingCookies(): { fbp: string | null; fbc: string | null } {
    if (typeof document === 'undefined') return { fbp: null, fbc: null };
    try {
      const parsed: Record<string, string> = {};
      for (const part of (document.cookie || '').split(';')) {
        const [rawKey, ...rest] = part.split('=');
        const key = (rawKey ?? '').trim();
        if (!key) continue;
        parsed[key] = decodeURIComponent((rest.join('=') ?? '').trim());
      }
      return {
        fbp: parsed['_fbp'] || null,
        fbc: parsed['_fbc'] || null,
      };
    } catch {
      return { fbp: null, fbc: null };
    }
  }

  private track(
    eventName: string,
    eventId: string,
    userData: PixelUserData,
    customData: Record<string, unknown>
  ): void {
    if (!this.isEnabled()) return;
    if (typeof window === 'undefined') return;
    try {
      if (!this.initialized) this.init();
      // Advanced Matching — set per-event so we don't leak PII when
      // the customer hasn't typed anything yet.
      const matching: Record<string, string> = {};
      if (userData?.email) matching['em'] = String(userData.email).trim().toLowerCase();
      if (userData?.phone)
        matching['ph'] = String(userData.phone).replace(/\D/g, '');
      if (Object.keys(matching).length > 0) {
        window.fbq?.('set', 'autoConfig', false, APP_CONFIG.metaPixelId);
        window.fbq?.('init', APP_CONFIG.metaPixelId, matching);
      }
      // Meta's fbq accepts a 4th arg { eventID } for dedup.
      window.fbq?.('track', eventName, customData, { eventID: eventId });
    } catch {
      // never throw
    }
  }

  // The canonical fbevents.js snippet from
  // https://developers.facebook.com/docs/meta-pixel/get-started/
  // — kept untouched here so anyone Meta-debugging the page can
  // grep-match it against their docs.
  private injectSnippet(): void {
    if (window.fbq) return;
    /* eslint-disable */
    (function (f: any, b: any, e: string, v: string) {
      let n: any, t: any, s: any;
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod
          ? n.callMethod.apply(n, arguments)
          : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = '2.0';
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
  }
}
