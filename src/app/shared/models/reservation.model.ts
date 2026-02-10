export type ReservationStatus = 'CONFIRMED' | 'CANCELLED';
export type PaymentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY';

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
  paymentMethod: 'cash' | 'cashapp' | 'square';
  status: ReservationStatus;
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
  updatedBy?: string;
  cancelReason?: string;
  cancelledAt?: number;
  cancelledBy?: string;
}
