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

export interface CreateReservationResponse {
  item: {
    reservationId: string;
  };
  autoSquareLinkSms?: {
    attempted?: boolean;
    sent?: boolean;
    linkAmount?: number;
    paymentLinkId?: string | null;
    to?: string | null;
    messageId?: string | null;
    errorMessage?: string | null;
  } | null;
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

export interface CreateSquarePaymentLinkSmsResponse extends CreateSquarePaymentLinkResponse {
  sms: {
    sent: boolean;
    provider?: string | null;
    messageId?: string | null;
    to?: string | null;
    sentAt?: number | null;
  };
}

export interface ReservationHistoryItem {
  eventId?: string | null;
  eventType?: string | null;
  reservationId?: string | null;
  eventDate?: string | null;
  tableId?: string | null;
  customerName?: string | null;
  actor?: string | null;
  source?: string | null;
  at?: number | null;
  details?: Record<string, unknown> | null;
}

@Injectable({ providedIn: 'root' })
export class ReservationsService {
  private api = inject(ApiClient);

  create(payload: CreateReservationPayload) {
    return this.api.post<CreateReservationResponse>('/reservations', payload);
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

  createSquarePaymentLinkSms(payload: CreateSquarePaymentLinkPayload) {
    return this.api.post<CreateSquarePaymentLinkSmsResponse>(
      `/reservations/${payload.reservationId}/payment-link/square/sms`,
      {
        eventDate: payload.eventDate,
        amount: payload.amount,
        note: payload.note ?? '',
        idempotencyKey: payload.idempotencyKey ?? '',
      }
    );
  }

  listHistory(reservationId: string, eventDate: string) {
    return this.api
      .get<{ items: ReservationHistoryItem[] }>(`/reservations/${reservationId}/history`, { eventDate })
      .pipe(map((res) => res.items ?? []));
  }
}
