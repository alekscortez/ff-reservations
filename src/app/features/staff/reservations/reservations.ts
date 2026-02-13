import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  CreateSquarePaymentLinkResponse,
  ReservationsService,
} from '../../../core/http/reservations.service';
import { CheckInPass, CheckInService } from '../../../core/http/check-in.service';
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

interface GeneratedCheckInPass {
  passId: string;
  url: string;
  token: string;
  qrPayload: string;
  createdAtMs: number;
}

interface CheckInPassState {
  passId: string;
  status: string;
  issuedAt: number | null;
  usedAt: number | null;
  usedBy: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
  expiresAt: number | null;
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
  private checkInApi = inject(CheckInService);

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
  checkInPassLoadingId: string | null = null;
  checkInPassError: string | null = null;
  checkInPassNotice: string | null = null;
  checkInPassByReservationId: Record<string, GeneratedCheckInPass> = {};
  checkInPassStateByReservationId: Record<string, CheckInPassState> = {};

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
    this.checkInPassError = null;
    this.checkInPassNotice = null;
    this.loadCheckInPass(item);
  }

  closeDetails(): void {
    this.showDetailsModal = false;
    this.detailItem = null;
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;
    this.checkInPassError = null;
    this.checkInPassNotice = null;
  }

  canManageCheckInPass(item: ReservationItem): boolean {
    return item.status === 'CONFIRMED' && item.paymentStatus === 'PAID';
  }

  canReissueCheckInPass(item: ReservationItem): boolean {
    if (!this.canManageCheckInPass(item)) return false;
    const state = this.getCheckInPassState(item);
    return state?.status !== 'USED';
  }

  getCheckInPass(item: ReservationItem | null | undefined): GeneratedCheckInPass | null {
    if (!item?.reservationId) return null;
    return this.checkInPassByReservationId[item.reservationId] ?? null;
  }

  getCheckInPassState(item: ReservationItem | null | undefined): CheckInPassState | null {
    if (!item?.reservationId) return null;
    return this.checkInPassStateByReservationId[item.reservationId] ?? null;
  }

  loadCheckInPass(item: ReservationItem): void {
    if (!this.canManageCheckInPass(item)) return;
    if (this.checkInPassLoadingId) return;
    this.checkInPassLoadingId = item.reservationId;
    this.checkInPassError = null;
    this.checkInPassNotice = null;

    this.checkInApi.getReservationPass(item.reservationId, item.eventDate).subscribe({
      next: (res) => {
        this.checkInPassLoadingId = null;
        const latestState = this.mapCheckInPassState(res?.latestPass ?? res?.pass);
        if (latestState) {
          this.checkInPassStateByReservationId[item.reservationId] = latestState;
        }
        const pass = this.mapCheckInPass(res?.pass);
        if (!pass) {
          const latestStatus = String(latestState?.status ?? '').toUpperCase();
          if (latestStatus === 'USED') {
            this.checkInPassNotice = 'Client is already checked in.';
          } else if (latestStatus === 'REVOKED') {
            this.checkInPassNotice = 'Latest pass was revoked. Reissue to send a new pass.';
          } else if (latestStatus === 'EXPIRED') {
            this.checkInPassNotice = 'Latest pass expired. Reissue to send a new pass.';
          } else {
            this.checkInPassNotice = 'No active pass found. Use reissue to create a new one.';
          }
          return;
        }
        this.checkInPassByReservationId[item.reservationId] = pass;
      },
      error: (err) => {
        this.checkInPassError =
          err?.error?.message || err?.message || 'Failed to load check-in pass';
        this.checkInPassLoadingId = null;
      },
    });
  }

  reissueCheckInPass(item: ReservationItem): void {
    if (!this.canReissueCheckInPass(item)) return;
    if (this.checkInPassLoadingId) return;
    this.checkInPassLoadingId = item.reservationId;
    this.checkInPassError = null;
    this.checkInPassNotice = null;

    this.checkInApi.issueReservationPass(item.reservationId, item.eventDate, true).subscribe({
      next: (res) => {
        this.checkInPassLoadingId = null;
        const latestState = this.mapCheckInPassState(res?.latestPass ?? res?.pass);
        if (latestState) {
          this.checkInPassStateByReservationId[item.reservationId] = latestState;
        }
        const pass = this.mapCheckInPass(res?.pass);
        if (!pass) {
          this.checkInPassError = 'Pass reissued but no link was returned.';
          return;
        }
        this.checkInPassByReservationId[item.reservationId] = pass;
        this.checkInPassNotice = 'Check-in pass reissued.';
      },
      error: (err) => {
        this.checkInPassError =
          err?.error?.message || err?.message || 'Failed to reissue check-in pass';
        this.checkInPassLoadingId = null;
      },
    });
  }

  copyCheckInPassLink(item: ReservationItem): void {
    const pass = this.getCheckInPass(item);
    if (!pass) return;
    this.checkInPassError = null;
    this.writeClipboard(pass.url).then((ok) => {
      this.checkInPassNotice = ok
        ? 'Check-in pass link copied.'
        : 'Copy failed. Please copy manually.';
    });
  }

  openSmsShareCheckInPass(item: ReservationItem): void {
    const pass = this.getCheckInPass(item);
    if (!pass) return;
    const body = this.buildCheckInPassShareMessage(item, pass.url);
    const recipient = this.toSmsRecipient(item.phone);
    const target = recipient ? `sms:${recipient}?&body=${encodeURIComponent(body)}` : `sms:?&body=${encodeURIComponent(body)}`;
    window.open(target, '_blank');
  }

  openWhatsAppShareCheckInPass(item: ReservationItem): void {
    const pass = this.getCheckInPass(item);
    if (!pass) return;
    const body = this.buildCheckInPassShareMessage(item, pass.url);
    const recipient = this.toWhatsAppRecipient(item.phone);
    const target = recipient
      ? `https://wa.me/${recipient}?text=${encodeURIComponent(body)}`
      : `https://wa.me/?text=${encodeURIComponent(body)}`;
    window.open(target, '_blank');
  }

  shareCheckInPassLink(item: ReservationItem): void {
    const pass = this.getCheckInPass(item);
    if (!pass) return;
    const body = this.buildCheckInPassShareMessage(item, pass.url);
    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator
        .share({
          text: body,
          url: pass.url,
        })
        .catch(() => {
          this.copyCheckInPassLink(item);
        });
      return;
    }
    this.copyCheckInPassLink(item);
  }

  checkInPassShareMessage(item: ReservationItem): string {
    const pass = this.getCheckInPass(item);
    if (!pass) return '';
    return this.buildCheckInPassShareMessage(item, pass.url);
  }

  checkInStateLabel(status: string | null | undefined): string {
    const normalized = String(status ?? '').toUpperCase();
    if (normalized === 'USED') return 'Checked In';
    if (normalized === 'ISSUED') return 'Issued';
    if (normalized === 'REVOKED') return 'Revoked';
    if (normalized === 'EXPIRED') return 'Expired';
    return 'Unknown';
  }

  checkInStateBadgeClass(status: string | null | undefined): string {
    const normalized = String(status ?? '').toUpperCase();
    if (normalized === 'USED') return 'border-success-300 bg-success-100 text-success-800';
    if (normalized === 'ISSUED') return 'border-brand-300 bg-brand-100 text-brand-800';
    if (normalized === 'REVOKED') return 'border-danger-300 bg-danger-100 text-danger-800';
    if (normalized === 'EXPIRED') return 'border-warning-300 bg-warning-100 text-warning-800';
    return 'border-brand-200 bg-brand-50 text-brand-700';
  }

  epochSecondsToMs(value: number | null | undefined): number | null {
    const epoch = Number(value ?? 0);
    return Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : null;
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

  private buildCheckInPassShareMessage(item: ReservationItem, url: string): string {
    return `Hi ${item.customerName}, here is your FF check-in pass for ${item.eventDate} table ${item.tableId}: ${url}`;
  }

  private mapCheckInPass(pass: CheckInPass | null | undefined): GeneratedCheckInPass | null {
    const passId = String(pass?.passId ?? '').trim();
    const url = String(pass?.url ?? '').trim();
    const token = String(pass?.token ?? '').trim();
    const qrPayload = String(pass?.qrPayload ?? '').trim();
    if (!passId || !url || !token || !qrPayload) return null;
    return {
      passId,
      url,
      token,
      qrPayload,
      createdAtMs: Date.now(),
    };
  }

  private mapCheckInPassState(pass: CheckInPass | null | undefined): CheckInPassState | null {
    const passId = String(pass?.passId ?? '').trim();
    if (!passId) return null;
    return {
      passId,
      status: String(pass?.status ?? '').trim().toUpperCase() || 'UNKNOWN',
      issuedAt: Number(pass?.issuedAt ?? 0) || null,
      usedAt: Number(pass?.usedAt ?? 0) || null,
      usedBy: String(pass?.usedBy ?? '').trim() || null,
      revokedAt: Number(pass?.revokedAt ?? 0) || null,
      revokedBy: String(pass?.revokedBy ?? '').trim() || null,
      expiresAt: Number(pass?.expiresAt ?? 0) || null,
    };
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
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Fall through to legacy copy.
      }
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      return copied;
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
