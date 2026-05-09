import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';
import { TableForEvent, TableTemplate } from '../../shared/models/table.model';
import { EventItem } from '../../shared/models/event.model';

@Injectable({ providedIn: 'root' })
export class TablesService {
  private api = inject(ApiClient);

  getTemplate() {
    return this.api.get<{ template: TableTemplate }>('/tables/template').pipe(
      map((res) => res.template)
    );
  }

  getForEvent(eventDate: string) {
    return this.api
      .get<{ event: EventItem; tables: TableForEvent[] }>(
        `/tables/for-event/${eventDate}`
      )
      .pipe(map((res) => res));
  }
}
