import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of, Subscription } from 'rxjs';
import { EventsService } from '../../../core/http/events.service';
import { ReservationsService } from '../../../core/http/reservations.service';
import { EventItem } from '../../../shared/models/event.model';
import { PaymentMethod, ReservationItem } from '../../../shared/models/reservation.model';

interface FinancialRow {
  eventId: string;
  eventName: string;
  eventDate: string;
  reservationId: string;
  status: 'CONFIRMED' | 'CANCELLED';
  paymentStatus: 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY' | null;
  tableId: string;
  customerName: string;
  phone: string;
  amountDue: number;
  paid: number;
  balance: number;
  tablePrice: number;
  paymentMethod: PaymentMethod | null;
  paymentDeadlineAt: string | null;
  deadlineMs: number | null;
  isOverdue: boolean;
  isDueSoon: boolean;
  createdAt: number;
}

interface EventFinancialSummary {
  eventId: string;
  eventName: string;
  eventDate: string;
  status: 'ACTIVE' | 'INACTIVE';
  reservations: number;
  confirmed: number;
  cancelled: number;
  expected: number;
  collected: number;
  outstanding: number;
  overdue: number;
  courtesyValue: number;
}

interface OverviewKpis {
  eventsInRange: number;
  reservations: number;
  confirmed: number;
  collected: number;
  expected: number;
  outstanding: number;
  overdue: number;
  dueSoon: number;
  courtesyValue: number;
}

interface EventReservationsSnapshot {
  event: EventItem;
  reservations: ReservationItem[];
}

interface MethodTotals {
  cash: number;
  cashapp: number;
  square: number;
}

@Component({
  selector: 'app-financials',
  imports: [CommonModule, ReactiveFormsModule, RouterLink],
  templateUrl: './financials.html',
  styleUrl: './financials.scss',
})
export class Financials implements OnInit, OnDestroy {
  private eventsApi = inject(EventsService);
  private reservationsApi = inject(ReservationsService);

  private snapshotSub: Subscription | null = null;

  events: EventItem[] = [];
  filteredEvents: EventItem[] = [];
  rows: FinancialRow[] = [];
  receivables: FinancialRow[] = [];
  eventSummaries: EventFinancialSummary[] = [];
  methodTotals: MethodTotals = { cash: 0, cashapp: 0, square: 0 };

  rangeFrom = new FormControl('', { nonNullable: true });
  rangeTo = new FormControl('', { nonNullable: true });
  eventStatus = new FormControl<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL', { nonNullable: true });

  overview: OverviewKpis = {
    eventsInRange: 0,
    reservations: 0,
    confirmed: 0,
    collected: 0,
    expected: 0,
    outstanding: 0,
    overdue: 0,
    dueSoon: 0,
    courtesyValue: 0,
  };

  loading = false;
  error: string | null = null;
  warnings: string[] = [];

  ngOnInit(): void {
    this.setDefaultRange();
    this.refresh();
  }

  ngOnDestroy(): void {
    this.snapshotSub?.unsubscribe();
    this.snapshotSub = null;
  }

  refresh(): void {
    this.loading = true;
    this.error = null;
    this.warnings = [];

    this.eventsApi.listEvents().subscribe({
      next: (events) => {
        this.events = [...(events ?? [])].sort((a, b) =>
          (b.eventDate || '').localeCompare(a.eventDate || '')
        );
        this.loadReportForCurrentFilters();
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to load events';
        this.loading = false;
      },
    });
  }

  applyFilters(): void {
    this.loadReportForCurrentFilters();
  }

  resetFilters(): void {
    this.setDefaultRange();
    this.eventStatus.setValue('ALL');
    this.loadReportForCurrentFilters();
  }

