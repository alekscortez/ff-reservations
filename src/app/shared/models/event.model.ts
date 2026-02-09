export interface EventItem {
  eventId: string;
  eventName: string;
  eventDate: string; // YYYY-MM-DD
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
  eventDate: string; // YYYY-MM-DD
  minDeposit: number;
  tablePricing?: Record<string, number>;
  sectionPricing?: Record<string, number>;
  disabledTables?: string[];
  disabledClients?: string[];
}
