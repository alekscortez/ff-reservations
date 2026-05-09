// Reschedule-credit math + label helpers (slice 5 of the
// reservations-new.ts frontend split). Pure functions with no
// dependency on the form, component state, or DI — easy to unit test
// in isolation.
//
// Component callers wrap these in their isUsingClientCredit gates
// (so the bare math returns even when credits aren't being applied)
// and use them to render the credit summary in the reservation
// payment-method panel.

import { RescheduleCredit } from '../../../core/http/clients.service';
import { formatCreditExpiry } from './reservations-new-utils';

export function sumCreditsRemaining(credits: RescheduleCredit[]): number {
  const total = (credits ?? []).reduce((sum, credit) => {
    const amount = Number(credit?.amountRemaining ?? 0);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  return Number(total.toFixed(2));
}

export function formatCreditLabel(credit: RescheduleCredit): string {
  const amount = Number(credit?.amountRemaining ?? 0);
  const expires = formatCreditExpiry(credit?.expiresAt);
  return expires
    ? `$${amount.toFixed(2)} · Expires ${expires}`
    : `$${amount.toFixed(2)} · No expiry`;
}

export function findCreditById(
  credits: RescheduleCredit[],
  creditId: string
): RescheduleCredit | null {
  const id = String(creditId ?? '').trim();
  if (!id) return null;
  return (credits ?? []).find((credit) => credit?.creditId === id) ?? null;
}

export function computeCreditAppliedAmount(
  credit: RescheduleCredit | null,
  amountDue: number | null | undefined
): number {
  if (!credit) return 0;
  const due = Number(amountDue ?? 0);
  const available = Number(credit.amountRemaining ?? 0);
  if (!Number.isFinite(due) || !Number.isFinite(available)) return 0;
  return Number(Math.max(0, Math.min(due, available)).toFixed(2));
}

export function computeCreditRemainingAmount(
  amountDue: number | null | undefined,
  applied: number | null | undefined
): number {
  const due = Number(amountDue ?? 0);
  const used = Number(applied ?? 0);
  if (!Number.isFinite(due) || !Number.isFinite(used)) return 0;
  return Number(Math.max(0, due - used).toFixed(2));
}
