export interface CrmClient {
  name: string;
  phone: string;
  totalSpend?: number;
  totalReservations?: number;
  lastReservationAt?: number;
  lastEventDate?: string;
  lastTableId?: string;
  updatedBy?: string;
}
