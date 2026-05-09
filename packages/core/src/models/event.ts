export interface EventItem {
  eventId: string;
  eventName: string;
  eventDate: string;
  status: 'ACTIVE' | 'INACTIVE';
  minDeposit: number;
  tablePricing?: Record<string, number>;
  sectionPricing?: Record<string, number>;
  disabledTables?: string[];
  disabledClients?: string[];
  createdAt?: number;
  updatedAt?: number;
  createdBy?: string;
}

export interface CreateEventPayload {
  eventName: string;
  eventDate: string;
  minDeposit: number;
  tablePricing?: Record<string, number>;
  sectionPricing?: Record<string, number>;
  disabledTables?: string[];
  disabledClients?: string[];
}
