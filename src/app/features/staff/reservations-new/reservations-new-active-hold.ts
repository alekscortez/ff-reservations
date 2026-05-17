// Active-hold-session persistence + lookup helpers (slice 2 of the
// reservations-new.ts frontend split). Lets staff resume a Hold &
// Reserve flow after a navigation away or a page refresh.
//
// Storage layer (read/write/clear) wraps localStorage with a defensive
// try/catch — restricted environments (private browsing, storage
// disabled) silently fall back to ephemeral state instead of throwing.
//
// Pure lookup helpers (findActiveHoldLock, extractTableIdFromHoldLock)
// inspect a HoldLockItem[] from the holds API and decide whether the
// stored session is still claimable by the same staff session.

import { HoldLockItem } from '../../../core/http/holds.service';
import { normalizePhoneCountry } from '../../../shared/phone';

export const ACTIVE_HOLD_STORAGE_KEY = 'ff_new_res_active_hold_v1';

// One hold inside a multi-table active session.
export interface ActiveHoldEntry {
  tableId: string;
  holdId: string;
  holdExpiresAt: number | null;
  holdCreatedByMe: boolean;
}

export interface ActiveHoldSession {
  eventDate: string;
  // Primary hold (back-compat scalar = first of `holds` when present).
  // Old persisted sessions written before multi-table only have these
  // fields; new sessions stamp `holds`/`tableIds` too.
  tableId: string;
  holdId: string;
  holdExpiresAt: number | null;
  holdCreatedByMe: boolean;
  // Multi-table addition (optional for back-compat).
  tableIds?: string[];
  holds?: ActiveHoldEntry[];
  showReservationModal: boolean;
  customerName: string;
  phone: string;
  phoneCountry: 'US' | 'MX';
  amountDue: number;
  depositAmount: number;
  paymentStatus: 'PAID' | 'PARTIAL' | 'PENDING' | 'COURTESY';
  // Legacy 'client' value may exist in older persisted sessions written
  // before Cash App was moved to in-venue-only. Readers normalize it to
  // 'cashapp' on the fly so users with a stale session land on the new
  // in-venue QR flow instead of a stuck "Cash App link" state.
  paymentMethod: 'cash' | 'square' | 'cashapp' | 'square_stand';
  allowCustomDeposit: boolean;
  paymentDeadlineEnabled: boolean;
  paymentDeadlineDate: string;
  paymentDeadlineTime: string;
  savedAt: number;
}

const VALID_STATUSES: ActiveHoldSession['paymentStatus'][] = [
  'PAID',
  'PARTIAL',
  'PENDING',
  'COURTESY',
];
const VALID_METHODS: ActiveHoldSession['paymentMethod'][] = [
  'cash',
  'square',
  'cashapp',
  'square_stand',
];

