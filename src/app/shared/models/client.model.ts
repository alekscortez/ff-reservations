export interface CrmClient {
  name: string;
  phone: string;
  phoneCountry?: 'US' | 'MX';
  totalSpend?: number;
  totalReservations?: number;
  lastReservationAt?: number;
  lastEventDate?: string;
  lastTableId?: string;
  updatedBy?: string;
}
