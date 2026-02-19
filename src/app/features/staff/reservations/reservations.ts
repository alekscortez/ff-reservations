import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  CreateSquarePaymentLinkResponse,
  ReservationHistoryItem,
  ReservationsService,
} from '../../../core/http/reservations.service';
import { CheckInPass, CheckInService } from '../../../core/http/check-in.service';
import { PaymentMethod, ReservationItem } from '../../../shared/models/reservation.model';
import { EventsService } from '../../../core/http/events.service';
import { EventItem } from '../../../shared/models/event.model';
import { PhoneDisplayPipe } from '../../../shared/phone-display.pipe';
import { PaymentMethodLabelPipe } from '../../../shared/payment-method-label.pipe';
import { SystemActorLabelPipe } from '../../../shared/system-actor-label.pipe';
import { ClientsService, RescheduleCredit } from '../../../core/http/clients.service';
import { SquareWebPaymentsService } from '../../../core/payments/square-web-payments.service';

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

interface ReservationHistoryViewItem {
  eventId: string;
  eventType: string;
  atMs: number;
  actor: string;
  source: string | null;
  details: Record<string, unknown> | null;
}

interface PaymentLinkSmsState {
  status: 'SENT' | 'FAILED';
  atMs: number;
  to: string | null;
  errorMessage: string | null;
}

@Component({
  selector: 'app-reservations',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    PhoneDisplayPipe,
    PaymentMethodLabelPipe,
    SystemActorLabelPipe,
  ],
  templateUrl: './reservations.html',
  styleUrl: './reservations.scss',
})
export class Reservations implements OnInit, OnDestroy {
  private reservationsApi = inject(ReservationsService);
  private eventsApi = inject(EventsService);
  private checkInApi = inject(CheckInService);
  private clientsApi = inject(ClientsService);
  private squareWebPayments = inject(SquareWebPaymentsService);

  filterDate = new FormControl('', { nonNullable: true });
  items: ReservationItem[] = [];
  loading = false;
  error: string | null = null;
  events: EventItem[] = [];
  eventsLoading = false;
  eventsError: string | null = null;
  businessDate = this.todayString();
  cashReceiptNumberRequired = true;
  squareEnvMode: 'sandbox' | 'production' = 'sandbox';
  squareApplicationId = '';
  squareLocationId = '';
  contextPreferredEventDate: string | null = null;
  detailItem: ReservationItem | null = null;
  showDetailsModal = false;
  paymentItem: ReservationItem | null = null;
  showPaymentModal = false;
  paymentSubmitAttempted = false;
  paymentCredits: RescheduleCredit[] = [];
  paymentCreditsLoading = false;
  paymentCreditsError: string | null = null;
  paymentLinkLoadingId: string | null = null;
  publicPayLinkLoadingId: string | null = null;
  paymentLinkError: string | null = null;
  paymentLinkNotice: string | null = null;
  paymentLinksByReservationId: Record<string, GeneratedPaymentLink> = {};
  checkInPassLoadingId: string | null = null;
  checkInPassError: string | null = null;
  checkInPassNotice: string | null = null;
  checkInPassByReservationId: Record<string, GeneratedCheckInPass> = {};
  checkInPassStateByReservationId: Record<string, CheckInPassState> = {};
  historyLoadingId: string | null = null;
  historyError: string | null = null;
  historyByReservationId: Record<string, ReservationHistoryViewItem[]> = {};
  cashAppPayPreparing = false;
  cashAppPayReady = false;
  @ViewChild('cashAppPayHost') cashAppPayHost?: ElementRef<HTMLElement>;
  private cashAppPayDestroy: (() => Promise<void>) | null = null;

  paymentForm = new FormGroup({
    amount: new FormControl(0, { nonNullable: true, validators: [Validators.min(0.01)] }),
    method: new FormControl<PaymentMethod>('square', { nonNullable: true }),
    creditId: new FormControl('', { nonNullable: true }),
    remainingMethod: new FormControl<'cash' | 'square'>('cash', {
      nonNullable: true,
    }),
    receiptNumber: new FormControl('', { nonNullable: true }),
    note: new FormControl('', { nonNullable: true }),
  });

  ngOnInit(): void {
    this.loadContextAndEvents();
  }

  ngOnDestroy(): void {
    this.showDetailsModal = false;
    this.showPaymentModal = false;
    this.syncSidebarModalLock();
    void this.destroyCashAppPayButton();
  }