export function readActiveHoldSession(): ActiveHoldSession | null {
  try {
    const raw = localStorage.getItem(ACTIVE_HOLD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveHoldSession>;
    const eventDate = String(parsed.eventDate ?? '').trim();
    const tableId = String(parsed.tableId ?? '').trim();
    const holdId = String(parsed.holdId ?? '').trim();
    if (!eventDate || !tableId || !holdId) return null;
    const phoneCountry = normalizePhoneCountry(parsed.phoneCountry);
    const paymentStatus = String(parsed.paymentStatus ?? '').trim().toUpperCase();
    const paymentMethod = String(parsed.paymentMethod ?? '').trim().toLowerCase();
    // Multi-table additions: parse the new arrays if present, else
    // synthesize from the scalar primary so callers can rely on
    // tableIds/holds always being populated.
    const persistedHolds = Array.isArray(parsed.holds) ? parsed.holds : null;
    const normalizedHolds: ActiveHoldEntry[] = persistedHolds
      ? persistedHolds
          .map((entry) => {
            const t = String(entry?.tableId ?? '').trim();
            const h = String(entry?.holdId ?? '').trim();
            if (!t || !h) return null;
            return {
              tableId: t,
              holdId: h,
              holdExpiresAt: Number.isFinite(Number(entry?.holdExpiresAt))
                ? Number(entry?.holdExpiresAt)
                : null,
              holdCreatedByMe: entry?.holdCreatedByMe !== false,
            } as ActiveHoldEntry;
          })
          .filter((entry): entry is ActiveHoldEntry => entry !== null)
      : [];
    const fallbackPrimary: ActiveHoldEntry = {
      tableId,
      holdId,
      holdExpiresAt: Number.isFinite(Number(parsed.holdExpiresAt))
        ? Number(parsed.holdExpiresAt)
        : null,
      holdCreatedByMe: parsed.holdCreatedByMe !== false,
    };
    const holds =
      normalizedHolds.length > 0 ? normalizedHolds : [fallbackPrimary];
    const tableIds = holds.map((h) => h.tableId);
    return {
      eventDate,
      tableId: holds[0].tableId,
      holdId: holds[0].holdId,
      holdExpiresAt: holds[0].holdExpiresAt,
      holdCreatedByMe: holds[0].holdCreatedByMe,
      tableIds,
      holds,
      showReservationModal: parsed.showReservationModal !== false,
      customerName: String(parsed.customerName ?? ''),
      phone: String(parsed.phone ?? ''),
      phoneCountry,
      amountDue: Number.isFinite(Number(parsed.amountDue)) ? Number(parsed.amountDue) : 0,
      depositAmount: Number.isFinite(Number(parsed.depositAmount))
        ? Number(parsed.depositAmount)
        : 0,
      paymentStatus: (
        VALID_STATUSES.includes(paymentStatus as ActiveHoldSession['paymentStatus'])
          ? paymentStatus
          : 'PAID'
      ) as ActiveHoldSession['paymentStatus'],
      paymentMethod: (
        paymentMethod === 'client'
          ? 'cashapp'
          : VALID_METHODS.includes(paymentMethod as ActiveHoldSession['paymentMethod'])
            ? paymentMethod
            : 'square'
        // Legacy 'client' (the pre-2026-05-16 Cash App link option)
        // maps to 'cashapp' so a stale session continues into the new
        // in-venue QR flow.
      ) as ActiveHoldSession['paymentMethod'],
      allowCustomDeposit: parsed.allowCustomDeposit === true,
      paymentDeadlineEnabled: parsed.paymentDeadlineEnabled === true,
      paymentDeadlineDate: String(parsed.paymentDeadlineDate ?? ''),
      paymentDeadlineTime: String(parsed.paymentDeadlineTime ?? '00:00'),
      savedAt: Number.isFinite(Number(parsed.savedAt)) ? Number(parsed.savedAt) : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeActiveHoldSession(session: ActiveHoldSession): void {
  try {
    localStorage.setItem(ACTIVE_HOLD_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Restricted environments (private mode, storage disabled) — drop silently.
  }
}

export function clearActiveHoldSessionStorage(): void {
  try {
    localStorage.removeItem(ACTIVE_HOLD_STORAGE_KEY);
  } catch {
    // Same as writeActiveHoldSession — silent in restricted environments.
  }
}

export function extractTableIdFromHoldLock(item: HoldLockItem): string | null {
  const sk = String(item?.SK ?? '').trim();
  if (!sk.startsWith('TABLE#')) return null;
  const tableId = sk.slice('TABLE#'.length).trim();
  return tableId || null;
}

export function findActiveHoldLock(
  items: HoldLockItem[],
  session: ActiveHoldSession,
  nowEpoch: number = Math.floor(Date.now() / 1000)
): { expiresAt: number | null } | null {
  for (const item of items ?? []) {
    const lockType = String(item.lockType ?? '').toUpperCase();
    if (lockType !== 'HOLD') continue;
    const holdId = String(item.holdId ?? '').trim();
    if (!holdId || holdId !== session.holdId) continue;
    const tableId = extractTableIdFromHoldLock(item);
    if (tableId && tableId !== session.tableId) continue;
    const expiresRaw = Number(item.expiresAt ?? 0);
    const expiresAt =
      Number.isFinite(expiresRaw) && expiresRaw > 0 ? Math.floor(expiresRaw) : null;
    if (expiresAt !== null && expiresAt <= nowEpoch) continue;
    return { expiresAt };
  }
  return null;
}

// Multi-table extension of findActiveHoldLock. Walks the persisted
// session.holds[], returns one entry per still-live hold lock. Used to
// restore a multi-table booking after a navigation: any holds that
// expired or were claimed by someone else simply drop out of the
// returned list (and the caller can decide whether to keep or discard
// the rest).
export function findActiveHoldLocks(
  items: HoldLockItem[],
  session: ActiveHoldSession,
  nowEpoch: number = Math.floor(Date.now() / 1000)
): ActiveHoldEntry[] {
  const holds = session.holds && session.holds.length > 0
    ? session.holds
    : [
        {
          tableId: session.tableId,
          holdId: session.holdId,
          holdExpiresAt: session.holdExpiresAt,
          holdCreatedByMe: session.holdCreatedByMe,
        },
      ];
  const out: ActiveHoldEntry[] = [];
  for (const entry of holds) {
    const match = items?.find((item) => {
      const lockType = String(item.lockType ?? '').toUpperCase();
      if (lockType !== 'HOLD') return false;
      const holdId = String(item.holdId ?? '').trim();
      if (!holdId || holdId !== entry.holdId) return false;
      const tableId = extractTableIdFromHoldLock(item);
      if (tableId && tableId !== entry.tableId) return false;
      const expiresRaw = Number(item.expiresAt ?? 0);
      if (Number.isFinite(expiresRaw) && expiresRaw > 0 && expiresRaw <= nowEpoch) {
        return false;
      }
      return true;
    });
    if (!match) continue;
    const expiresRaw = Number(match.expiresAt ?? 0);
    out.push({
      tableId: entry.tableId,
      holdId: entry.holdId,
      holdExpiresAt:
        Number.isFinite(expiresRaw) && expiresRaw > 0
          ? Math.floor(expiresRaw)
          : entry.holdExpiresAt ?? null,
      holdCreatedByMe: entry.holdCreatedByMe,
    });
  }
  return out;
}
