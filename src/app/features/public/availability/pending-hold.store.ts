// Tiny localStorage wrapper for the pending public-booking that the
// customer is mid-flow on. Used by:
//   - the public /map page to show a "You have a pending hold" banner
//   - the /r/[id] confirmation page to recover the eventDate after a
//     return-from-Square redirect.
//
// Single key, JSON-encoded. Cleared on PAID/CANCELLED/EXPIRED + on
// explicit Release. Not synchronized across tabs (a single-tab story
// is acceptable for v1; cross-device recovery is an open follow-up).

const STORAGE_KEY = 'ff-pending-public-booking';

export interface PendingHold {
  reservationId: string;
  customerToken: string;
  eventDate: string;
  paymentUrl: string;
  holdExpiresAtEpoch: number;
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readPendingHold(): PendingHold | null {
  const storage = safeStorage();
  if (!storage) return null;
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.reservationId !== 'string' ||
      typeof parsed?.customerToken !== 'string' ||
      typeof parsed?.eventDate !== 'string' ||
      typeof parsed?.paymentUrl !== 'string' ||
      typeof parsed?.holdExpiresAtEpoch !== 'number'
    ) {
      return null;
    }
    return parsed as PendingHold;
  } catch {
    return null;
  }
}

export function writePendingHold(hold: PendingHold): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(hold));
  } catch {
    // localStorage quota exhausted or in private browsing — UX degrades to
    // "no banner" which is fine.
  }
}

export function clearPendingHold(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}

// Returns true when the stored hold has passed its expiry epoch. The
// banner uses this to decide between "Continue to payment" + "Release"
// CTAs (active) vs auto-clearing (expired).
export function pendingHoldExpired(
  hold: PendingHold | null,
  nowEpoch: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!hold) return true;
  return hold.holdExpiresAtEpoch <= nowEpoch;
}
