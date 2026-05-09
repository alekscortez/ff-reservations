export interface CrmClient {
  name: string;
  phone: string;
  phoneCountry?: 'US' | 'MX';
  cognitoSub?: string | null;
  totalSpend?: number;
  totalReservations?: number;
  lastReservationAt?: number;
  lastEventDate?: string;
  lastTableId?: string;
  updatedBy?: string;
}