  exportCsv(): void {
    if (this.rows.length === 0) return;

    const headers = [
      'event_date',
      'event_name',
      'event_status',
      'reservation_id',
      'reservation_status',
      'payment_status',
      'table_id',
      'customer_name',
      'phone',
      'amount_due',
      'paid',
      'balance',
      'table_price',
      'payment_method',
      'payment_deadline',
    ];

    const eventByDate = new Map(this.filteredEvents.map((e) => [e.eventDate, e]));

    const body = this.rows.map((row) => {
      const event = eventByDate.get(row.eventDate);
      return [
        row.eventDate,
        row.eventName,
        event?.status ?? '',
        row.reservationId,
        row.status,
        row.paymentStatus ?? '',
        row.tableId,
        row.customerName,
        row.phone,
        row.amountDue.toFixed(2),
        row.paid.toFixed(2),
        row.balance.toFixed(2),
        row.tablePrice.toFixed(2),
        row.paymentMethod ?? '',
        row.paymentDeadlineAt ?? '',
      ].map((x) => this.escapeCsv(x));
    });

    const csv = [headers.join(','), ...body.map((line) => line.join(','))].join('\n');
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate()
    ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(
      now.getMinutes()
    ).padStart(2, '0')}`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `financials-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  formatCurrency(value: number): string {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(value || 0);
  }

  formatEventDate(eventDate: string | undefined): string {
    if (!eventDate) return '—';
    const date = new Date(`${eventDate}T00:00:00`);
    if (Number.isNaN(date.getTime())) return eventDate;
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  formatDeadlineShort(deadlineAt?: string | null, eventDate?: string): string {
    if (!deadlineAt) return '—';
    const match = String(deadlineAt)
      .trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/);
    if (!match) return String(deadlineAt);

    const [, yyyy, mm, dd, hh, min] = match;
    const hour24 = Number(hh);
    const isPm = hour24 >= 12;
    const hour12 = hour24 % 12 || 12;
    const amPm = isPm ? 'PM' : 'AM';
    const timeLabel = `${hour12}:${min} ${amPm}`;

    if (eventDate && this.isNextDay(deadlineAt, eventDate)) {
      return `${timeLabel} (+1 DAY)`;
    }

    return `${mm}/${dd}/${yyyy} ${timeLabel}`;
  }

  receivableBadgeClass(row: FinancialRow): string {
    if (row.isOverdue) return 'bg-danger-100 text-danger-700';
    if (row.isDueSoon) return 'bg-accent-100 text-accent-700';
    return 'bg-brand-100 text-brand-700';
  }

  private setDefaultRange(): void {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    this.rangeFrom.setValue(`${yyyy}-${mm}-01`);
    this.rangeTo.setValue(`${yyyy}-${mm}-${dd}`);
  }

  private loadReportForCurrentFilters(): void {
    this.error = null;
    this.warnings = [];
    this.filteredEvents = this.filterEvents(this.events);

    if (this.filteredEvents.length === 0) {
      this.clearReport();
      this.loading = false;
      return;
    }

    this.loading = true;
    this.snapshotSub?.unsubscribe();
    this.snapshotSub = this.loadReservationsForEvents(this.filteredEvents).subscribe({
      next: (snapshots) => {
        this.rows = this.buildRows(snapshots);
        this.receivables = this.buildReceivables(this.rows);
        this.eventSummaries = this.buildEventSummaries(this.filteredEvents, this.rows, this.receivables);
        this.overview = this.buildOverview(this.filteredEvents, this.rows, this.receivables);
        this.methodTotals = this.buildMethodTotals(snapshots);
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to load financial report';
        this.loading = false;
      },
    });
  }

  private filterEvents(events: EventItem[]): EventItem[] {
    const from = this.rangeFrom.value.trim();
    const to = this.rangeTo.value.trim();
    const status = this.eventStatus.value;

    return [...events]
      .filter((event) => {
        if (status === 'ALL') return true;
        return event.status === status;
      })
      .filter((event) => (from ? (event.eventDate || '') >= from : true))
      .filter((event) => (to ? (event.eventDate || '') <= to : true))
      .sort((a, b) => (b.eventDate || '').localeCompare(a.eventDate || ''));
  }

