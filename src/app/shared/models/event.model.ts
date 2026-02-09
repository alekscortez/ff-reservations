export interface EventItem {
  eventId: string;
  eventName: string;
  eventDate: string; // YYYY-MM-DD
  status: 'ACTIVE' | 'INACTIVE';
  minDeposit: number;
  tablePricing?: Record<string, number>;
  createdAt?: number;
  updatedAt?: number;
  createdBy?: string;
}

export interface CreateEventPayload {
  eventName: string;
  eventDate: string; // YYYY-MM-DD
  minDeposit: number;
  tablePricing?: Record<string, number>;
}
