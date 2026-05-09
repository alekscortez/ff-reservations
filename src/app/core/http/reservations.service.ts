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
    paymentMethod?: 'square' | 'cashapp' | null;
    linkType?: 'square' | 'cashapp-link' | null;
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
  creditId?: string;
  receiptNumber?: string;
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

export interface CreateCashAppLinkPayload {
  reservationId: string;
  eventDate: string;
  amount?: number;
  ttlMinutes?: number;
}

export interface CreateCashAppLinkResponse {
  reservation: {
    reservationId: string;
    eventDate: string;
    tableId?: string | null;
    customerName?: string | null;
    phone?: string | null;
    paymentStatus?: string | null;
    amountDue: number;
    paid: number;
    remainingAmount: number;
    linkAmount: number;
  };
  cashAppLink: {
    url: string;
    expiresAt: number;
    ttlMinutes: number;
  };
}

export interface CreateCashAppLinkSmsResponse extends CreateCashAppLinkResponse {
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

export type CancellationResolutionType =
  | 'CANCEL_NO_REFUND'
  | 'RESCHEDULE_CREDIT'
  | 'REFUND';

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

  cancel(
    reservationId: string,
    eventDate: string,
    tableId: string,
    cancelReason: string,
    resolutionType: CancellationResolutionType = 'CANCEL_NO_REFUND'
  ) {
    return this.api.put<void>(`/reservations/${reservationId}/cancel`, {
      eventDate,
      tableId,
      cancelReason,
      resolutionType,
    });
  }

  addPayment(payload: AddPaymentPayload) {
    return this.api.put<{ item: ReservationItem }>(
      `/reservations/${payload.reservationId}/payment`,
      {
        eventDate: payload.eventDate,
        amount: payload.amount,
        method: payload.method,
        creditId: payload.creditId ?? '',
        receiptNumber: payload.receiptNumber ?? '',
        note: payload.note ?? '',
      }
    );
  }

  addSquarePayment(payload: AddSquarePaymentPayload) {
    return this.api.post<{
      item: ReservationItem;
      square: {
        method?: PaymentMethod;
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

  createCashAppLink(payload: CreateCashAppLinkPayload) {
    return this.api.post<CreateCashAppLinkResponse>(
      `/reservations/${payload.reservationId}/cashapp-link/square`,
      {
        eventDate: payload.eventDate,
        amount: payload.amount,
        ttlMinutes: payload.ttlMinutes,
      }
    );
  }

  createCashAppLinkSms(payload: CreateCashAppLinkPayload) {
    return this.api.post<CreateCashAppLinkSmsResponse>(
      `/reservations/${payload.reservationId}/cashapp-link/square/sms`,
      {
        eventDate: payload.eventDate,
        amount: payload.amount,
        ttlMinutes: payload.ttlMinutes,
      }
    );
  }

  listHistory(reservationId: string, eventDate: string) {
    return this.api
      .get<{ items: ReservationHistoryItem[] }>(`/reservations/${reservationId}/history`, { eventDate })
      .pipe(map((res) => res.items ?? []));
  }
}
