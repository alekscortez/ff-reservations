import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';
import { CrmClient } from '../../shared/models/client.model';

export interface RescheduleCredit {
  creditId: string;
  status: string;
  amountTotal: number;
  amountRemaining: number;
  expiresAt: string | null;
  issuedAt: number | null;
  issuedBy: string | null;
  sourceReservationId: string | null;
  sourceEventDate: string | null;
  customerName: string | null;
  phone: string | null;
  phoneCountry?: 'US' | 'MX' | null;
  reason?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ClientsService {
  private api = inject(ApiClient);

  list() {
    return this.api.get<{ items: CrmClient[] }>('/clients').pipe(map((res) => res.items ?? []));
  }

  update(phone: string, payload: Partial<CrmClient>) {
    return this.api
      .put<{ item: CrmClient }>(`/clients/${encodeURIComponent(phone)}`, payload)
      .pipe(map((res) => res.item));
  }

  delete(phone: string) {
    return this.api.delete<void>(`/clients/${encodeURIComponent(phone)}`);
  }

  searchByPhone(phone: string) {
    return this.api
      .get<{ items: CrmClient[] }>('/clients/search', { phone })
      .pipe(map((res) => res.items ?? []));
  }

  listRescheduleCredits(phone: string, phoneCountry: 'US' | 'MX' = 'US') {
    return this.api
      .get<{ items: RescheduleCredit[] }>('/clients/credits', { phone, phoneCountry })
      .pipe(map((res) => res.items ?? []));
  }
}
