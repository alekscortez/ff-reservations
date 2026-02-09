import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';
import { FrequentClient } from '../../shared/models/frequent-client.model';

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

  delete(clientId: string) {
    return this.api.delete<void>(`/frequent-clients/${clientId}`);
  }
}
