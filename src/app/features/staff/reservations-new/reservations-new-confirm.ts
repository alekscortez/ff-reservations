// Confirm-reservation pure helpers + types (slice 6 of the
// reservations-new.ts frontend split). Conservative scope: only the
// purely-functional pieces that the 230-line confirmReservation method
// uses for payload building, share-link UX, and method-string mapping.
//
// What's intentionally NOT here
// - The validation preflight (eventDate/table/hold/form-validity guards)
//   — they're interleaved with `this.loading = false; this.error = ...`
//   state mutations; pulling them out would change the visible side-effect
//   order. Worth a follow-up slice if the orchestration is rewritten to
//   return validation results before mutating state.
// - The .subscribe handler with the 4-way branching on credit/square/
//   client/cash. That's the orchestration core and stays in the
//   component for now.

export interface CreatedReservationContext {
  reservationId: string;
  eventDate: string;
  // tableId is the *primary* (first) table for back-compat; tableIds[] is
  // the full set. Single-table bookings have tableIds.length === 1, so
  // tableId === tableIds[0]. Multi-table renders as "Tables 1, 2, 3".
  tableId: string;
  tableIds: string[];
  customerName: string;
  phone: string;
  amount: number;
  // Optional: short FF-XXXXXX so the Square POS notes line carries a
  // customer-friendly reference (the webhook can also reconcile via this).
  confirmationCode?: string | null;
  // What the wizard renders after the reservation is created:
  // - 'square'        → Square hosted-checkout link to share with the customer.
  // - 'cashapp'       → in-venue Cash App QR (Web Payments SDK) mounted inline.
  // - 'square_stand'  → in-venue card swipe on the Stand reader via the
  //                     Square POS URL-scheme handoff. Stays here as a
  //                     "pending stand payment" until the callback fires.
  // - null            → no follow-up (cash already recorded at create time).
  linkMode: 'square' | 'cashapp' | 'square_stand' | null;
}

// "Table 5" / "Tables 5, 7, 9". Empty list returns "" so callers can branch.
export function formatTablesLabel(tableIds: string[] | undefined | null): string {
  const list = Array.isArray(tableIds)
    ? tableIds.map((v) => String(v ?? '').trim()).filter(Boolean)
    : [];
  if (list.length === 0) return '';
  if (list.length === 1) return `table ${list[0]}`;
  return `tables ${list.join(', ')}`;
}

// Maps the form's payment-method enum to the API's payment-method enum.
// 'cashapp' here means "staff will scan the in-venue QR for this customer
// right after create" — NOT "send them a Cash App link" (that flow was
// removed 2026-05-16). The backend treats cashapp + 'PENDING' the same
// way as square + 'PENDING' at create time; the actual Cash App charge
// is recorded later via POST /reservations/{id}/payments when the SDK
// tokenizes.
export function toCreatePaymentMethod(
  method: 'cash' | 'square' | 'cashapp' | 'square_stand'
): 'cash' | 'square' | 'cashapp' | null {
  if (method === 'cash') return 'cash';
  // Card-on-Stand and Square hosted-link both end up recorded as
  // method:"square" on the BE; at create time they look identical to
  // the reservation row (PENDING with method:square). The follow-up
  // step differs: stand = local URL-scheme handoff, square = SMS link.
  if (method === 'square_stand' || method === 'square') return 'square';
  if (method === 'cashapp') return 'cashapp';
  return null;
}

// Returns the link mode if the chosen method requires a follow-up step
// after reservation creation. Square = generate hosted-checkout link.
// Cash App = mount in-venue QR pad. Square Stand = mount Stand handoff.
// Null for cash (recorded at create).
export function toLinkMode(
  method: 'cash' | 'square' | 'cashapp' | 'square_stand'
): 'square' | 'cashapp' | 'square_stand' | null {
  if (method === 'square') return 'square';
  if (method === 'cashapp') return 'cashapp';
  if (method === 'square_stand') return 'square_stand';
  return null;
}

// Builds the SMS / WhatsApp body for sharing a payment link.
export function buildShareMessage(ctx: CreatedReservationContext, url: string): string {
  // Prefer tableIds[] over the scalar fallback so multi-table renders as
  // "tables 1, 2, 3" instead of just the primary.
  const tablesLabel = formatTablesLabel(
    Array.isArray(ctx.tableIds) && ctx.tableIds.length > 0
      ? ctx.tableIds
      : ctx.tableId
      ? [ctx.tableId]
      : []
  );
  const noun = (ctx.tableIds?.length ?? 0) > 1 ? 'tables link' : 'table link';
  const suffix = tablesLabel ? ` ${tablesLabel}` : '';
  return `Hi ${ctx.customerName}, here is your ${noun} for ${ctx.eventDate}${suffix}: ${url}`;
}

// Normalizes a phone for the sms: protocol — keeps leading + and digits.
export function toSmsRecipient(phone: string | undefined): string {
  const raw = String(phone ?? '').trim();
  if (!raw) return '';
  return raw.replace(/[^\d+]/g, '');
}

// Normalizes a phone for wa.me URLs — digits only.
export function toWhatsAppRecipient(phone: string | undefined): string {
  const raw = String(phone ?? '').trim();
  if (!raw) return '';
  return raw.replace(/\D/g, '');
}

// Async clipboard write with a defensive try/catch + capability check.
// Returns true if the write succeeded, false otherwise (no clipboard
// API, blocked by permissions, secure-context-only, etc.).
export async function writeClipboard(text: string): Promise<boolean> {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
