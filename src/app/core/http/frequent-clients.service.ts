import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';
import { FrequentClient } from '../../shared/models/frequent-client.model';

// Shape returned by GET /frequent-clients/{id}/active-links. Mirrors the
// service-side projection in backend services-clients.mjs:
// listFrequentClientActiveLinks. Kept here (vs. an upstream model) because
// it's a UI-only view: it folds the upcoming-events fan-out into a flat
// row-per-reservation list, which doesn't match any backend record type.
export interface FrequentClientActiveLink {
  eventDate: string;
  eventName: string | null;
  reservationId: string;
  tableIds: string[];
  customerName: string | null;
  phone: string | null;
  phoneCountry: string | null;
  confirmationCode: string | null;
  publicSlug: string | null;
  amountDue: number;
  depositAmount: number;
  tablePrice: number;
  paymentStatus: string | null;
  paymentDeadlineAt: string | null;
  paymentDeadlineTz: string | null;
  paymentLinkUrl: string | null;
  paymentLinkStatus: string | null;
  paymentLinkExpiresAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class FrequentClientsService {
  private api = inject(ApiClient);

  list() {
    return this.api.get<{ items: FrequentClient[] }>('/frequent-clients').pipe(
      map((res) => res.items ?? [])
    );
  }

  create(payload: Omit<FrequentClient, 'clientId' | 'status'>) {
    return this.api.post<{ item: FrequentClient }>('/frequent-clients', payload).pipe(
      map((res) => res.item)
    );
  }

  update(clientId: string, patch: Partial<FrequentClient>) {
    return this.api.put<{ item: FrequentClient }>(`/frequent-clients/${clientId}`, patch).pipe(
      map((res) => res.item)
    );
  }

  get(clientId: string) {
    return this.api.get<{ item: FrequentClient }>(`/frequent-clients/${clientId}`).pipe(
      map((res) => res.item)
    );
  }

  delete(clientId: string) {
    return this.api.delete<void>(`/frequent-clients/${clientId}`);
  }

  // Lists the frequent client's reservations on ACTIVE upcoming events,
  // each with its current Square payment-link state. Used by the
  // /admin/frequent-clients panel to surface shareable links + deadline
  // editing for backfill on already-created events.
  listActiveLinks(clientId: string) {
    return this.api
      .get<{ items: FrequentClientActiveLink[] }>(
        `/frequent-clients/${clientId}/active-links`
      )
      .pipe(map((res) => res.items ?? []));
  }
}
