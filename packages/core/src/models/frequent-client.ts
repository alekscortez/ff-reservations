export type FrequentClientStatus = 'ACTIVE' | 'DISABLED';
export type FrequentClientPaymentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY';

export interface FrequentClientTableSetting {
  tableId: string;
  paymentStatus: FrequentClientPaymentStatus;
  amountDue: number;
  amountPaid?: number;
  paymentDeadlineTime?: string;
  paymentDeadlineTz?: string;
}

export interface FrequentClient {
  clientId: string;
  name: string;
  phone: string;
  phoneCountry?: 'US' | 'MX';
  defaultTableId?: string;
  defaultTableIds?: string[];
  tableSettings?: FrequentClientTableSetting[];
  notes?: string;
  status: FrequentClientStatus;
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
  updatedBy?: string;
}
