import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';

export interface PublicAvailabilityEventSummary {
  eventDate: string;
  eventName: string;
  status: string;
}

export interface PublicAvailabilityEvent {
  eventId: string;
  eventDate: string;
  eventName: string;
  status: string;
}

export interface PublicAvailabilityTable {
  id: string;
  number: number;
  section: string;
  price: number;
  status: 'AVAILABLE' | 'UNAVAILABLE';
  available: boolean;
}

export interface PublicAvailabilityResponse {
  event: PublicAvailabilityEvent;
  businessDate: string | null;
  asOfEpoch: number;
  counts: {
    total: number;
    available: number;
    unavailable: number;
  };
  refreshSeconds: number;
  sectionMapColors?: Record<string, string>;
  events: PublicAvailabilityEventSummary[];
  tables: PublicAvailabilityTable[];
}

@Injectable({ providedIn: 'root' })
export class PublicAvailabilityService {
  private api = inject(ApiClient);

  getAvailability(eventDate?: string) {
    return this.api
      .get<PublicAvailabilityResponse>('/public/availability', {
        eventDate: eventDate || undefined,
      })
      .pipe(map((res) => res));
  }
}
