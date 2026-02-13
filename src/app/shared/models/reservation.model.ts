export type ReservationStatus = 'CONFIRMED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY';
export type PaymentMethod = 'cash' | 'cashapp' | 'square';
export type PaymentSource = 'manual' | 'square-direct' | 'square-webhook';

export interface ReservationPayment {
  paymentId: string;
  amount: number;
  method: PaymentMethod;
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
  tableId: string;
  customerName: string;
  phone: string;
  depositAmount: number;
  tablePrice?: number;
  amountDue?: number;
  paymentStatus?: PaymentStatus;
  paymentDeadlineAt?: string | null;
  paymentDeadlineTz?: string | null;
  paymentMethod?: PaymentMethod | null;
  payments?: ReservationPayment[];
  status: ReservationStatus;
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
  updatedBy?: string;
  cancelReason?: string;
  cancelledAt?: number;
  cancelledBy?: string;
}
