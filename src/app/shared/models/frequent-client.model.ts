export type FrequentClientStatus = 'ACTIVE' | 'DISABLED';

export interface FrequentClient {
  clientId: string;
  name: string;
  phone: string;
  defaultTableId: string;
  notes?: string;
  status: FrequentClientStatus;
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
  updatedBy?: string;
}
