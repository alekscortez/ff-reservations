import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';
import { CrmClient } from '../../shared/models/client.model';

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
}
