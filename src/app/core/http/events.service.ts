import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';
import { CreateEventPayload, EventItem } from '../../shared/models/event.model';

export interface RuntimeAppSettings {
  operatingTz: string;
  operatingDayCutoffHour: number;
  defaultPaymentDeadlineHour: number;
  defaultPaymentDeadlineMinute: number;
  dashboardPollingSeconds: number;
  tableAvailabilityPollingSeconds: number;
  clientAvailabilityPollingSeconds: number;
  showClientFacingMap: boolean;
  sectionMapColors?: {
    A?: string;
    B?: string;
    C?: string;
    D?: string;
    E?: string;
  };
}

export interface CurrentEventContext {
  businessDate: string;
  event: EventItem | null;
  nextEvent: EventItem | null;
  settings: RuntimeAppSettings;
  operatingTz: string;
  operatingDayCutoffHour: number;
}

@Injectable({ providedIn: 'root' })
export class EventsService {
  private api = inject(ApiClient);

  listEvents() {
    return this.api.get<{ items: EventItem[] }>('/events').pipe(
      map((res) => res.items ?? [])
    );
  }

  createEvent(payload: CreateEventPayload) {
    return this.api.post<{ item: EventItem }>('/events', payload).pipe(
      map((res) => res.item)
    );
  }

  getEventByDate(date: string) {
    return this.api.get<{ item: EventItem }>(`/events/by-date/${date}`).pipe(
      map((res) => res.item)
    );
  }

  getCurrentContext() {
    return this.api.get<CurrentEventContext>('/events/context/current');
  }

  updateEvent(eventId: string, patch: Partial<EventItem>) {
    return this.api.put<{ item: EventItem }>(`/events/${eventId}`, patch).pipe(
      map((res) => res.item)
    );
  }

  deleteEvent(eventId: string) {
    return this.api.delete<void>(`/events/${eventId}`);
  }
}
