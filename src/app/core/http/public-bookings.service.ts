import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client';

export interface CreatePublicReservationRequest {
  eventDate: string;
  tableIds: string[];
  customer: {
    name: string;
    phone: string;
    email?: string;
  };
  turnstileToken?: string;
  idempotencyKey?: string;
}

export interface CreatePublicReservationResponse {
  reservationId: string;
  customerToken: string;
  // Human-readable booking code ("K7M3X2") + the pre-formatted "FF-K7M3X2".
  // Shown on the customer's confirmation page so they have a short
  // identifier to reference instead of the full UUID.
  confirmationCode: string;
  confirmationCodeFormatted: string;
  // 16-char URL slug + the full short URL (e.g. "famosofuego.com/p/xxx").
  // Client persists shortUrl in localStorage so the pending-hold banner
  // can render a tap-able link the customer can also screenshot/share.
  publicSlug: string;
  shortUrl: string;
  paymentUrl: string;
  amountDue: number;
  currency: string;
  holdExpiresAt: string;
  holdExpiresAtEpoch: number;
  tableIds: string[];
}

export interface PublicReservationView {
  reservationId: string;
  eventDate: string;
  eventName: string | null;
  tableIds: string[];
  tablesLabel: string;
  customerName: string;
  amountDue: number;
  depositAmount: number;
  paymentStatus: 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY' | 'REFUNDED';
  status: 'CONFIRMED' | 'CANCELLED';
  paymentDeadlineAt: string | null;
  paymentDeadlineTz: string | null;
  paymentLinkUrl: string | null;
  // Short booking identifier. Older reservations (before the short-code
  // rollout) won't have these — they'll be null.
  confirmationCode: string | null;
  confirmationCodeFormatted: string | null;
  // 16-char URL slug + the pre-formatted short URL. shortUrl with
  // ?to=pass redirects to /check-in/pass — used by the "View check-in
  // pass" CTA on the PAID page (so non-Apple users can show the QR).
  publicSlug: string | null;
  shortUrl: string | null;
}

export interface PublicCustomerContact {
  phone: string;
}

export interface GetPublicReservationResponse {
  reservation: PublicReservationView;
  customerContact?: PublicCustomerContact | null;
}

export interface PublicWalletPassResponse {
  filename: string;
  contentType: string;
  pkpassBase64: string;
  byteLength: number;
}

export type FindByPhoneResponse =
  | { found: false }
  | {
      found: true;
      shortUrl: string | null;
      paymentStatus: 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY' | 'REFUNDED';
      eventDate: string;
      expiresAt: number | null;
      confirmationCode: string | null;
    };

@Injectable({ providedIn: 'root' })
export class PublicBookingsService {
  private api = inject(ApiClient);

  // Returns the new reservation + redirect URL. Caller is expected to
  // localStorage the reservationId + customerToken + holdExpiresAt and
  // navigate to paymentUrl.
  createReservation(request: CreatePublicReservationRequest) {
    return this.api.post<CreatePublicReservationResponse>(
      '/public/reservations',
      request
    );
  }

  // Token-gated read. Polled every 3s on /r/[id] confirmation page.
  // eventDate must come from local state — the backend uses (eventDate,
  // reservationId) as the DDB key.
  getReservation(
    reservationId: string,
    customerToken: string,
    eventDate: string
  ) {
    return this.api.get<GetPublicReservationResponse>(
      `/public/reservations/${encodeURIComponent(reservationId)}`,
      { t: customerToken, eventDate }
    );
  }

  // Customer-initiated cancel.
  releaseReservation(
    reservationId: string,
    customerToken: string,
    eventDate: string
  ) {
    return this.api.post<{ released: boolean; alreadyCancelled?: boolean }>(
      `/public/reservations/${encodeURIComponent(reservationId)}/release`,
      { eventDate },
      { t: customerToken }
    );
  }

  // Find-my-booking: customer lost the /r URL (Square email in spam,
  // closed the tab, switched device). Trades phone + Turnstile for the
  // short URL of their currently-active anon booking. Returns
  // { found: false } when no active hold exists for the phone — UI
  // surfaces a friendly "we couldn't find a recent booking" message.
  findByPhone(phone: string, turnstileToken: string) {
    return this.api.post<FindByPhoneResponse>(
      '/public/lookup-by-phone',
      { phone, turnstileToken: turnstileToken || undefined },
    );
  }

  // Token-gated Apple Wallet pass. Returned as base64; caller decodes
  // into a Blob and triggers the download.
  generateWalletPass(
    reservationId: string,
    customerToken: string,
    eventDate: string
  ) {
    return this.api.post<PublicWalletPassResponse>(
      `/public/reservations/${encodeURIComponent(reservationId)}/wallet-pass`,
      { eventDate },
      { t: customerToken }
    );
  }
}
