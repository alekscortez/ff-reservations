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

export interface ActiveHoldSession {
  eventDate: string;
  tableId: string;
  holdId: string;
  holdExpiresAt: number | null;
  holdCreatedByMe: boolean;
  showReservationModal: boolean;
  customerName: string;
  phone: string;
  phoneCountry: 'US' | 'MX';
  amountDue: number;
  depositAmount: number;
  paymentStatus: 'PAID' | 'PARTIAL' | 'PENDING' | 'COURTESY';
  paymentMethod: 'cash' | 'square' | 'client';
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
const VALID_METHODS: ActiveHoldSession['paymentMethod'][] = ['cash', 'square', 'client'];

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
    return {
      eventDate,
      tableId,
      holdId,
      holdExpiresAt: Number.isFinite(Number(parsed.holdExpiresAt))
        ? Number(parsed.holdExpiresAt)
        : null,
      holdCreatedByMe: parsed.holdCreatedByMe !== false,
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
        VALID_METHODS.includes(paymentMethod as ActiveHoldSession['paymentMethod'])
          ? paymentMethod
          : 'square'
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
