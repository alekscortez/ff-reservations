import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client';
import { PaymentMethod } from '../../shared/models/reservation.model';

export interface CashAppSessionResponse {
  reservation: {
    reservationId: string;
    eventDate: string;
    eventName?: string | null;
    tableId?: string | null;
    customerName?: string | null;
    paymentStatus?: string | null;
    amountDue: number;
    paid: number;
    remainingAmount: number;
    chargeAmount: number;
  };
  session: {
    expiresAt: number;
  };
  square: {
    envMode: 'sandbox' | 'production';
    applicationId: string;
    locationId: string;
  };
}

export interface CashAppChargeResponse {
  ok: boolean;
  reservation: {
    reservationId: string;
    eventDate: string;
    tableId?: string | null;
    customerName?: string | null;
    paymentStatus?: string | null;
    amountDue: number;
    paid: number;
    remainingAmount: number;
  };
  square: {
    method?: PaymentMethod;
    paymentId?: string | null;
    status?: string | null;
    receiptUrl?: string | null;
    orderId?: string | null;
    sourceType?: string | null;
    env?: string | null;
  };
}

@Injectable({ providedIn: 'root' })
export class PublicPayService {
  private api = inject(ApiClient);

  getSession(eventDate: string, reservationId: string, token: string) {
    return this.api.get<CashAppSessionResponse>('/cashapp/session', {
      eventDate,
      reservationId,
      token,
    });
  }

  charge(payload: {
    eventDate: string;
    reservationId: string;
    token: string;
    sourceId: string;
    idempotencyKey?: string;
  }) {
    return this.api.post<CashAppChargeResponse>('/cashapp/session/charge', {
      eventDate: payload.eventDate,
      reservationId: payload.reservationId,
      token: payload.token,
      sourceId: payload.sourceId,
      idempotencyKey: payload.idempotencyKey ?? '',
    });
  }
}
