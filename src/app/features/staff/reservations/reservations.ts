import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  CreateSquarePaymentLinkResponse,
  ReservationsService,
} from '../../../core/http/reservations.service';
import { PaymentMethod, ReservationItem } from '../../../shared/models/reservation.model';
import { EventsService } from '../../../core/http/events.service';
import { EventItem } from '../../../shared/models/event.model';
import { PhoneDisplayPipe } from '../../../shared/phone-display.pipe';

interface GeneratedPaymentLink {
  url: string;
  amount: number;
  createdAtMs: number;
  audit?: CreateSquarePaymentLinkResponse['square']['audit'];
}

@Component({
  selector: 'app-reservations',
  imports: [CommonModule, ReactiveFormsModule, PhoneDisplayPipe],
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
  paymentLinkLoadingId: string | null = null;
  paymentLinkError: string | null = null;
  paymentLinkNotice: string | null = null;
  paymentLinksByReservationId: Record<string, GeneratedPaymentLink> = {};

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
        this.items = [...items].sort((a, b) =>
          (a.tableId || '').localeCompare(b.tableId || '', undefined, {
            numeric: true,
            sensitivity: 'base',
          })
        );
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
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;
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

  canGeneratePaymentLink(item: ReservationItem): boolean {
    return (
      item.status === 'CONFIRMED' &&
      item.paymentStatus !== 'PAID' &&
      item.paymentStatus !== 'COURTESY'
    );
  }

  getPaymentLink(item: ReservationItem | null | undefined): GeneratedPaymentLink | null {
    if (!item?.reservationId) return null;
    return this.paymentLinksByReservationId[item.reservationId] ?? null;
  }

  generatePaymentLink(item: ReservationItem): void {
    if (!this.canGeneratePaymentLink(item)) return;
    if (this.paymentLinkLoadingId) return;

    const remaining = this.remainingAmount(item);
    if (remaining <= 0) return;

    this.paymentLinkLoadingId = item.reservationId;
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;

    this.reservationsApi
      .createSquarePaymentLink({
        reservationId: item.reservationId,
        eventDate: item.eventDate,
        amount: remaining,
        note: `Payment link for table ${item.tableId}`,
      })
      .subscribe({
        next: (res) => {
          const url = String(res?.square?.url ?? '').trim();
          if (!url) {
            this.paymentLinkError = 'Payment link generation succeeded but no URL was returned.';
            this.paymentLinkLoadingId = null;
            return;
          }
          this.paymentLinksByReservationId[item.reservationId] = {
            url,
            amount: Number(res?.reservation?.linkAmount ?? remaining),
            createdAtMs: Date.now(),
            audit: res?.square?.audit,
          };
          this.paymentLinkNotice = 'Payment link ready to share.';
          this.paymentLinkLoadingId = null;
        },
        error: (err) => {
          this.paymentLinkError =
            err?.error?.message || err?.message || 'Failed to generate payment link';
          this.paymentLinkLoadingId = null;
        },
      });
  }

  copyPaymentLink(item: ReservationItem): void {
    const link = this.getPaymentLink(item);
    if (!link) return;
    this.paymentLinkError = null;
    this.writeClipboard(link.url).then((ok) => {
      this.paymentLinkNotice = ok
        ? 'Payment link copied.'
        : 'Copy failed. Please copy manually from the link box.';
    });
  }

  openSmsShare(item: ReservationItem): void {
    const link = this.getPaymentLink(item);
    if (!link) return;
    const body = this.buildShareMessage(item, link.url);
    const recipient = this.toSmsRecipient(item.phone);
    const target = recipient ? `sms:${recipient}?&body=${encodeURIComponent(body)}` : `sms:?&body=${encodeURIComponent(body)}`;
    window.open(target, '_blank');
  }

  openWhatsAppShare(item: ReservationItem): void {
    const link = this.getPaymentLink(item);
    if (!link) return;
    const body = this.buildShareMessage(item, link.url);
    const recipient = this.toWhatsAppRecipient(item.phone);
    const target = recipient
      ? `https://wa.me/${recipient}?text=${encodeURIComponent(body)}`
      : `https://wa.me/?text=${encodeURIComponent(body)}`;
    window.open(target, '_blank');
  }

  sharePaymentLink(item: ReservationItem): void {
    const link = this.getPaymentLink(item);
    if (!link) return;
    const body = this.buildShareMessage(item, link.url);
    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator
        .share({
          text: body,
          url: link.url,
        })
        .catch(() => {
          this.copyPaymentLink(item);
        });
      return;
    }
    this.copyPaymentLink(item);
  }

  paymentLinkShareMessage(item: ReservationItem): string {
    const link = this.getPaymentLink(item);
    if (!link) return '';
    return this.buildShareMessage(item, link.url);
  }

  private remainingAmount(item: ReservationItem): number {
    const due = Number(item.amountDue ?? 0);
    const paid = Number(item.depositAmount ?? 0);
    return Math.max(0, Number((due - paid).toFixed(2)));
  }

  private buildShareMessage(item: ReservationItem, url: string): string {
    return `Hi ${item.customerName}, here is your table payment link for ${item.eventDate} table ${item.tableId}: ${url}`;
  }

  private toSmsRecipient(phone: string | undefined): string {
    const raw = String(phone ?? '').trim();
    if (!raw) return '';
    return raw.replace(/[^\d+]/g, '');
  }

  private toWhatsAppRecipient(phone: string | undefined): string {
    const raw = String(phone ?? '').trim();
    if (!raw) return '';
    return raw.replace(/\D/g, '');
  }

  private async writeClipboard(text: string): Promise<boolean> {
    const value = String(text ?? '').trim();
    if (!value) return false;
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
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

  formatDeadline(deadlineAt?: string | null, eventDate?: string): string {
    if (!deadlineAt) return '—';
    const match = String(deadlineAt)
      .trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/);
    if (!match) return String(deadlineAt);

    const [, yyyy, mm, dd, hh, min] = match;
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthIndex = Number(mm) - 1;
    const month = monthNames[monthIndex] ?? mm;
    const hour24 = Number(hh);
    const isPm = hour24 >= 12;
    const hour12 = hour24 % 12 || 12;
    const amPm = isPm ? 'PM' : 'AM';
    const timeLabel = `${hour12}:${min} ${amPm}`;

    if (eventDate && this.isNextDay(deadlineAt, eventDate)) {
      return `${timeLabel} (+1 DAY)`;
    }

    return `${month} ${Number(dd)}, ${yyyy} ${timeLabel}`;
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
}
