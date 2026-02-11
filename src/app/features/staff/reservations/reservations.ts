import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ReservationsService } from '../../../core/http/reservations.service';
import { PaymentMethod, ReservationItem } from '../../../shared/models/reservation.model';
import { EventsService } from '../../../core/http/events.service';
import { EventItem } from '../../../shared/models/event.model';

@Component({
  selector: 'app-reservations',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './reservations.html',
  styleUrl: './reservations.scss',
})
export class Reservations implements OnInit {
  private reservationsApi = inject(ReservationsService);
  private eventsApi = inject(EventsService);

  filterDate = new FormControl('', { nonNullable: true });
  items: ReservationItem[] = [];
  loading = false;
  error: string | null = null;
  events: EventItem[] = [];
  eventsLoading = false;
  eventsError: string | null = null;
  detailItem: ReservationItem | null = null;
  showDetailsModal = false;
  paymentItem: ReservationItem | null = null;
  showPaymentModal = false;

  paymentForm = new FormGroup({
    amount: new FormControl(0, { nonNullable: true, validators: [Validators.min(0.01)] }),
    method: new FormControl<PaymentMethod>('cash', { nonNullable: true }),
    note: new FormControl('', { nonNullable: true }),
  });

  ngOnInit(): void {
    this.loadEvents();
  }

  loadEvents(): void {
    this.eventsLoading = true;
    this.eventsError = null;
    this.eventsApi.listEvents().subscribe({
      next: (items) => {
        this.events = (items ?? []).sort((a, b) =>
          (a.eventDate || '').localeCompare(b.eventDate || '')
        );
        this.eventsLoading = false;
        this.autoSelectCurrentWeekEvent();
      },
      error: (err) => {
        this.eventsError = err?.error?.message || err?.message || 'Failed to load events';
        this.eventsLoading = false;
      },
    });
  }

  upcomingEvents(): EventItem[] {
    const today = this.todayString();
    return this.events
      .filter((e) => (e.eventDate || '') >= today)
      .slice(0, 6);
  }

  selectEvent(eventDate: string | undefined): void {
    if (!eventDate) return;
    this.filterDate.setValue(eventDate);
    this.load();
  }

  isSelectedEvent(eventDate: string | undefined): boolean {
    return !!eventDate && this.filterDate.value === eventDate;
  }

  isThisWeek(eventDate: string | undefined): boolean {
    if (!eventDate) return false;
    const date = new Date(`${eventDate}T00:00:00`);
    if (Number.isNaN(date.getTime())) return false;
    const today = new Date();
    const day = (today.getDay() + 6) % 7;
    const start = new Date(today);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - day);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return date >= start && date <= end;
  }

  formatEventDate(eventDate: string | undefined): string {
    if (!eventDate) return '—';
    const date = new Date(`${eventDate}T00:00:00`);
    if (Number.isNaN(date.getTime())) return eventDate;
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }

  private autoSelectCurrentWeekEvent(): void {
    if (this.filterDate.value) return;
    const currentWeek = this.events.find((e) => this.isThisWeek(e.eventDate));
    const firstUpcoming = this.upcomingEvents()[0];
    const target = currentWeek?.eventDate || firstUpcoming?.eventDate;
    if (target) {
      this.filterDate.setValue(target);
      this.load();
    }
  }

  private todayString(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  load(): void {
    const date = this.filterDate.value?.trim();
    if (!date) {
      this.items = [];
      return;
    }
    this.loading = true;
    this.error = null;
    this.reservationsApi.list(date).subscribe({
      next: (items) => {
        this.items = items;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to load reservations';
        this.loading = false;
      },
    });
  }

  cancel(item: ReservationItem): void {
    const reason = window.prompt('Reason for cancellation (required):');
    if (!reason || !reason.trim()) return;
    this.loading = true;
    this.error = null;
    this.reservationsApi
      .cancel(item.reservationId, item.eventDate, item.tableId, reason.trim())
      .subscribe({
      next: () => {
        this.items = this.items.map((x) =>
          x.reservationId === item.reservationId
            ? { ...x, status: 'CANCELLED', cancelReason: reason.trim() }
            : x
        );
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to cancel reservation';
        this.loading = false;
      },
    });
  }

  openDetails(item: ReservationItem): void {
    this.detailItem = item;
    this.showDetailsModal = true;
  }

  closeDetails(): void {
    this.showDetailsModal = false;
    this.detailItem = null;
  }

  openPayment(item: ReservationItem): void {
    this.paymentItem = item;
    this.showPaymentModal = true;
    const due = Number(item.amountDue ?? 0);
    const paid = Number(item.depositAmount ?? 0);
    const balance = Math.max(0, due - paid);
    this.paymentForm.setValue({
      amount: balance > 0 ? balance : 0,
      method: 'cash',
      note: '',
    });
  }

  closePayment(): void {
    this.showPaymentModal = false;
    this.paymentItem = null;
    this.paymentForm.reset({
      amount: 0,
      method: 'cash',
      note: '',
    });
  }

  submitPayment(): void {
    if (!this.paymentItem) return;
    if (this.paymentForm.invalid) return;
    this.loading = true;
    this.error = null;
    const amount = Number(this.paymentForm.controls.amount.value);
    const method = this.paymentForm.controls.method.value;
    const note = this.paymentForm.controls.note.value;
    this.reservationsApi
      .addPayment({
        reservationId: this.paymentItem.reservationId,
        eventDate: this.paymentItem.eventDate,
        amount,
        method,
        note,
      })
      .subscribe({
        next: (res) => {
          const updated = res.item;
          this.items = this.items.map((x) =>
            x.reservationId === updated.reservationId ? updated : x
          );
          this.loading = false;
          this.closePayment();
        },
        error: (err) => {
          this.error = err?.error?.message || err?.message || 'Failed to record payment';
          this.loading = false;
        },
      });
  }
}
