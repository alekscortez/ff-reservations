// Marketing attribution capture (Layer 2 — UTM tracking).
//
// Strategy: FIRST-TOUCH wins. The first time a customer lands on the
// site with utm_*/fbclid/gclid params we snapshot them into
// localStorage. Subsequent visits — even with different params, even
// after they leave and come back days later — do NOT overwrite. This
// matches how Meta/Google attribute conversions: the first paid click
// gets credit for the eventual purchase.
//
// What we capture:
// - utm_source / utm_medium / utm_campaign / utm_content / utm_term
//   (standard Google/Meta/email/etc. UTM params)
// - fbclid — Meta click ID; the Pixel uses this to construct the _fbc
//   cookie, and the CAPI Purchase event will need it for matching
// - gclid — Google Ads click ID; same story for Google ads
// - referrer — document.referrer at first touch (organic context)
// - landingPath — pathname at first touch ('/reserva', '/r/abc' etc.)
// - firstTouchAt — epoch ms
//
// Consumers:
// - TelemetryService — auto-appends to every event's extras so
//   CloudWatch can split funnel counts by source.
// - Public reservation flow — passes the snapshot into POST
//   /public/reservations so the reservation row carries source-of-truth
//   for ROI reporting + future Meta CAPI Purchase events.

const STORAGE_KEY = 'ff-attribution-v1';
const MAX_VALUE_LEN = 200;

// Whitelisted keys we read off the URL. Anything else is ignored.
const QUERY_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
] as const;

export type AttributionKey = (typeof QUERY_KEYS)[number];

export interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
  referrer?: string;
  landingPath?: string;
  firstTouchAt?: number;
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function clean(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim().slice(0, MAX_VALUE_LEN);
  return trimmed.length > 0 ? trimmed : undefined;
}

// Read whatever attribution params are present on the current URL.
// Returns undefined when none are present — caller decides whether to
// persist a "no attribution" snapshot (we don't; only paid/tagged
// visits get a row).
function readAttributionFromLocation(): Attribution | undefined {
  if (typeof window === 'undefined') return undefined;
  let params: URLSearchParams;
  try {
    params = new URL(window.location.href).searchParams;
  } catch {
    return undefined;
  }
  const out: Attribution = {};
  let any = false;
  for (const key of QUERY_KEYS) {
    const v = clean(params.get(key));
    if (v) {
      out[key] = v;
      any = true;
    }
  }
  if (!any) return undefined;
  const ref = clean(typeof document !== 'undefined' ? document.referrer : '');
  if (ref) out.referrer = ref;
  const path = clean(window.location.pathname);
  if (path) out.landingPath = path;
  out.firstTouchAt = Date.now();
  return out;
}

// Read the persisted first-touch snapshot, if any.
export function getAttribution(): Attribution | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Attribution) : null;
  } catch {
    return null;
  }
}

// First-touch capture: writes the current URL's attribution params to
// localStorage IFF nothing is already stored. Call once on app init or
// on every navigation — both are safe (subsequent calls are no-ops once
// a snapshot exists).
//
// Returns the snapshot in storage after the call (the existing one if
// we kept it, the new one if we just stored it, or null if neither URL
// nor storage had anything).
export function captureAttribution(): Attribution | null {
  const existing = getAttribution();
  if (existing) return existing; // first-touch wins
  const fresh = readAttributionFromLocation();
  if (!fresh) return null;
  const storage = safeStorage();
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    } catch {
      // localStorage full / disabled — return the snapshot anyway so
      // the in-memory event still carries attribution for this session.
    }
  }
  return fresh;
}

// Test helper — never call from production code paths.
export function _clearAttributionForTests(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}
