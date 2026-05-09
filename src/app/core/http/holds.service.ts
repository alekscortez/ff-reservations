import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';

export interface HoldItem {
  holdId: string;
  eventDate: string;
  tableId: string;
  expiresAt: number;
}

export interface HoldLockItem {
  PK?: string;
  SK?: string;
  lockType?: string;
  holdId?: string;
  expiresAt?: number;
  customerName?: string;
  phone?: string;
}

@Injectable({ providedIn: 'root' })
export class HoldsService {
  private api = inject(ApiClient);

  createHold(payload: {
    eventDate: string;
    tableId: string;
    customerName?: string;
    phone?: string;
    phoneCountry?: 'US' | 'MX';
  }) {
    return this.api.post<{ item: any }>('/holds', payload).pipe(map((res) => res.item));
  }

  releaseHold(eventDate: string, tableId: string) {
    return this.api.delete<void>(`/holds/${eventDate}/${tableId}`);
  }

  listLocks(eventDate: string) {
    return this.api
      .get<{ items: HoldLockItem[] }>('/holds', { eventDate })
      .pipe(map((res) => res.items ?? []));
  }
}
