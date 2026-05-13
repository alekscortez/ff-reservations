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
}

export interface GetPublicReservationResponse {
  reservation: PublicReservationView;
}

export interface PublicWalletPassResponse {
  filename: string;
  contentType: string;
  pkpassBase64: string;
  byteLength: number;
}

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
