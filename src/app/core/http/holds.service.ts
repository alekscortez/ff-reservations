import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';

export interface HoldItem {
  holdId: string;
  eventDate: string;
  tableId: string;
  expiresAt: number;
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
}
