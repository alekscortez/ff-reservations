import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';
import { ReservationItem } from '../../shared/models/reservation.model';

export interface CreateReservationPayload {
  eventDate: string;
  tableId: string;
  holdId: string;
  customerName: string;
  phone: string;
  depositAmount: number;
  amountDue?: number;
  paymentStatus?: 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY';
  paymentMethod: 'cash' | 'cashapp' | 'square';
  paymentDeadlineAt?: string | null;
  paymentDeadlineTz?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ReservationsService {
  private api = inject(ApiClient);

  create(payload: CreateReservationPayload) {
    return this.api.post<{ item: { reservationId: string } }>('/reservations', payload).pipe(
      map((res) => res.item)
    );
  }

  list(eventDate: string) {
    return this.api
      .get<{ items: ReservationItem[] }>('/reservations', { eventDate })
      .pipe(map((res) => res.items ?? []));
  }

  cancel(reservationId: string, eventDate: string, tableId: string, cancelReason: string) {
    return this.api.put<void>(`/reservations/${reservationId}/cancel`, {
      eventDate,
      tableId,
      cancelReason,
    });
  }
}
