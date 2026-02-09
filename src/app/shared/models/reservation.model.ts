export type ReservationStatus = 'CONFIRMED' | 'CANCELLED';

export interface ReservationItem {
  reservationId: string;
  eventDate: string;
  tableId: string;
  customerName: string;
  phone: string;
  depositAmount: number;
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
