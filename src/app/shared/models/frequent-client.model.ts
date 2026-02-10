export type FrequentClientStatus = 'ACTIVE' | 'DISABLED';
export type PaymentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY';

export interface FrequentClientTableSetting {
  tableId: string;
  paymentStatus: PaymentStatus;
  amountDue: number;
  amountPaid?: number;
  paymentDeadlineTime?: string; // HH:mm
  paymentDeadlineTz?: string;
}

export interface FrequentClient {
  clientId: string;
  name: string;
  phone: string;
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