  private loadReservationsForEvents(events: EventItem[]) {
    const requests = events.map((event) =>
      this.reservationsApi.list(event.eventDate).pipe(
        map((reservations) => ({ event, reservations: reservations ?? [] })),
        catchError((err) => {
          const msg =
            err?.error?.message || err?.message || `Failed to load reservations for ${event.eventDate}`;
          this.warnings.push(`${event.eventDate}: ${msg}`);
          return of({ event, reservations: [] });
        })
      )
    );

    if (requests.length === 0) return of([] as EventReservationsSnapshot[]);
    return forkJoin(requests);
  }

  private buildRows(snapshots: EventReservationsSnapshot[]): FinancialRow[] {
    const now = Date.now();
    const dueSoonWindowMs = 24 * 60 * 60 * 1000;

    return snapshots
      .flatMap(({ event, reservations }) =>
        reservations.map((reservation) => {
          const amountDue = Number(reservation.amountDue ?? reservation.tablePrice ?? 0);
          const paid = Number(reservation.depositAmount ?? 0);
          const balance = Math.max(0, amountDue - paid);
          const tablePrice = Number(reservation.tablePrice ?? amountDue);
          const deadlineMs = this.parseDeadlineMs(reservation.paymentDeadlineAt);
          const isOverdue =
            reservation.status === 'CONFIRMED' &&
            balance > 0 &&
            deadlineMs !== null &&
            deadlineMs < now;
          const isDueSoon =
            reservation.status === 'CONFIRMED' &&
            balance > 0 &&
            deadlineMs !== null &&
            deadlineMs >= now &&
            deadlineMs - now <= dueSoonWindowMs;

          return {
            eventId: event.eventId,
            eventName: event.eventName,
            eventDate: event.eventDate,
            reservationId: reservation.reservationId,
            status: reservation.status,
            paymentStatus: reservation.paymentStatus ?? null,
            tableId: reservation.tableId,
            customerName: reservation.customerName,
            phone: reservation.phone,
            amountDue,
            paid,
            balance,
            tablePrice,
            paymentMethod: reservation.paymentMethod ?? null,
            paymentDeadlineAt: reservation.paymentDeadlineAt ?? null,
            deadlineMs,
            isOverdue,
            isDueSoon,
            createdAt: Number(reservation.createdAt ?? 0),
          } as FinancialRow;
        })
      )
      .sort((a, b) => {
        const dateCmp = b.eventDate.localeCompare(a.eventDate);
        if (dateCmp !== 0) return dateCmp;
        return a.tableId.localeCompare(b.tableId, undefined, { numeric: true, sensitivity: 'base' });
      });
  }

  private buildReceivables(rows: FinancialRow[]): FinancialRow[] {
    return rows
      .filter((row) => row.status === 'CONFIRMED')
      .filter((row) => row.paymentStatus === 'PENDING' || row.paymentStatus === 'PARTIAL')
      .filter((row) => row.balance > 0)
      .filter((row) => row.deadlineMs !== null)
      .sort((a, b) => (a.deadlineMs ?? 0) - (b.deadlineMs ?? 0));
  }

  private buildEventSummaries(
    events: EventItem[],
    rows: FinancialRow[],
    receivables: FinancialRow[]
  ): EventFinancialSummary[] {
    const grouped = new Map<string, FinancialRow[]>();
    for (const row of rows) {
      const existing = grouped.get(row.eventDate) ?? [];
      existing.push(row);
      grouped.set(row.eventDate, existing);
    }

    const receivableByDate = new Map<string, FinancialRow[]>();
    for (const row of receivables) {
      const existing = receivableByDate.get(row.eventDate) ?? [];
      existing.push(row);
      receivableByDate.set(row.eventDate, existing);
    }

    return events.map((event) => {
      const eventRows = grouped.get(event.eventDate) ?? [];
      const confirmed = eventRows.filter((row) => row.status === 'CONFIRMED');
      const cancelled = eventRows.filter((row) => row.status === 'CANCELLED');
      const eventReceivables = receivableByDate.get(event.eventDate) ?? [];

      const expected = this.sum(confirmed.map((x) => x.amountDue));
      const collected = this.sum(confirmed.map((x) => x.paid));
      const outstanding = this.sum(eventReceivables.map((x) => x.balance));
      const overdue = this.sum(eventReceivables.filter((x) => x.isOverdue).map((x) => x.balance));
      const courtesyValue = this.sum(
        confirmed.filter((x) => x.paymentStatus === 'COURTESY').map((x) => x.tablePrice)
      );

      return {
        eventId: event.eventId,
        eventName: event.eventName,
        eventDate: event.eventDate,
        status: event.status,
        reservations: eventRows.length,
        confirmed: confirmed.length,
        cancelled: cancelled.length,
        expected,
        collected,
        outstanding,
        overdue,
        courtesyValue,
      };
    });
  }

