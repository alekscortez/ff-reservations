/**
 * Cross-component "Card on Stand just paid" beacon.
 *
 * Card on Stand handoffs route the customer through Square POS and back
 * via Safari's URL scheme. After the callback page (/square-stand-callback)
 * records the payment, it navigates back to `returnPath` — at which point
 * the destination component is fresh and has no in-memory knowledge of
 * the just-recorded payment. Without a hint, the staff wizard would
 * stash the (already-paid) reservation as "pending Stand payment" and
 * offer a misleading "Cancel reservation" CTA.
 *
 * This beacon is the hint. The callback page writes a single localStorage
 * entry after a successful /complete; consumers (wizard, take-payment-modal
 * parents) read + clear it on init and either skip the spurious banner
 * or show a "just paid $X" toast.
 *
 * Scope:
 * - Same-origin localStorage, so it survives Safari being backgrounded
 *   by Square POS + the route navigation back.
 * - Single slot (LOCAL_KEY) — only one Card on Stand handoff is in flight
 *   per browser session, so we don't need per-handoff keys.
 * - 5-minute TTL — long enough for the navigation chain to complete,
 *   short enough that a stale entry from an abandoned session can't
 *   suppress next week's banner.
 */
const LOCAL_KEY = 'ff:stand-just-paid';
const TTL_MS = 5 * 60 * 1000;

export interface JustPaidBeacon {
  reservationId: string;
  amount: number;
  paidAt: number;
  expiresAt: number;
}

/**
 * Write the beacon. Called by /square-stand-callback after /complete
 * returns 200. No-op when localStorage is unavailable (private mode etc.) —
 * the UX degrades gracefully (the spurious banner reappears, but the
 * payment is still recorded server-side).
 */
export function writeJustPaidBeacon(payload: {
  reservationId: string;
  amount: number;
}): void {
  if (typeof localStorage === 'undefined') return;
  const reservationId = String(payload?.reservationId ?? '').trim();
  const amount = Number(payload?.amount ?? 0);
  if (!reservationId || !(amount > 0)) return;
  try {
    const now = Date.now();
    const entry: JustPaidBeacon = {
      reservationId,
      amount,
      paidAt: now,
      expiresAt: now + TTL_MS,
    };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(entry));
  } catch {
    // Quota / private mode — silently fail.
  }
}

/**
 * Read + delete the beacon in a single atomic operation. Returns null if
 * absent, expired, or unparseable. Always clears the slot on read so a
 * second consumer (e.g. dashboard + reservations both mounted) doesn't
 * double-fire the toast.
 */
export function consumeJustPaidBeacon(): JustPaidBeacon | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    localStorage.removeItem(LOCAL_KEY);
    const parsed = JSON.parse(raw) as Partial<JustPaidBeacon> | null;
    const reservationId = String(parsed?.reservationId ?? '').trim();
    const amount = Number(parsed?.amount ?? 0);
    const expiresAt = Number(parsed?.expiresAt ?? 0);
    if (!reservationId || !(amount > 0)) return null;
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) {
      return null;
    }
    return {
      reservationId,
      amount,
      paidAt: Number(parsed?.paidAt ?? Date.now()),
      expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Subscribe to cross-tab "just paid" events. Fires whenever ANOTHER tab
 * writes `ff:stand-just-paid` (the browser's `storage` event only fires
 * on tabs OTHER than the writer). Used for the case where Square POS
 * opens Safari in a NEW tab via URL scheme — the new tab's callback
 * page records the payment, but the original wizard tab needs to learn
 * about it to avoid showing a spurious "missing app" error and a
 * spurious "cancel reservation" banner.
 *
 * Returns an unsubscribe function. Callers should invoke it on
 * component destroy to avoid leaking listeners across navigation.
 *
 * The callback receives the parsed beacon payload. Consumers should
 * match against their own reservation id before acting (the beacon is
 * a broadcast — multiple components on multiple tabs receive it).
 *
 * Falls back to a no-op when `window` is unavailable (SSR/Node tests).
 */
export function subscribeToJustPaid(
  callback: (beacon: JustPaidBeacon) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: StorageEvent): void => {
    if (event.key !== 'ff:stand-just-paid') return;
    // Deletion (consume) events: newValue is null. We can still recover
    // the payload from oldValue so consumers learn what was paid.
    const raw = event.newValue ?? event.oldValue ?? null;
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<JustPaidBeacon> | null;
      const reservationId = String(parsed?.reservationId ?? '').trim();
      const amount = Number(parsed?.amount ?? 0);
      const expiresAt = Number(parsed?.expiresAt ?? 0);
      if (!reservationId || !(amount > 0)) return;
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) return;
      callback({
        reservationId,
        amount,
        paidAt: Number(parsed?.paidAt ?? Date.now()),
        expiresAt,
      });
    } catch {
      // Corrupt payload — silently ignore. The deterministic init-time
      // consume path in destination components will still surface a
      // helpful error if the user navigates to /staff/reservations.
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

/**
 * Peek without consuming. Used by tests + by consumers that want to
 * conditionally short-circuit before deciding to clear the slot.
 */
export function peekJustPaidBeacon(): JustPaidBeacon | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<JustPaidBeacon> | null;
    const reservationId = String(parsed?.reservationId ?? '').trim();
    const amount = Number(parsed?.amount ?? 0);
    const expiresAt = Number(parsed?.expiresAt ?? 0);
    if (!reservationId || !(amount > 0)) return null;
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) {
      return null;
    }
    return {
      reservationId,
      amount,
      paidAt: Number(parsed?.paidAt ?? Date.now()),
      expiresAt,
    };
  } catch {
    return null;
  }
}