  private loadContextAndEvents(): void {
    this.eventsApi.getCurrentContext().subscribe({
      next: (ctx) => {
        this.businessDate = String(ctx?.businessDate ?? '').trim() || this.todayString();
        this.cashReceiptNumberRequired = this.normalizeBooleanSetting(
          ctx?.settings?.cashReceiptNumberRequired,
          true
        );
        this.squareEnvMode = ctx?.settings?.squareEnvMode === 'production' ? 'production' : 'sandbox';
        this.squareApplicationId = String(ctx?.settings?.squareApplicationId ?? '').trim();
        this.squareLocationId = String(ctx?.settings?.squareLocationId ?? '').trim();
        this.contextPreferredEventDate =
          String(ctx?.event?.eventDate ?? '').trim() ||
          String(ctx?.nextEvent?.eventDate ?? '').trim() ||
          null;
        this.loadEvents();
      },
      error: () => {
        this.businessDate = this.todayString();
        this.cashReceiptNumberRequired = true;
        this.contextPreferredEventDate = null;
        this.loadEvents();
      },
    });
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
    return this.events
      .filter((e) => (e.eventDate || '') >= this.businessDate)
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
    if (this.contextPreferredEventDate) {
      const hasPreferred = this.events.some((e) => e.eventDate === this.contextPreferredEventDate);
      if (hasPreferred) {
        this.filterDate.setValue(this.contextPreferredEventDate);
        this.load();
        return;
      }
    }
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
        this.hydrateStoredPaymentLinks(this.items);
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
    const isRescheduleRequest = window.confirm(
      'Is this a reservation credit request (no refund)?'
    );
    const resolutionType = isRescheduleRequest
      ? 'RESCHEDULE_CREDIT'
      : 'CANCEL_NO_REFUND';
    this.loading = true;
    this.error = null;
    this.reservationsApi
      .cancel(
        item.reservationId,
        item.eventDate,
        item.tableId,
        reason.trim(),
        resolutionType
      )
      .subscribe({
      next: () => {
        this.items = this.items.map((x) =>
          x.reservationId === item.reservationId
            ? { ...x, status: 'CANCELLED', cancelReason: reason.trim() }
            : x
        );
        const updated = this.items.find((x) => x.reservationId === item.reservationId) ?? null;
        if (updated && this.detailItem?.reservationId === item.reservationId) {
          this.detailItem = updated;
        }
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to cancel reservation';
        this.loading = false;
      },
    });
  }

  onReservationRowClick(item: ReservationItem): void {
    this.openDetails(item);
  }

