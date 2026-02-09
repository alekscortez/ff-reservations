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
}
