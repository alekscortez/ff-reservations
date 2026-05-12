export type ReservationStatus = 'CONFIRMED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY' | 'REFUNDED';
export type PaymentMethod = 'cash' | 'square' | 'cashapp' | 'credit';
export type PaymentSource = 'manual' | 'square-direct' | 'square-webhook' | 'reschedule-credit';

export interface ReservationRefundResult {
  paymentLocalId: string;
  providerPaymentId: string;
  amount: number;
  method: 'square' | 'cashapp';
  refundId?: string | null;
  refundStatus?: string | null;
  idempotencyKey?: string;
  success: boolean;
  errorMessage?: string;
}

export interface ReservationPayment {
  paymentId: string;
  amount: number;
  method: PaymentMethod;
  receiptNumber?: string | null;
  source?: PaymentSource;
  note?: string;
  provider?: {
    provider?: 'square' | string | null;
    providerPaymentId?: string | null;
    providerStatus?: string | null;
    receiptUrl?: string | null;
    orderId?: string | null;
    sourceType?: string | null;
    idempotencyKey?: string | null;
    amountMoney?: {
      amount?: number;
      currency?: string | null;
    } | null;
  } | null;
  createdAt: number;
  createdBy?: string;
}

export interface ReservationItem {
  reservationId: string;
  eventDate: string;
  // Primary (first) table — back-compat with single-table data. Always
  // equals tableIds[0] when tableIds is present. Read sites that need
  // to render a label across all booked tables should use tableIds
  // (or the TableLabel pipe).
  tableId: string;
  tableIds?: string[];
  customerName: string;
  phone: string;
  depositAmount: number;
  tablePrice?: number;
  tablePrices?: number[];
  amountDue?: number;
  paymentStatus?: PaymentStatus;
  paymentDeadlineAt?: string | null;
  paymentDeadlineTz?: string | null;
  paymentMethod?: PaymentMethod | null;
  payments?: ReservationPayment[];
  paymentLinkProvider?: string | null;
  paymentLinkId?: string | null;
  paymentLinkUrl?: string | null;
  paymentLinkStatus?: string | null;
  paymentLinkCreatedAt?: number | null;
  paymentLinkExpiresAt?: string | null;
  paymentLinkUpdatedAt?: number | null;
  status: ReservationStatus;
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
  updatedBy?: string;
  checkedInAt?: number;
  checkedInBy?: string;
  checkedInDevice?: string | null;
  cancelReason?: string;
  cancelledAt?: number;
  cancelledBy?: string;
  refundedAmount?: number;
  refundedAt?: number;
  refundedBy?: string;
  refunds?: ReservationRefundResult[];
}
