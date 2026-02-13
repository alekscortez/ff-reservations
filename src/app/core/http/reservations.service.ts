import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';
import { PaymentMethod, ReservationItem } from '../../shared/models/reservation.model';

export interface CreateReservationPayload {
  eventDate: string;
  tableId: string;
  holdId: string;
  customerName: string;
  phone: string;
  phoneCountry?: 'US' | 'MX';
  depositAmount: number;
  amountDue?: number;
  paymentStatus?: 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY';
  paymentMethod?: PaymentMethod | null;
  paymentDeadlineAt?: string | null;
  paymentDeadlineTz?: string | null;
}

export interface AddPaymentPayload {
  reservationId: string;
  eventDate: string;
  amount: number;
  method: PaymentMethod;
  note?: string;
}

export interface AddSquarePaymentPayload {
  reservationId: string;
  eventDate: string;
  amount: number;
  sourceId: string;
  note?: string;
  idempotencyKey?: string;
}

export interface CreateSquarePaymentLinkPayload {
  reservationId: string;
  eventDate: string;
  amount?: number;
  note?: string;
  idempotencyKey?: string;
}

export interface CreateSquarePaymentLinkResponse {
  reservation: {
    reservationId: string;
    eventDate: string;
    tableId?: string | null;
    paymentStatus?: string | null;
    amountDue: number;
    paid: number;
    remainingAmount: number;
    linkAmount: number;
  };
  square: {
    env?: string | null;
    idempotencyKey?: string | null;
    paymentLinkId?: string | null;
    version?: number | null;
    url?: string | null;
    orderId?: string | null;
    audit?: {
      phonePrefillAttempted?: boolean;
      phonePrefillUsed?: boolean;
      phonePrefillFallbackUsed?: boolean;
      phonePrefillStatus?: string;
    };
  };
}

@Injectable({ providedIn: 'root' })
export class ReservationsService {
  private api = inject(ApiClient);

  create(payload: CreateReservationPayload) {
    return this.api.post<{ item: { reservationId: string } }>('/reservations', payload).pipe(
      map((res) => res.item)
    );
  }

  list(eventDate: string) {
    return this.api
      .get<{ items: ReservationItem[] }>('/reservations', { eventDate })
      .pipe(map((res) => res.items ?? []));
  }

  cancel(reservationId: string, eventDate: string, tableId: string, cancelReason: string) {
    return this.api.put<void>(`/reservations/${reservationId}/cancel`, {
      eventDate,
      tableId,
      cancelReason,
    });
  }

  addPayment(payload: AddPaymentPayload) {
    return this.api.put<{ item: ReservationItem }>(
      `/reservations/${payload.reservationId}/payment`,
      {
        eventDate: payload.eventDate,
        amount: payload.amount,
        method: payload.method,
        note: payload.note ?? '',
      }
    );
  }

  addSquarePayment(payload: AddSquarePaymentPayload) {
    return this.api.post<{
      item: ReservationItem;
      square: {
        paymentId: string;
        status: string;
        receiptUrl?: string | null;
        orderId?: string | null;
        sourceType?: string | null;
        idempotencyKey?: string | null;
        env?: string | null;
      };
    }>(`/reservations/${payload.reservationId}/payment/square`, {
      eventDate: payload.eventDate,
      amount: payload.amount,
      sourceId: payload.sourceId,
      note: payload.note ?? '',
      idempotencyKey: payload.idempotencyKey ?? '',
    });
  }

  createSquarePaymentLink(payload: CreateSquarePaymentLinkPayload) {
    return this.api.post<CreateSquarePaymentLinkResponse>(
      `/reservations/${payload.reservationId}/payment-link/square`,
      {
      eventDate: payload.eventDate,
      amount: payload.amount,
      note: payload.note ?? '',
      idempotencyKey: payload.idempotencyKey ?? '',
      }
    );
  }
}