  private buildOverview(
    events: EventItem[],
    rows: FinancialRow[],
    receivables: FinancialRow[]
  ): OverviewKpis {
    const confirmed = rows.filter((row) => row.status === 'CONFIRMED');
    return {
      eventsInRange: events.length,
      reservations: rows.length,
      confirmed: confirmed.length,
      collected: this.sum(confirmed.map((x) => x.paid)),
      expected: this.sum(confirmed.map((x) => x.amountDue)),
      outstanding: this.sum(receivables.map((x) => x.balance)),
      overdue: this.sum(receivables.filter((x) => x.isOverdue).map((x) => x.balance)),
      dueSoon: this.sum(receivables.filter((x) => x.isDueSoon).map((x) => x.balance)),
      courtesyValue: this.sum(
        confirmed.filter((x) => x.paymentStatus === 'COURTESY').map((x) => x.tablePrice)
      ),
    };
  }

  private buildMethodTotals(snapshots: EventReservationsSnapshot[]): MethodTotals {
    const totals: MethodTotals = { cash: 0, cashapp: 0, square: 0 };

    for (const { reservations } of snapshots) {
      for (const reservation of reservations) {
        if (reservation.status !== 'CONFIRMED') continue;

        const payments = reservation.payments ?? [];
        if (payments.length > 0) {
          for (const payment of payments) {
            const method = payment.method;
            const amount = Number(payment.amount ?? 0);
            if (method === 'cash' || method === 'cashapp' || method === 'square') {
              totals[method] += amount;
            }
          }
          continue;
        }

        const fallbackMethod = reservation.paymentMethod;
        const fallbackAmount = Number(reservation.depositAmount ?? 0);
        if (
          fallbackAmount > 0 &&
          (fallbackMethod === 'cash' || fallbackMethod === 'cashapp' || fallbackMethod === 'square')
        ) {
          totals[fallbackMethod] += fallbackAmount;
        }
      }
    }

    return totals;
  }

  private clearReport(): void {
    this.rows = [];
    this.receivables = [];
    this.eventSummaries = [];
    this.methodTotals = { cash: 0, cashapp: 0, square: 0 };
    this.overview = {
      eventsInRange: 0,
      reservations: 0,
      confirmed: 0,
      collected: 0,
      expected: 0,
      outstanding: 0,
      overdue: 0,
      dueSoon: 0,
      courtesyValue: 0,
    };
  }

  private parseDeadlineMs(deadlineAt?: string | null): number | null {
    if (!deadlineAt) return null;
    const match = String(deadlineAt)
      .trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;

    const [, yyyy, mm, dd, hh, min, sec] = match;
    const date = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(min),
      Number(sec ?? '0')
    );
    const ms = date.getTime();
    if (Number.isNaN(ms)) return null;
    return ms;
  }

  private isNextDay(deadlineAt: string, eventDate: string): boolean {
    const d = deadlineAt.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    const e = eventDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!d || !e) return false;

    const deadlineUtc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
    const eventUtc = Date.UTC(Number(e[1]), Number(e[2]) - 1, Number(e[3]));
    const dayMs = 24 * 60 * 60 * 1000;
    return deadlineUtc - eventUtc === dayMs;
  }

  private escapeCsv(value: unknown): string {
    const text = String(value ?? '');
    if (text.includes(',') || text.includes('"') || text.includes('\n')) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  private sum(values: number[]): number {
    return values.reduce((acc, n) => acc + Number(n || 0), 0);
  }
}