  onReservationRowKeydown(event: KeyboardEvent, item: ReservationItem): void {
    const target = event.target as HTMLElement | null;
    const interactiveTag = String(target?.tagName ?? '').toUpperCase();
    if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(interactiveTag)) return;
    const key = String(event.key || '').toLowerCase();
    if (key !== 'enter' && key !== ' ') return;
    event.preventDefault();
    this.openDetails(item);
  }

  onTakePaymentFromList(event: Event, item: ReservationItem): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.canTakePayment(item)) return;
    this.openPayment(item);
  }

  openPaymentFromDetails(item: ReservationItem): void {
    if (!this.canTakePayment(item)) return;
    this.closeDetails();
    this.openPayment(item);
  }

  canTakePayment(item: ReservationItem): boolean {
    return (
      !this.isPastEvent(item) &&
      item.status === 'CONFIRMED' &&
      item.paymentStatus !== 'PAID' &&
      item.paymentStatus !== 'COURTESY' &&
      this.remainingAmount(item) > 0
    );
  }

  canCancelReservation(item: ReservationItem): boolean {
    return !this.isPastEvent(item) && item.status === 'CONFIRMED';
  }

  isPastEvent(item: ReservationItem): boolean {
    const eventDate = String(item?.eventDate ?? '').trim();
    if (!eventDate) return false;
    return eventDate < this.businessDate;
  }

  paymentStatusLabel(item: ReservationItem): string {
    if (item.status === 'CANCELLED') return 'Cancelled';
    const status = String(item.paymentStatus ?? '').trim().toUpperCase();
    if (!status) return 'Unknown';
    if (status === 'PENDING') return 'Pending';
    if (status === 'PARTIAL') return 'Partial';
    if (status === 'PAID') return 'Paid';
    if (status === 'COURTESY') return 'Courtesy';
    return status;
  }

  paymentStatusBadgeClass(item: ReservationItem): string {
    if (item.status === 'CANCELLED') {
      return 'border-danger-300 bg-danger-100 text-danger-800';
    }
    const status = String(item.paymentStatus ?? '').trim().toUpperCase();
    if (status === 'PAID') return 'border-success-300 bg-success-100 text-success-800';
    if (status === 'PARTIAL') return 'border-warning-300 bg-warning-100 text-warning-800';
    if (status === 'PENDING') return 'border-warning-300 bg-warning-100 text-warning-800';
    if (status === 'COURTESY') return 'border-brand-300 bg-brand-100 text-brand-800';
    return 'border-brand-200 bg-brand-50 text-brand-700';
  }

  reservationListMeta(item: ReservationItem): string {
    if (item.status === 'CANCELLED') return 'Reservation cancelled';
    const remaining = this.remainingAmount(item);
    const status = String(item.paymentStatus ?? '').trim().toUpperCase();
    if (status === 'PAID') return 'Paid in full';
    if (status === 'COURTESY') return 'Courtesy reservation';
    if (status === 'PARTIAL') return `Remaining $${remaining.toFixed(2)}`;
    if (status === 'PENDING') return `Pending $${remaining.toFixed(2)}`;
    return `Remaining $${remaining.toFixed(2)}`;
  }

  remainingDisplayAmount(item: ReservationItem): number {
    if (item.status === 'CANCELLED') return 0;
    return this.remainingAmount(item);
  }

  openDetails(item: ReservationItem): void {
    this.detailItem = item;
    this.showDetailsModal = true;
    this.syncSidebarModalLock();
    this.checkInPassError = null;
    this.checkInPassNotice = null;
    this.loadCheckInPass(item);
    this.loadHistory(item);
  }

  closeDetails(): void {
    this.showDetailsModal = false;
    this.detailItem = null;
    this.syncSidebarModalLock();
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;
    this.publicPayLinkLoadingId = null;
    this.checkInPassError = null;
    this.checkInPassNotice = null;
    this.historyError = null;
  }

  getHistory(item: ReservationItem | null | undefined): ReservationHistoryViewItem[] {
    if (!item?.reservationId) return [];
    return this.historyByReservationId[item.reservationId] ?? [];
  }

  loadHistory(item: ReservationItem): void {
    if (this.historyLoadingId === item.reservationId) return;
    this.historyLoadingId = item.reservationId;
    this.historyError = null;
    this.reservationsApi.listHistory(item.reservationId, item.eventDate).subscribe({
      next: (items) => {
        this.historyByReservationId[item.reservationId] = (items ?? [])
          .map((entry) => this.mapHistoryItem(entry))
          .filter((entry): entry is ReservationHistoryViewItem => entry !== null);
        this.historyLoadingId = null;
      },
      error: (err) => {
        this.historyError = err?.error?.message || err?.message || 'Failed to load history';
        this.historyLoadingId = null;
      },
    });
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
    this.paymentSubmitAttempted = false;
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;
    this.cashAppPayReady = false;
    this.cashAppPayPreparing = false;
    void this.destroyCashAppPayButton();
    this.syncSidebarModalLock();
    const due = Number(item.amountDue ?? 0);
    const paid = Number(item.depositAmount ?? 0);
    const balance = Math.max(0, due - paid);
    this.paymentForm.setValue({
      amount: balance > 0 ? balance : 0,
      method: 'square',
      creditId: '',
      remainingMethod: 'cash',
      receiptNumber: '',
      note: '',
    });
    this.loadRescheduleCreditsForPayment(item);
  }

  isSquarePaymentMethodSelected(): boolean {
    return this.paymentForm.controls.method.value === 'square';
  }

  isCashAppPaymentMethodSelected(): boolean {
    return this.paymentForm.controls.method.value === 'cashapp';
  }

  isCreditPaymentMethodSelected(): boolean {
    return this.paymentForm.controls.method.value === 'credit';
  }

  canUseCashAppPay(): boolean {
    return (
      this.isCashAppPaymentMethodSelected() &&
      Boolean(this.squareApplicationId) &&
      Boolean(this.squareLocationId)
    );
  }

  submitSquarePaymentFromModal(): void {
    const item = this.paymentItem;
    if (!item) return;
    if (!this.canGeneratePaymentLink(item)) return;
    if (this.paymentLinkLoadingId) return;

    this.generatePaymentLink(item);
    this.closePayment();
    this.openDetails(item);
  }

  async submitCashAppPaymentFromModal(): Promise<void> {
    const item = this.paymentItem;
    if (!item) return;
    if (!this.canGeneratePaymentLink(item)) return;
    if (this.loading || this.cashAppPayPreparing) return;
    if (!this.canUseCashAppPay()) {
      this.paymentLinkError = 'Cash App Pay is not configured in Square settings.';
      return;
    }

    this.paymentSubmitAttempted = true;
    const amount = Number(this.paymentForm.controls.amount.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      this.paymentForm.controls.amount.markAsTouched();
      return;
    }
    const remaining = this.remainingAmount(item);
    if (amount > remaining) {
      this.paymentLinkError = 'Amount cannot exceed remaining balance.';
      return;
    }

    this.error = null;
    this.paymentLinkError = null;
    const note = String(this.paymentForm.controls.note.value ?? '').trim();
    await this.prepareCashAppPayButton(item, amount, note);
  }

  closePayment(): void {
    this.showPaymentModal = false;
    this.paymentItem = null;
    this.paymentSubmitAttempted = false;
    this.syncSidebarModalLock();
    this.paymentForm.reset({
      amount: 0,
      method: 'square',
      creditId: '',
      remainingMethod: 'cash',
      receiptNumber: '',
      note: '',
    });
    this.paymentCredits = [];
    this.paymentCreditsLoading = false;
    this.paymentCreditsError = null;
    this.paymentLinkError = null;
    this.cashAppPayReady = false;
    this.cashAppPayPreparing = false;
    void this.destroyCashAppPayButton();
  }

  canGeneratePaymentLink(item: ReservationItem): boolean {
    return (
      item.status === 'CONFIRMED' &&
      !this.isPastEvent(item) &&
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
    if (this.paymentLinkLoadingId || this.publicPayLinkLoadingId) return;

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

  generateClientPayLink(item: ReservationItem): void {
    if (!this.canGeneratePaymentLink(item)) return;
    if (this.paymentLinkLoadingId || this.publicPayLinkLoadingId) return;

    const remaining = this.remainingAmount(item);
    if (remaining <= 0) return;

    this.publicPayLinkLoadingId = item.reservationId;
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;

    this.reservationsApi
      .createPublicPayLink({
        reservationId: item.reservationId,
        eventDate: item.eventDate,
        amount: remaining,
      })
      .subscribe({
        next: (res) => {
          const url = String(res?.publicPay?.url ?? '').trim();
          if (!url) {
            this.paymentLinkError = 'Client pay link generation succeeded but no URL was returned.';
            this.publicPayLinkLoadingId = null;
            return;
          }
          this.paymentLinksByReservationId[item.reservationId] = {
            url,
            amount: Number(res?.reservation?.linkAmount ?? remaining),
            createdAtMs: Date.now(),
          };
          const ttlMinutes = Number(res?.publicPay?.ttlMinutes ?? 0);
          this.paymentLinkNotice =
            Number.isFinite(ttlMinutes) && ttlMinutes > 0
              ? `Cash App link ready to share (expires in ${Math.round(ttlMinutes)} min).`
              : 'Cash App link ready to share.';
          this.publicPayLinkLoadingId = null;
        },
        error: (err) => {
          this.paymentLinkError =
            err?.error?.message || err?.message || 'Failed to generate Cash App link';
          this.publicPayLinkLoadingId = null;
        },
      });
  }

  sendPaymentLinkSms(item: ReservationItem): void {
    if (!this.canGeneratePaymentLink(item)) return;
    if (this.paymentLinkLoadingId || this.publicPayLinkLoadingId) return;

    const remaining = this.remainingAmount(item);
    if (remaining <= 0) return;

    this.paymentLinkLoadingId = item.reservationId;
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;

    this.reservationsApi
      .createSquarePaymentLinkSms({
        reservationId: item.reservationId,
        eventDate: item.eventDate,
        amount: remaining,
        note: `Payment link for table ${item.tableId} via SMS`,
      })
      .subscribe({
        next: (res) => {
          const url = String(res?.square?.url ?? '').trim();
          if (!url) {
            this.paymentLinkError = 'SMS sent flow succeeded but no payment URL was returned.';
            this.paymentLinkLoadingId = null;
            return;
          }
          this.paymentLinksByReservationId[item.reservationId] = {
            url,
            amount: Number(res?.reservation?.linkAmount ?? remaining),
            createdAtMs: Date.now(),
            audit: res?.square?.audit,
          };
          const to = String(res?.sms?.to ?? '').trim();
          const messageId = String(res?.sms?.messageId ?? '').trim();
          this.paymentLinkNotice = to
            ? `SMS sent to ${to}${messageId ? ` (${messageId})` : ''}.`
            : 'SMS sent successfully.';
          this.paymentLinkLoadingId = null;
        },
        error: (err) => {
          this.paymentLinkError =
            err?.error?.message || err?.message || 'Failed to send payment link SMS';
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

  getPaymentLinkSmsState(item: ReservationItem | null | undefined): PaymentLinkSmsState | null {
    const history = this.getHistory(item);
    if (!history.length) return null;
    const smsEvent = history.find((entry) => {
      const type = String(entry?.eventType ?? '').trim().toUpperCase();
      return type === 'PAYMENT_LINK_SMS_SENT' || type === 'PAYMENT_LINK_SMS_FAILED';
    });
    if (!smsEvent) return null;
    const details = smsEvent.details ?? {};
    const eventType = String(smsEvent.eventType ?? '').trim().toUpperCase();
    return {
      status: eventType === 'PAYMENT_LINK_SMS_SENT' ? 'SENT' : 'FAILED',
      atMs: smsEvent.atMs,
      to: this.historyString(details['to']),
      errorMessage: this.historyString(details['errorMessage']),
    };
  }

  paymentLinkSmsBadgeClass(status: string | null | undefined): string {
    const normalized = String(status ?? '').trim().toUpperCase();
    if (normalized === 'SENT') return 'border-success-300 bg-success-100 text-success-800';
    if (normalized === 'FAILED') return 'border-danger-300 bg-danger-100 text-danger-800';
    return 'border-brand-200 bg-brand-50 text-brand-700';
  }

  historyEventLabel(eventType: string): string {
    const normalized = String(eventType ?? '').trim().toUpperCase();
    if (normalized === 'RESERVATION_CREATED') return 'Reservation Created';
    if (normalized === 'PAYMENT_RECORDED') return 'Payment Recorded';
    if (normalized === 'PAYMENT_LINK_SMS_SENT') return 'Payment Request Sent';
    if (normalized === 'PAYMENT_LINK_SMS_FAILED') return 'Payment Request Failed';
    if (normalized === 'CHECKIN_PASS_SMS_SENT') return 'Check-In Pass Sent';
    if (normalized === 'CHECKIN_PASS_SMS_FAILED') return 'Check-In Pass Failed';
    if (normalized === 'RESCHEDULE_CREDIT_ISSUED') return 'Reservation Credit Issued';
    if (normalized === 'RESCHEDULE_CREDIT_APPLIED') return 'Reservation Credit Applied';
    if (normalized === 'RESERVATION_CANCELLED') return 'Reservation Cancelled';
    if (normalized === 'CHECKIN_PASS_ISSUED') return 'Check-In Pass Issued';
    if (normalized === 'CHECKIN_PASS_REISSUED') return 'Check-In Pass Reissued';
    if (normalized === 'CHECKED_IN') return 'Checked In';
    return normalized.replace(/_/g, ' ');
  }

  historyEventBadgeClass(eventType: string): string {
    const normalized = String(eventType ?? '').trim().toUpperCase();
    if (normalized === 'CHECKED_IN') return 'bg-success-100 text-success-700 border-success-200';
    if (normalized === 'PAYMENT_RECORDED') return 'bg-brand-100 text-brand-700 border-brand-200';
    if (normalized === 'PAYMENT_LINK_SMS_SENT') return 'bg-success-100 text-success-700 border-success-200';
    if (normalized === 'PAYMENT_LINK_SMS_FAILED') return 'bg-danger-100 text-danger-700 border-danger-200';
    if (normalized === 'CHECKIN_PASS_SMS_SENT') return 'bg-success-100 text-success-700 border-success-200';
    if (normalized === 'CHECKIN_PASS_SMS_FAILED') return 'bg-danger-100 text-danger-700 border-danger-200';
    if (normalized === 'RESCHEDULE_CREDIT_ISSUED') return 'bg-success-100 text-success-700 border-success-200';
    if (normalized === 'RESCHEDULE_CREDIT_APPLIED') return 'bg-success-100 text-success-700 border-success-200';
    if (normalized === 'RESERVATION_CANCELLED') return 'bg-danger-100 text-danger-700 border-danger-200';
    return 'bg-brand-50 text-brand-700 border-brand-200';
  }

  historySummary(item: ReservationHistoryViewItem): string {
    const details = item.details ?? {};
    const amount = this.historyNumber(details['amount']);
    const method = this.historyString(details['method']);
    const reason = this.historyString(details['reason']);
    const paymentStatus = this.historyString(details['paymentStatus']);
    const receiptNumber = this.historyString(details['receiptNumber']);
    const smsTo = this.historyString(details['to']);
    const smsError = this.historyString(details['errorMessage']);
    const creditAmount = this.historyNumber(details['amount']);
    const creditExpiresAt = this.historyString(details['expiresAt']);

    if (item.eventType === 'PAYMENT_RECORDED' && amount !== null) {
      const methodText = method ? ` · ${this.paymentMethodLabel(method)}` : '';
      const statusText = paymentStatus ? ` · ${paymentStatus}` : '';
      const receiptText = receiptNumber ? ` · Receipt ${receiptNumber}` : '';
      return `$${amount.toFixed(2)}${methodText}${statusText}${receiptText}`;
    }
    if (item.eventType === 'RESERVATION_CANCELLED' && reason) {
      return reason;
    }
    if (item.eventType === 'RESERVATION_CREATED' && paymentStatus) {
      return `Status ${paymentStatus}`;
    }
    if (item.eventType === 'PAYMENT_LINK_SMS_SENT') {
      return smsTo ? `Sent to ${smsTo}` : 'SMS sent';
    }
    if (item.eventType === 'PAYMENT_LINK_SMS_FAILED') {
      return smsError || 'SMS send failed';
    }
    if (item.eventType === 'CHECKIN_PASS_SMS_SENT') {
      return smsTo ? `Sent to ${smsTo}` : 'SMS sent';
    }
    if (item.eventType === 'CHECKIN_PASS_SMS_FAILED') {
      return smsError || 'SMS send failed';
    }
    if (item.eventType === 'RESCHEDULE_CREDIT_ISSUED') {
      const amountText = creditAmount !== null ? `$${creditAmount.toFixed(2)}` : 'Credit issued';
      return creditExpiresAt ? `${amountText} · Expires ${creditExpiresAt}` : amountText;
    }
    if (item.eventType === 'RESCHEDULE_CREDIT_APPLIED') {
      return amount !== null ? `$${amount.toFixed(2)}` : 'Credit applied';
    }
    return '';
  }

  private remainingAmount(item: ReservationItem): number {
    const due = Number(item.amountDue ?? 0);
    const paid = Number(item.depositAmount ?? 0);
    return Math.max(0, Number((due - paid).toFixed(2)));
  }

  private hydrateStoredPaymentLinks(items: ReservationItem[]): void {
    const next: Record<string, GeneratedPaymentLink> = { ...this.paymentLinksByReservationId };
    for (const item of items) {
      const reservationId = String(item?.reservationId ?? '').trim();
      if (!reservationId) continue;
      const url = String(item?.paymentLinkUrl ?? '').trim();
      const linkStatus = String(item?.paymentLinkStatus ?? '').trim().toUpperCase();
      const isActive = !linkStatus || linkStatus === 'ACTIVE';

      if (url && isActive) {
        const createdAt = Number(item?.paymentLinkCreatedAt ?? 0);
        const remaining = this.remainingAmount(item);
        const fallbackAmount = Number(item?.amountDue ?? item?.tablePrice ?? 0);
        next[reservationId] = {
          url,
          amount: Number((remaining > 0 ? remaining : fallbackAmount).toFixed(2)),
          createdAtMs: createdAt > 0 ? createdAt * 1000 : Date.now(),
          audit: next[reservationId]?.audit,
        };
      } else if (linkStatus && linkStatus !== 'ACTIVE') {
        delete next[reservationId];
      }
    }
    this.paymentLinksByReservationId = next;
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

  private mapHistoryItem(entry: ReservationHistoryItem | null | undefined): ReservationHistoryViewItem | null {
    const eventId = String(entry?.eventId ?? '').trim();
    const eventType = String(entry?.eventType ?? '').trim().toUpperCase();
    const at = Number(entry?.at ?? 0);
    if (!eventId || !eventType || !Number.isFinite(at) || at <= 0) return null;
    const detailsRaw = entry?.details;
    const details =
      detailsRaw && typeof detailsRaw === 'object' && !Array.isArray(detailsRaw)
        ? (detailsRaw as Record<string, unknown>)
        : null;
    return {
      eventId,
      eventType,
      atMs: at * 1000,
      actor: String(entry?.actor ?? '').trim() || 'system',
      source: String(entry?.source ?? '').trim() || null,
      details,
    };
  }

  private historyString(value: unknown): string | null {
    const text = String(value ?? '').trim();
    return text ? text : null;
  }

  private historyNumber(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private paymentMethodLabel(value: string): string {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'cash') return 'Cash';
    if (normalized === 'cashapp') return 'Cash App Pay';
    if (normalized === 'square') return 'Square';
    if (normalized === 'credit') return 'Reservation Credit';
    return normalized
      .replace(/[_-]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
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

  private syncSidebarModalLock(): void {
    if (typeof document === 'undefined') return;
    const isModalOpen = this.showDetailsModal || this.showPaymentModal;
    document.body.classList.toggle('reservations-modal-open', isModalOpen);
  }

  submitPayment(): void {
    if (!this.paymentItem) return;
    const method = this.paymentForm.controls.method.value;
    if (method === 'square') {
      this.submitSquarePaymentFromModal();
      return;
    }
    if (method === 'cashapp') {
      void this.submitCashAppPaymentFromModal();
      return;
    }
    this.paymentSubmitAttempted = true;
    if (this.paymentForm.invalid) return;
    const selectedCredit = this.selectedPaymentCredit();
    if (method === 'credit' && !selectedCredit) {
      this.paymentCreditsError = 'Select a valid reservation credit to apply.';
      return;
    }
    const remainingMethod = this.paymentForm.controls.remainingMethod.value;
    const receiptNumber = this.normalizedReceiptNumber();
    if (this.isCashReceiptRequired() && !receiptNumber) {
      return;
    }
    this.loading = true;
    this.error = null;
    this.paymentLinkError = null;
    this.paymentCreditsError = null;
    const amount = Number(this.paymentForm.controls.amount.value);
    const note = this.paymentForm.controls.note.value;
    const reservationId = this.paymentItem.reservationId;
    const eventDate = this.paymentItem.eventDate;

    if (method === 'credit') {
      const creditAmount = this.creditAppliedAmount();
      if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
        this.paymentCreditsError = 'No credit amount can be applied for this reservation.';
        this.loading = false;
        return;
      }
      this.reservationsApi
        .addPayment({
          reservationId,
          eventDate,
          amount: creditAmount,
          method: 'credit',
          creditId: selectedCredit?.creditId,
          note,
        })
        .subscribe({
          next: (creditRes) => {
            const afterCredit = creditRes.item;
            this.items = this.items.map((x) =>
              x.reservationId === afterCredit.reservationId ? afterCredit : x
            );
            const remaining = this.remainingAmount(afterCredit);
            if (remaining <= 0) {
              this.loading = false;
              this.closePayment();
              return;
            }

            if (remainingMethod === 'square') {
              this.paymentLinkLoadingId = afterCredit.reservationId;
              this.paymentLinkError = null;
              this.paymentLinkNotice = null;
              this.reservationsApi
                .createSquarePaymentLink({
                  reservationId: afterCredit.reservationId,
                  eventDate: afterCredit.eventDate,
                  amount: remaining,
                  note: note || `Remaining payment for table ${afterCredit.tableId}`,
                })
                .subscribe({
                  next: (res) => {
                    const url = String(res?.square?.url ?? '').trim();
                    if (!url) {
                      this.error = 'Credit applied, but Square link URL was not returned.';
                      this.loading = false;
                      this.paymentLinkLoadingId = null;
                      return;
                    }
                    this.paymentLinksByReservationId[afterCredit.reservationId] = {
                      url,
                      amount: Number(res?.reservation?.linkAmount ?? remaining),
                      createdAtMs: Date.now(),
                      audit: res?.square?.audit,
                    };
                    this.paymentLinkNotice = 'Credit applied. Square payment link is ready.';
                    this.loading = false;
                    this.paymentLinkLoadingId = null;
                    this.closePayment();
                    this.openDetails(afterCredit);
                  },
                  error: (err) => {
                    this.error =
                      err?.error?.message ||
                      err?.message ||
                      'Credit applied, but failed to generate Square link';
                    this.loading = false;
                    this.paymentLinkLoadingId = null;
                  },
                });
              return;
            }

            this.reservationsApi
              .addPayment({
                reservationId: afterCredit.reservationId,
                eventDate: afterCredit.eventDate,
                amount: remaining,
                method: remainingMethod,
                receiptNumber: remainingMethod === 'cash' ? receiptNumber : '',
                note: note || 'Remaining balance after credit',
              })
              .subscribe({
                next: (finalRes) => {
                  const updated = finalRes.item;
                  this.items = this.items.map((x) =>
                    x.reservationId === updated.reservationId ? updated : x
                  );
                  this.loading = false;
                  this.closePayment();
                },
                error: (err) => {
                  this.error =
                    err?.error?.message ||
                    err?.message ||
                    'Credit was applied, but failed to process remaining payment';
                  this.loading = false;
                },
              });
          },
          error: (err) => {
            this.error = err?.error?.message || err?.message || 'Failed to apply credit';
            this.loading = false;
          },
        });
      return;
    }

    this.reservationsApi
      .addPayment({
        reservationId,
        eventDate,
        amount,
        method,
        receiptNumber: method === 'cash' ? receiptNumber : '',
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

  onPaymentMethodChanged(): void {
    if (!this.isCashAppPaymentMethodSelected()) {
      this.cashAppPayReady = false;
      this.cashAppPayPreparing = false;
      void this.destroyCashAppPayButton();
    }
    if (!this.isCreditPaymentMethodSelected()) {
      this.paymentForm.controls.creditId.setValue('');
      this.paymentForm.controls.remainingMethod.setValue('cash');
      if (this.paymentForm.controls.method.value !== 'cash') {
        this.paymentForm.controls.receiptNumber.setValue('');
      }
      this.paymentCreditsError = null;
      if (this.paymentItem) {
        this.paymentForm.controls.amount.setValue(this.remainingAmount(this.paymentItem));
      }
      return;
    }
    if (this.paymentItem && !this.paymentCredits.length && !this.paymentCreditsLoading) {
      this.loadRescheduleCreditsForPayment(this.paymentItem);
    }
    if (!this.paymentForm.controls.creditId.value && this.paymentCredits.length === 1) {
      this.paymentForm.controls.creditId.setValue(this.paymentCredits[0].creditId);
    } else if (!this.paymentForm.controls.creditId.value) {
      this.paymentForm.controls.amount.setValue(0);
    }
    if (!this.isCashReceiptRequired()) {
      this.paymentForm.controls.receiptNumber.setValue('');
    }
    this.onPaymentCreditChanged();
  }

  onRemainingMethodChanged(): void {
    if (!this.isCashReceiptRequired()) {
      this.paymentForm.controls.receiptNumber.setValue('');
    }
  }

  onReceiptNumberInput(): void {
    const normalized = this.normalizedReceiptNumber();
    const digitsOnly = normalized.replace(/\D+/g, '').slice(0, 64);
    if (digitsOnly !== this.paymentForm.controls.receiptNumber.value) {
      this.paymentForm.controls.receiptNumber.setValue(digitsOnly, { emitEvent: false });
    }
  }

  onPaymentCreditChanged(): void {
    if (!this.isCreditPaymentMethodSelected()) return;
    const selected = this.selectedPaymentCredit();
    const item = this.paymentItem;
    if (!selected || !item) return;
    const targetAmount = Math.min(this.remainingAmount(item), Number(selected.amountRemaining ?? 0));
    if (targetAmount > 0) {
      this.paymentForm.controls.amount.setValue(Number(targetAmount.toFixed(2)));
    }
  }

  private async prepareCashAppPayButton(
    item: ReservationItem,
    amount: number,
    note: string
  ): Promise<void> {
    const host = this.cashAppPayHost?.nativeElement;
    if (!host) {
      this.paymentLinkError = 'Cash App Pay UI is not ready. Close and reopen the modal, then try again.';
      return;
    }

    this.cashAppPayPreparing = true;
    this.cashAppPayReady = false;
    this.paymentLinkError = null;

    try {
      await this.destroyCashAppPayButton();
      const session = await this.squareWebPayments.mountCashAppPayButton({
        applicationId: this.squareApplicationId,
        locationId: this.squareLocationId,
        amount,
        container: host,
        label: `Table ${item.tableId} payment`,
        referenceId: item.reservationId,
        squareEnvMode: this.squareEnvMode,
        onTokenized: (sourceId) => {
          setTimeout(() => {
            void this.captureCashAppPayment(item, amount, sourceId, note);
          }, 0);
        },
        onError: (message) => {
          setTimeout(() => {
            this.paymentLinkError = message || 'Cash App payment was not completed.';
          }, 0);
        },
      });
      this.cashAppPayDestroy = session.destroy;
      this.cashAppPayReady = true;
    } catch (err: unknown) {
      const message =
        (err as { message?: string } | null | undefined)?.message ||
        'Failed to initialize Cash App Pay.';
      this.paymentLinkError = message;
      this.cashAppPayReady = false;
    } finally {
      this.cashAppPayPreparing = false;
    }
  }

  private async captureCashAppPayment(
    item: ReservationItem,
    amount: number,
    sourceId: string,
    note: string
  ): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    this.paymentLinkError = null;

    this.reservationsApi
      .addSquarePayment({
        reservationId: item.reservationId,
        eventDate: item.eventDate,
        amount,
        sourceId,
        note: note || `Cash App Pay for table ${item.tableId}`,
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
          this.loading = false;
          this.paymentLinkError =
            err?.error?.message || err?.message || 'Failed to process Cash App payment';
        },
      });
  }

  private async destroyCashAppPayButton(): Promise<void> {
    const destroy = this.cashAppPayDestroy;
    this.cashAppPayDestroy = null;
    if (destroy) {
      try {
        await destroy();
      } catch {
        // Best-effort teardown.
      }
    }
    const host = this.cashAppPayHost?.nativeElement;
    if (host) host.innerHTML = '';
  }

  creditAppliedAmount(): number {
    if (!this.isCreditPaymentMethodSelected()) return 0;
    const selected = this.selectedPaymentCredit();
    const item = this.paymentItem;
    if (!selected || !item) return 0;
    const amount = Math.min(this.remainingAmount(item), Number(selected.amountRemaining ?? 0));
    return Number(Math.max(0, amount).toFixed(2));
  }

  creditRemainingAmount(): number {
    if (!this.isCreditPaymentMethodSelected()) return 0;
    const item = this.paymentItem;
    if (!item) return 0;
    const remaining = this.remainingAmount(item) - this.creditAppliedAmount();
    return Number(Math.max(0, remaining).toFixed(2));
  }

  shouldShowRemainingMethodSelector(): boolean {
    return this.isCreditPaymentMethodSelected() && this.creditRemainingAmount() > 0;
  }

  isCashReceiptRequired(): boolean {
    if (!this.cashReceiptNumberRequired) return false;
    if (this.paymentForm.controls.method.value === 'cash') return true;
    return (
      this.isCreditPaymentMethodSelected() &&
      this.creditRemainingAmount() > 0 &&
      this.paymentForm.controls.remainingMethod.value === 'cash'
    );
  }

  shouldShowCashReceiptField(): boolean {
    return this.isCashReceiptRequired();
  }

  shouldShowCashReceiptError(): boolean {
    return this.paymentSubmitAttempted && this.isCashReceiptRequired() && !this.normalizedReceiptNumber();
  }

  cashReceiptLabel(): string {
    if (
      this.isCreditPaymentMethodSelected() &&
      this.creditRemainingAmount() > 0 &&
      this.paymentForm.controls.remainingMethod.value === 'cash'
    ) {
      return 'Remaining Cash Receipt Number';
    }
    return 'Receipt Number';
  }

  private normalizedReceiptNumber(): string {
    return String(this.paymentForm.controls.receiptNumber.value ?? '')
      .replace(/\D+/g, '')
      .trim();
  }

  private normalizeBooleanSetting(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (!normalized) return fallback;
      if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
    }
    return fallback;
  }

  paymentSubmitLabel(): string {
    if (this.isSquarePaymentMethodSelected()) {
      return this.paymentLinkLoadingId === this.paymentItem?.reservationId
        ? 'Generating…'
        : 'Generate Link';
    }
    if (this.isCashAppPaymentMethodSelected()) {
      if (this.cashAppPayPreparing) return 'Preparing…';
      if (this.loading) return 'Processing…';
      return this.cashAppPayReady ? 'Refresh Cash App QR' : 'Show Cash App QR';
    }
    if (this.loading) return 'Saving…';
    if (!this.isCreditPaymentMethodSelected()) return 'Submit Payment';
    if (this.creditRemainingAmount() <= 0) return 'Apply Credit';
    return this.paymentForm.controls.remainingMethod.value === 'square'
      ? 'Apply Credit + Generate Link'
      : 'Apply Credit + Submit Payment';
  }

  creditOptionLabel(credit: RescheduleCredit): string {
    const remaining = Number(credit.amountRemaining ?? 0).toFixed(2);
    const expires = String(credit.expiresAt ?? '').trim();
    return expires
      ? `$${remaining} remaining · Expires ${expires}`
      : `$${remaining} remaining`;
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

  private selectedPaymentCredit(): RescheduleCredit | null {
    const selectedId = String(this.paymentForm.controls.creditId.value ?? '').trim();
    if (!selectedId) return null;
    return this.paymentCredits.find((credit) => credit.creditId === selectedId) ?? null;
  }

  private resolvePhoneCountry(item: ReservationItem): 'US' | 'MX' {
    const explicit = String((item as { phoneCountry?: unknown })?.phoneCountry ?? '')
      .trim()
      .toUpperCase();
    if (explicit === 'MX') return 'MX';
    if (explicit === 'US') return 'US';
    const phone = String(item.phone ?? '').trim();
    if (phone.startsWith('+52')) return 'MX';
    return 'US';
  }

  private loadRescheduleCreditsForPayment(item: ReservationItem): void {
    const phone = String(item.phone ?? '').trim();
    if (!phone) {
      this.paymentCredits = [];
      this.paymentCreditsError = 'Reservation has no phone number to find credits.';
      return;
    }
    this.paymentCreditsLoading = true;
    this.paymentCreditsError = null;
    this.paymentCredits = [];
    this.paymentForm.controls.creditId.setValue('');

    this.clientsApi.listRescheduleCredits(phone, this.resolvePhoneCountry(item)).subscribe({
      next: (items) => {
        this.paymentCredits = (items ?? []).filter((credit) => {
          const status = String(credit.status ?? '').trim().toUpperCase();
          return status === 'ACTIVE' && Number(credit.amountRemaining ?? 0) > 0;
        });
        if (!this.paymentCredits.length) {
          this.paymentCreditsError = 'No active reservation credits available for this client.';
        } else if (this.paymentCredits.length === 1) {
          this.paymentForm.controls.creditId.setValue(this.paymentCredits[0].creditId);
        }
        this.paymentCreditsLoading = false;
        if (this.isCreditPaymentMethodSelected()) {
          this.onPaymentCreditChanged();
        }
      },
      error: (err) => {
        this.paymentCreditsLoading = false;
        this.paymentCreditsError =
          err?.error?.message || err?.message || 'Failed to load reservation credits';
      },
    });
  }
}
