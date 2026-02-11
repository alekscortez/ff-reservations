export type ReservationStatus = 'CONFIRMED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY';
export type PaymentMethod = 'cash' | 'cashapp' | 'square';

export interface ReservationPayment {
  paymentId: string;
  amount: number;
  method: PaymentMethod;
  note?: string;
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
