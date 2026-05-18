import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';
import { PaymentMethod, ReservationItem } from '../../shared/models/reservation.model';

export interface CreateReservationPayload {
  eventDate: string;
  // Single-table back-compat fields. Either these or the *Ids arrays must
  // be set; the backend accepts either form. New multi-table callers
  // should send tableIds[]+holdIds[].
  tableId?: string;
  holdId?: string;
  tableIds?: string[];
  holdIds?: string[];
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
    paymentMethod?: 'square' | null;
    linkType?: 'square' | null;
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

export interface StartSquareStandHandoffPayload {
  reservationId: string;
  eventDate: string;
  amount: number;
  note?: string;
  returnPath?: string;
}

export interface StartSquareStandHandoffResponse {
  handoffId: string;
  callbackUrl: string;
  expiresAt: number;
  amount: number;
}

export interface CompleteSquareStandHandoffPayload {
  reservationId: string;
  handoffId: string;
  transactionId: string;
}

export interface CompleteSquareStandHandoffResponse {
  item: ReservationItem;
  square: {
    paymentId: string | null;
    status: string;
    receiptUrl: string | null;
    orderId: string | null;
    sourceType: string | null;
    idempotencyKey: string | null;
    env: string | null;
  };
  handoff: {
    handoffId: string;
    consumedAt: number;
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

// PUT /reservations/{id}/tables — change the table set on an existing
// reservation. The backend handles the atomic swap (release old RESERVED,
// upgrade new HOLD->RESERVED, update the reservation row) and any bundled
// payment / overpayment resolution as a single TransactWrite. See
// backend/lambda/lib/services-reservations-table-change.mjs for the
// state machine and edge cases.
// PUT (not PATCH) for consistency with /cancel and /payment, and because
// the API GW CORS allowlist doesn't include PATCH on shared infra.
export interface ChangeTablesPayload {
  reservationId: string;
  eventDate: string;
  // Full desired final set of table IDs (1..10).
  newTableIds: string[];
  // holdId per *added* table only (kept tables stay RESERVED untouched).
  // Caller must create each hold via HoldsService.createHold first.
  newHoldsByTableId: Record<string, string>;
  // Sum of the new table prices as the FE sees them. Backend re-derives
  // from the event and 409s on mismatch (stale UI guard).
  expectedTablePriceTotal: number;
  reason: string;
  // For delta > 0: pick exactly ONE of `payment` (bundled instant
  // settlement) or `deferredPaymentMethod` (collect async after swap
  // commits). Backend rejects with 400 if both are set, or if either
  // is set for delta <= 0.
  payment?: {
    method: 'cash' | 'credit';
    amount: number;
    creditId?: string;
    receiptNumber?: string;
    note?: string;
  };
  // When set, the swap commits without a bundled payment. Reservation
  // drops to PARTIAL; the FE chains into the take-payment modal pre-
  // loaded with this method + amount = delta. Used for methods that
  // need an async settlement loop: Card on Stand (URL handoff to the
  // Square POS app), Square hosted-checkout link via SMS, or Cash App
  // QR scan via Web Payments SDK.
  deferredPaymentMethod?: 'square_stand' | 'square' | 'cashapp';
  // Required when the new total < current. Picks how to resolve any
  // surplus (deposit > new amountDue): CREDIT issues a reschedule credit,
  // REFUND issues a partial Square refund, LEAVE just logs it.
  overpaymentResolution?: 'CREDIT' | 'REFUND' | 'LEAVE';
}

export interface ChangeTablesResponse {
  reservation: ReservationItem & { idempotentReplay?: boolean };
  delta: number;
  newAmountDue: number;
  newTablePrice: number;
  newTablePrices: number[];
  payment: {
    paymentId?: string;
    amount: number;
    method: 'cash' | 'credit';
    receiptNumber: string | null;
    source: string;
    note: string | null;
    credit: { creditId: string | null } | null;
    createdAt?: number;
    createdBy?: string;
  } | null;
  overpayment: {
    surplus: number;
    resolution: 'CREDIT' | 'REFUND' | 'LEAVE';
    credit: {
      creditId: string;
      amountTotal: number;
      amountRemaining: number;
      expiresAt: string;
    } | null;
    refund: {
      providerPaymentId: string;
      amount: number;
      refundId: string | null;
      refundStatus: string | null;
      idempotencyKey: string;
    } | null;
  } | null;
  idempotentReplay?: boolean;
  // Echoed back when the swap took the deferred-payment branch. null
  // when bundled-payment path was used. FE uses this to decide
  // whether to chain into the take-payment modal post-swap.
  deferredPaymentMethod?: 'square_stand' | 'square' | 'cashapp' | null;
  // Reissued check-in pass on the non-deferred PAID path (or null on
  // the deferred path / when reservation isn't PAID).
  reissuedPass?: { passId: string; url: string } | null;
}

@Injectable({ providedIn: 'root' })
export class ReservationsService {
  private api = inject(ApiClient);

  create(payload: CreateReservationPayload) {
    return this.api.post<CreateReservationResponse>('/reservations', payload);
  }

  list(eventDate: string, opts?: { suppressRelease?: boolean }) {
    const params: Record<string, string> = { eventDate };
    if (opts?.suppressRelease) params['suppressRelease'] = '1';
    return this.api
      .get<{ items: ReservationItem[] }>('/reservations', params)
      .pipe(map((res) => res.items ?? []));
  }

  // Multi-event fan-out for the staff dashboard's Recent Activity card.
  // Backend fans out across the next `maxEvents` upcoming ACTIVE events
  // (from the business date), so bookings for next Saturday show up
  // even when today has an active event.
  listRecentAcrossEvents(opts?: { maxEvents?: number; limit?: number }) {
    const params: Record<string, string> = {};
    if (opts?.maxEvents) params['maxEvents'] = String(opts.maxEvents);
    if (opts?.limit) params['limit'] = String(opts.limit);
    return this.api
      .get<{ items: ReservationItem[]; eventDates: string[]; asOfEpoch: number }>(
        '/reservations/recent',
        params,
      )
      .pipe(map((res) => res.items ?? []));
  }

  // Staff lookup by 6-char confirmation code (FF-XXXXXX). Caller can
  // pass the code with or without the "FF-" prefix; backend strips it.
  // Returns the full reservation row so the caller can switch the
  // page's eventDate filter and open the detail modal.
  findByCode(code: string) {
    const trimmed = String(code ?? '').trim();
    return this.api
      .get<{ reservation: ReservationItem }>(
        `/reservations/by-code/${encodeURIComponent(trimmed)}`,
      )
      .pipe(map((res) => res.reservation));
  }

  cancel(
    reservationId: string,
    eventDate: string,
    tableId: string | null | undefined,
    cancelReason: string,
    resolutionType: CancellationResolutionType = 'CANCEL_NO_REFUND'
  ) {
    return this.api.put<void>(`/reservations/${reservationId}/cancel`, {
      eventDate,
      // Backend derives the hold-release list from reservation.tableIds[];
      // tableId is kept for back-compat with older clients only.
      tableId: tableId ?? null,
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

  // Square Stand handoff — URL-scheme bridge used when staff and the
  // Square POS app live on the SAME iPad. See <square-stand-handoff>.
  startSquareStandHandoff(payload: StartSquareStandHandoffPayload) {
    return this.api.post<StartSquareStandHandoffResponse>(
      `/reservations/${payload.reservationId}/payment/square-stand/start`,
      {
        eventDate: payload.eventDate,
        amount: payload.amount,
        note: payload.note ?? '',
        returnPath: payload.returnPath ?? '',
      },
    );
  }

  completeSquareStandHandoff(payload: CompleteSquareStandHandoffPayload) {
    return this.api.post<CompleteSquareStandHandoffResponse>(
      `/reservations/${payload.reservationId}/payment/square-stand/complete`,
      {
        handoffId: payload.handoffId,
        transactionId: payload.transactionId,
      },
    );
  }

  // Note: the BE route POST /reservations/{id}/payment/square-stand/cancel
  // still exists (used by the audit + future workflows) but there's no
  // FE consumer today — the wizard's "Cancel pending Stand" flow cancels
  // the RESERVATION, not the handoff row (which TTLs out in 15 min).
  // Re-add a client method here if a UI surface needs to call cancel
  // explicitly.

  listHistory(reservationId: string, eventDate: string) {
    return this.api
      .get<{ items: ReservationHistoryItem[] }>(`/reservations/${reservationId}/history`, { eventDate })
      .pipe(map((res) => res.items ?? []));
  }

  changeTables(payload: ChangeTablesPayload) {
    // Body intentionally omits reservationId (it's in the path). Backend
    // accepts both for back-compat but we keep the wire format minimal.
    const body: Record<string, unknown> = {
      eventDate: payload.eventDate,
      newTableIds: payload.newTableIds,
      newHoldsByTableId: payload.newHoldsByTableId,
      expectedTablePriceTotal: payload.expectedTablePriceTotal,
      reason: payload.reason,
    };
    if (payload.payment) body['payment'] = payload.payment;
    if (payload.deferredPaymentMethod) {
      body['deferredPaymentMethod'] = payload.deferredPaymentMethod;
    }
    if (payload.overpaymentResolution) {
      body['overpaymentResolution'] = payload.overpaymentResolution;
    }
    return this.api.put<ChangeTablesResponse>(
      `/reservations/${payload.reservationId}/tables`,
      body,
    );
  }
}
