import type { CreateSquarePaymentLinkResponse } from '../../core/http/reservations.service';

export interface GeneratedPaymentLink {
  // Cash App is in-venue only (staff shows QR via the Web Payments SDK);
  // no Cash App link is ever generated as a customer-facing URL.
  method: 'square';
  url: string;
  amount: number;
  createdAtMs: number;
  audit?: CreateSquarePaymentLinkResponse['square']['audit'];
}

export interface GeneratedCheckInPass {
  passId: string;
  url: string;
  token: string;
  qrPayload: string;
  createdAtMs: number;
}

export interface CheckInPassState {
  passId: string;
  status: string;
  issuedAt: number | null;
  issuedBy: string | null;
  usedAt: number | null;
  usedBy: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
  expiresAt: number | null;
}

export interface ReservationHistoryViewItem {
  eventId: string;
  eventType: string;
  atMs: number;
  actor: string;
  source: string | null;
  details: Record<string, unknown> | null;
}

export interface PaymentLinkSmsState {
  status: 'SENT' | 'FAILED';
  atMs: number;
  to: string | null;
  errorMessage: string | null;
}
