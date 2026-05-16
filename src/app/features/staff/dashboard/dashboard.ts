import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowRight, lucideChevronDown } from '@ng-icons/lucide';
import { catchError, forkJoin, of, Subscription } from 'rxjs';
import { EventsService } from '../../../core/http/events.service';
import { CheckInPass, CheckInService } from '../../../core/http/check-in.service';
import {
  ReservationHistoryItem,
  ReservationsService,
} from '../../../core/http/reservations.service';
import { TablesService } from '../../../core/http/tables.service';
import { EventItem } from '../../../shared/models/event.model';
import { ReservationItem } from '../../../shared/models/reservation.model';
import {
  CheckInPassState,
  GeneratedCheckInPass,
  GeneratedPaymentLink,
  PaymentLinkSmsState,
  ReservationHistoryViewItem,
} from '../../../shared/models/reservation-detail.model';
import { TableForEvent } from '../../../shared/models/table.model';
import {
  formatTableLabelLower,
  TableLabelPipe,
} from '../../../shared/table-label.pipe';
import { ClientsService, RescheduleCredit } from '../../../core/http/clients.service';
import { AdminService } from '../../../core/http/admin.service';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';
import { HlmBadge, type BadgeVariants } from '../../../shared/ui/badge';
import { HlmInput } from '../../../shared/ui/input';
import {
  HlmPopover,
  HlmPopoverContent,
  HlmPopoverContentHost,
  HlmPopoverTrigger,
} from '../../../shared/ui/popover';
import { ReservationDetailModal } from '../../../shared/components/reservation-detail-modal/reservation-detail-modal';
import {
  CashAppTokenizedPayload,
  RecordPaymentPayload,
  SquareLinkRequestPayload,
  TakePaymentModal,
} from '../../../shared/components/take-payment-modal/take-payment-modal';

interface TableKpis {
  total: number;
  available: number;
  hold: number;
  reserved: number;
  disabled: number;
}

interface UrgentPaymentItem {
  reservation: ReservationItem;
  deadlineMs: number;
  urgency: 'OVERDUE' | 'DUE_SOON';
}

interface ActivityItem {
  type: 'RESERVED' | 'PAID' | 'PARTIAL' | 'CHECKED_IN' | 'CANCELLED';
  label: string;
  atEpoch: number;
  reservationId: string;
  // Primary (first) table for back-compat with scalar readers.
  tableId: string;
  // Full list when the reservation covers multiple tables; otherwise
  // [tableId]. Render sites use the tableLabel pipe to format.
  tableIds: string[];
  customerName: string;
}

@Component({
  selector: 'app-dashboard',
  imports: [
    CommonModule,
    RouterLink,
    NgIcon,
    TableLabelPipe,
    HlmAlert,
    HlmButton,
    HlmBadge,
    HlmInput,
    HlmPopover,
    HlmPopoverContent,
    HlmPopoverContentHost,
    HlmPopoverTrigger,
    ReservationDetailModal,
    TakePaymentModal,
  ],
  providers: [provideIcons({ lucideArrowRight, lucideChevronDown })],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard implements OnInit, OnDestroy {
  private eventsApi = inject(EventsService);
  private tablesApi = inject(TablesService);
  private reservationsApi = inject(ReservationsService);
  private checkInApi = inject(CheckInService);
  private clientsApi = inject(ClientsService);
  private adminApi = inject(AdminService);

  readonly contextLabel = signal<'TODAY EVENT' | 'NEXT EVENT'>('TODAY EVENT');
  readonly contextEvent = signal<EventItem | null>(null);
  readonly nextUpcomingEvent = signal<EventItem | null>(null);
  readonly businessDate = signal('');
  readonly dashboardPollingSeconds = signal(15);
  readonly urgentPaymentWindowMinutes = signal(360);
  readonly cashReceiptNumberRequired = signal(true);
  readonly squareEnvMode = signal<'sandbox' | 'production'>('sandbox');
  readonly squareApplicationId = signal('');
  readonly squareLocationId = signal('');

  readonly tables = signal<TableForEvent[]>([]);
  readonly reservations = signal<ReservationItem[]>([]);
  // Reservations from upcoming events behind Recent Activity. Distinct
  // from `reservations` (single-event) so KPIs + Urgent Payments stay
  // scoped to the active event while activity card clicks can still
  // resolve a "next Saturday" reservation.
  readonly recentReservationsById = signal<Record<string, ReservationItem>>({});
  readonly urgentPayments = signal<UrgentPaymentItem[]>([]);
  readonly recentActivity = signal<ActivityItem[]>([]);

  // Live visitors on /reserva. Polls GET /admin/live-visitors every 5s
  // (presence rows have a 90s TTL on the BE so this cadence is plenty).
  // Tile auto-hides when count === 0 — no value in showing "0 people"
  // during dead hours, just adds dashboard noise.
  readonly liveVisitorsCount = signal(0);
  readonly liveVisitorsByStage = signal<{
    map: number;
    modal: number;
    checkout: number;
    paid_landing: number;
  }>({ map: 0, modal: 0, checkout: 0, paid_landing: 0 });
  private livePollTimer: ReturnType<typeof setInterval> | null = null;
  private liveVisitorsSub: Subscription | null = null;

  readonly kpis = signal<TableKpis>({
    total: 0,
    available: 0,
    hold: 0,
    reserved: 0,
    disabled: 0,
  });

  readonly loadingContext = signal(false);
  readonly loadingSnapshot = signal(false);
  readonly paymentLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly paymentError = signal<string | null>(null);
  readonly paymentLinkError = signal<string | null>(null);
  readonly paymentLinkNotice = signal<string | null>(null);
  readonly paymentLinkLoadingId = signal<string | null>(null);
  readonly paymentLinksByReservationId = signal<Record<string, GeneratedPaymentLink>>({});
  readonly checkInPassError = signal<string | null>(null);
  readonly checkInPassNotice = signal<string | null>(null);
  readonly checkInPassLoadingId = signal<string | null>(null);
  readonly checkInPassByReservationId = signal<Record<string, GeneratedCheckInPass>>({});
  readonly checkInPassStateByReservationId = signal<Record<string, CheckInPassState>>({});
  readonly historyLoadingId = signal<string | null>(null);
  readonly historyError = signal<string | null>(null);
  readonly historyByReservationId = signal<Record<string, ReservationHistoryViewItem[]>>({});
  readonly detailItem = signal<ReservationItem | null>(null);
  readonly showDetailsModal = signal(false);
  readonly paymentItem = signal<ReservationItem | null>(null);
  readonly showPaymentModal = signal(false);
  readonly paymentCredits = signal<RescheduleCredit[]>([]);
  readonly paymentCreditsLoading = signal(false);
  readonly paymentCreditsError = signal<string | null>(null);
  readonly cashAppPaymentSuccess = signal(false);

  private snapshotSub: Subscription | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.refreshDashboard();
    this.startLiveVisitorsPoll();
  }

  ngOnDestroy(): void {
    this.snapshotSub?.unsubscribe();
    this.snapshotSub = null;
    this.stopPolling();
    this.stopLiveVisitorsPoll();
  }

  private startLiveVisitorsPoll(): void {
    const fetchOnce = () => {
      this.liveVisitorsSub?.unsubscribe();
      this.liveVisitorsSub = this.adminApi.liveVisitors().subscribe({
        next: (snap) => {
          this.liveVisitorsCount.set(Number(snap?.count ?? 0));
          const stages = snap?.byStage ?? {};
          this.liveVisitorsByStage.set({
            map: Number(stages.map ?? 0),
            modal: Number(stages.modal ?? 0),
            checkout: Number(stages.checkout ?? 0),
            paid_landing: Number(stages.paid_landing ?? 0),
          });
        },
        // Silent on error — this is a glance-able tile, not a critical
        // path. A broken poll just leaves the tile hidden until the next
        // tick recovers.
        error: () => {},
      });
    };
    fetchOnce();
    this.livePollTimer = setInterval(fetchOnce, 5_000);
  }

  private stopLiveVisitorsPoll(): void {
    if (this.livePollTimer) {
      clearInterval(this.livePollTimer);
      this.livePollTimer = null;
    }
    this.liveVisitorsSub?.unsubscribe();
    this.liveVisitorsSub = null;
  }

  refreshDashboard(): void {
    this.loadingContext.set(true);
    this.error.set(null);
    this.eventsApi.getCurrentContext().subscribe({
      next: (ctx) => {
        this.businessDate.set(String(ctx?.businessDate ?? '').trim() || this.todayString());
        this.dashboardPollingSeconds.set(
          this.normalizePollingSeconds(ctx?.settings?.dashboardPollingSeconds, 15),
        );
        this.urgentPaymentWindowMinutes.set(
          this.normalizeUrgentWindowMinutes(ctx?.settings?.urgentPaymentWindowMinutes, 360),
        );
        this.cashReceiptNumberRequired.set(
          this.normalizeBooleanSetting(
            ctx?.settings?.cashReceiptNumberRequired,
            true,
          ),
        );
        this.squareEnvMode.set(ctx?.settings?.squareEnvMode === 'production' ? 'production' : 'sandbox');
        this.squareApplicationId.set(String(ctx?.settings?.squareApplicationId ?? '').trim());
        this.squareLocationId.set(String(ctx?.settings?.squareLocationId ?? '').trim());
        const currentEvent = ctx?.event ?? null;
        const nextEvent = ctx?.nextEvent ?? null;
        const targetEvent = currentEvent ?? nextEvent ?? null;
        this.contextLabel.set(currentEvent ? 'TODAY EVENT' : 'NEXT EVENT');
        this.contextEvent.set(targetEvent);
        this.nextUpcomingEvent.set(nextEvent);
        this.loadingContext.set(false);

        if (targetEvent?.eventDate) {
          this.loadSnapshotFor(targetEvent.eventDate, false);
          this.startPolling(targetEvent.eventDate);
        } else {
          this.clearSnapshot();
          this.stopPolling();
        }
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to load dashboard');
        this.cashReceiptNumberRequired.set(true);
        this.loadingContext.set(false);
        this.contextEvent.set(null);
        this.nextUpcomingEvent.set(null);
        this.clearSnapshot();
        this.stopPolling();
      },
    });
  }

  private loadSnapshotFor(eventDate: string, silent: boolean): void {
    if (!silent) {
      this.loadingSnapshot.set(true);
      this.error.set(null);
    }

    this.snapshotSub?.unsubscribe();
    this.snapshotSub = forkJoin({
      tableData: this.tablesApi.getForEvent(eventDate),
      reservations: this.reservationsApi.list(eventDate),
      // Recent Activity spans the next 3 upcoming events so that a booking
      // for next Saturday surfaces even when today has an active event.
      // KPIs + Urgent Payments stay scoped to the active event below.
      // catchError → [] so a 404/5xx on /reservations/recent leaves the
      // single-event snapshot intact instead of failing the whole page.
      recentAcross: this.reservationsApi
        .listRecentAcrossEvents({ maxEvents: 3, limit: 150 })
        .pipe(catchError(() => of([] as ReservationItem[]))),
    }).subscribe({
      next: ({ tableData, reservations, recentAcross }) => {
        this.contextEvent.set(tableData.event ?? this.contextEvent());
        this.tables.set(tableData.tables ?? []);
        this.reservations.set(reservations ?? []);
        this.hydrateStoredPaymentLinks(this.reservations());
        this.kpis.set(this.computeKpis(this.tables()));
        this.urgentPayments.set(this.computeUrgentPayments(this.reservations()));
        // Prefer the multi-event roll-up. Fall back to single-event if the
        // endpoint returned nothing (network blip, BE not yet deployed).
        const activitySource = (recentAcross && recentAcross.length > 0)
          ? recentAcross
          : this.reservations();
        const byId: Record<string, ReservationItem> = {};
        for (const r of activitySource) {
          if (r?.reservationId) byId[r.reservationId] = r;
        }
        this.recentReservationsById.set(byId);
        this.recentActivity.set(this.computeRecentActivity(activitySource));
        this.loadingSnapshot.set(false);
      },
      error: (err) => {
        if (!silent) {
          this.error.set(err?.error?.message || err?.message || 'Failed to load live dashboard data');
          this.loadingSnapshot.set(false);
        }
      },
    });
  }

  private startPolling(eventDate: string): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.loadSnapshotFor(eventDate, true);
    }, this.dashboardPollingSeconds() * 1000);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private clearSnapshot(): void {
    this.tables.set([]);
    this.reservations.set([]);
    this.recentReservationsById.set({});
    this.urgentPayments.set([]);
    this.recentActivity.set([]);
    this.kpis.set({
      total: 0,
      available: 0,
      hold: 0,
      reserved: 0,
      disabled: 0,
    });
    this.loadingSnapshot.set(false);
  }

  private computeKpis(tables: TableForEvent[]): TableKpis {
    const kpis: TableKpis = {
      total: tables.length,
      available: 0,
      hold: 0,
      reserved: 0,
      disabled: 0,
    };

    for (const table of tables) {
      if (table.status === 'AVAILABLE') kpis.available += 1;
      if (table.status === 'HOLD') kpis.hold += 1;
      if (table.status === 'RESERVED' || table.status === 'PENDING_PAYMENT') kpis.reserved += 1;
      if (table.status === 'DISABLED') kpis.disabled += 1;
    }

    return kpis;
  }

  private computeUrgentPayments(items: ReservationItem[]): UrgentPaymentItem[] {
    const now = Date.now();
    const dueSoonWindowMs = this.urgentPaymentWindowMinutes() * 60 * 1000;

    return items
      .filter(
        (r) =>
          r.status === 'CONFIRMED' &&
          (r.paymentStatus === 'PENDING' || r.paymentStatus === 'PARTIAL')
      )
      .map((reservation) => {
        const deadlineMs = this.toDeadlineMs(reservation.paymentDeadlineAt);
        if (deadlineMs === null) return null;
        const delta = deadlineMs - now;
        if (delta < 0) {
          return { reservation, deadlineMs, urgency: 'OVERDUE' as const };
        }
        if (delta <= dueSoonWindowMs) {
          return { reservation, deadlineMs, urgency: 'DUE_SOON' as const };
        }
        return null;
      })
      .filter((x): x is UrgentPaymentItem => x !== null)
      .sort((a, b) => a.deadlineMs - b.deadlineMs)
      .slice(0, 8);
  }

  private computeRecentActivity(items: ReservationItem[]): ActivityItem[] {
    return items
      .map((reservation) => {
        const tableIds =
          Array.isArray(reservation.tableIds) && reservation.tableIds.length > 0
            ? reservation.tableIds
            : [reservation.tableId];
        if (reservation.status === 'CANCELLED') {
          return {
            type: 'CANCELLED' as const,
            label: 'Reservation cancelled',
            atEpoch: Number(reservation.cancelledAt ?? reservation.updatedAt ?? reservation.createdAt ?? 0),
            reservationId: reservation.reservationId,
            tableId: reservation.tableId,
            tableIds,
            customerName: reservation.customerName,
          };
        }

        const checkedInEpoch = Number(reservation.checkedInAt ?? 0);
        if (checkedInEpoch > 0) {
          const paidLabel =
            reservation.paymentStatus === 'PAID' ? 'Paid in full' : 'Payment recorded';
          return {
            type: 'CHECKED_IN' as const,
            label: paidLabel,
            atEpoch: checkedInEpoch,
            reservationId: reservation.reservationId,
            tableId: reservation.tableId,
            tableIds,
            customerName: reservation.customerName,
          };
        }

        const lastPaymentEpoch =
          reservation.payments && reservation.payments.length > 0
            ? Math.max(...reservation.payments.map((p) => Number(p.createdAt ?? 0)))
            : 0;

        if (lastPaymentEpoch > 0) {
          const paymentType = reservation.paymentStatus === 'PAID' ? 'PAID' : 'PARTIAL';
          return {
            type: paymentType as 'PAID' | 'PARTIAL',
            label: reservation.paymentStatus === 'PAID' ? 'Paid in full' : 'Payment recorded',
            atEpoch: lastPaymentEpoch,
            reservationId: reservation.reservationId,
            tableId: reservation.tableId,
            tableIds,
            customerName: reservation.customerName,
          };
        }

        return {
          type: 'RESERVED' as const,
          label: 'Reservation created',
          atEpoch: Number(reservation.createdAt ?? 0),
          reservationId: reservation.reservationId,
          tableId: reservation.tableId,
          tableIds,
          customerName: reservation.customerName,
        };
      })
      .filter((x) => x.atEpoch > 0)
      .sort((a, b) => b.atEpoch - a.atEpoch)
      .slice(0, 15);
  }

  private toDeadlineMs(deadlineAt?: string | null): number | null {
    if (!deadlineAt) return null;
    const ms = Date.parse(String(deadlineAt));
    if (Number.isNaN(ms)) return null;
    return ms;
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

  formatEpoch(epoch: number): string {
    if (!epoch) return '—';
    return new Date(epoch * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  urgencyClass(item: UrgentPaymentItem): string {
    return item.urgency === 'OVERDUE'
      ? 'bg-danger-50 text-danger-700 border-danger-100'
      : 'bg-warm-50 text-warm-700 border-warm-200';
  }

  canTakePayment(item: ReservationItem): boolean {
    return (
      item.status === 'CONFIRMED' &&
      item.paymentStatus !== 'PAID' &&
      item.paymentStatus !== 'COURTESY'
    );
  }

  openActivityDetails(activity: ActivityItem): void {
    // Prefer the cross-event cache so a click on a "next Saturday"
    // activity still opens the detail modal. Fall back to the single-event
    // list for safety.
    const item =
      this.recentReservationsById()[activity.reservationId] ??
      this.reservations().find((r) => r.reservationId === activity.reservationId);
    if (!item) return;
    this.openReservationDetails(item);
  }

  private openReservationDetails(item: ReservationItem): void {
    this.detailItem.set(item);
    this.showDetailsModal.set(true);
    this.checkInPassError.set(null);
    this.checkInPassNotice.set(null);
    this.loadCheckInPass(item);
    this.loadHistory(item);
  }

  closeDetails(): void {
    this.showDetailsModal.set(false);
    this.detailItem.set(null);
    this.paymentLinkError.set(null);
    this.paymentLinkNotice.set(null);
    this.checkInPassError.set(null);
    this.checkInPassNotice.set(null);
    this.historyError.set(null);
  }

  takePaymentFromDetail(item: ReservationItem): void {
    if (!this.canTakePayment(item)) return;
    this.closeDetails();
    this.openUrgentPayment({
      reservation: item,
      deadlineMs: this.toDeadlineMs(item.paymentDeadlineAt) ?? 0,
      urgency: 'DUE_SOON',
    });
  }

  openUrgentPayment(item: UrgentPaymentItem): void {
    if (!this.canTakePayment(item.reservation)) return;
    this.paymentError.set(null);
    this.paymentLinkError.set(null);
    this.paymentLinkNotice.set(null);
    this.cashAppPaymentSuccess.set(false);
    this.paymentItem.set(item.reservation);
    this.showPaymentModal.set(true);
    this.loadRescheduleCreditsForPayment(item.reservation);
  }

  closeUrgentPayment(): void {
    this.showPaymentModal.set(false);
    this.paymentItem.set(null);
    this.paymentError.set(null);
    this.paymentCredits.set([]);
    this.paymentCreditsLoading.set(false);
    this.paymentCreditsError.set(null);
    this.paymentLinkError.set(null);
    this.cashAppPaymentSuccess.set(false);
  }

  canGeneratePaymentLink(item: ReservationItem): boolean {
    return this.canTakePayment(item);
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
    return this.checkInPassByReservationId()[item.reservationId] ?? null;
  }

  getCheckInPassState(item: ReservationItem | null | undefined): CheckInPassState | null {
    if (!item?.reservationId) return null;
    return this.checkInPassStateByReservationId()[item.reservationId] ?? null;
  }

  getHistory(item: ReservationItem | null | undefined): ReservationHistoryViewItem[] {
    if (!item?.reservationId) return [];
    return this.historyByReservationId()[item.reservationId] ?? [];
  }

  loadHistory(item: ReservationItem): void {
    if (this.historyLoadingId() === item.reservationId) return;
    this.historyLoadingId.set(item.reservationId);
    this.historyError.set(null);
    this.reservationsApi.listHistory(item.reservationId, item.eventDate).subscribe({
      next: (items) => {
        this.historyByReservationId.update((current) => ({
          ...current,
          [item.reservationId]: (items ?? [])
            .map((entry) => this.mapHistoryItem(entry))
            .filter((entry): entry is ReservationHistoryViewItem => entry !== null),
        }));
        this.historyLoadingId.set(null);
      },
      error: (err) => {
        this.historyError.set(err?.error?.message || err?.message || 'Failed to load history');
        this.historyLoadingId.set(null);
      },
    });
  }

  loadCheckInPass(item: ReservationItem): void {
    if (!this.canManageCheckInPass(item)) return;
    if (this.checkInPassLoadingId()) return;
    this.checkInPassLoadingId.set(item.reservationId);
    this.checkInPassError.set(null);
    this.checkInPassNotice.set(null);
    this.checkInApi.getReservationPass(item.reservationId, item.eventDate).subscribe({
      next: (res) => {
        this.checkInPassLoadingId.set(null);
        const latestState = this.mapCheckInPassState(res?.latestPass ?? res?.pass);
        if (latestState) {
          this.checkInPassStateByReservationId()[item.reservationId] = latestState;
        }
        const pass = this.mapCheckInPass(res?.pass);
        if (!pass) {
          const latestStatus = String(latestState?.status ?? '').toUpperCase();
          if (latestStatus === 'USED') {
            this.checkInPassNotice.set('Client is already checked in.');
          } else if (latestStatus === 'REVOKED') {
            this.checkInPassNotice.set('Latest pass was revoked. Reissue to send a new pass.');
          } else if (latestStatus === 'EXPIRED') {
            this.checkInPassNotice.set('Latest pass expired. Reissue to send a new pass.');
          } else {
            this.checkInPassNotice.set('No active pass found. Use reissue to create a new one.');
          }
          return;
        }
        this.checkInPassByReservationId.update((current) => ({
          ...current,
          [item.reservationId]: pass,
        }));
      },
      error: (err) => {
        this.checkInPassError.set(
          err?.error?.message || err?.message || 'Failed to load check-in pass',
        );
        this.checkInPassLoadingId.set(null);
      },
    });
  }

  reissueCheckInPass(item: ReservationItem): void {
    if (!this.canReissueCheckInPass(item)) return;
    if (this.checkInPassLoadingId()) return;
    this.checkInPassLoadingId.set(item.reservationId);
    this.checkInPassError.set(null);
    this.checkInPassNotice.set(null);
    this.checkInApi.issueReservationPass(item.reservationId, item.eventDate, true).subscribe({
      next: (res) => {
        this.checkInPassLoadingId.set(null);
        const latestState = this.mapCheckInPassState(res?.latestPass ?? res?.pass);
        if (latestState) {
          this.checkInPassStateByReservationId.update((current) => ({
            ...current,
            [item.reservationId]: latestState,
          }));
        }
        const pass = this.mapCheckInPass(res?.pass);
        if (!pass) {
          this.checkInPassError.set('Pass reissued but no link was returned.');
          return;
        }
        this.checkInPassByReservationId.update((current) => ({
          ...current,
          [item.reservationId]: pass,
        }));
        this.checkInPassNotice.set('Check-in pass reissued.');
      },
      error: (err) => {
        this.checkInPassError.set(
          err?.error?.message || err?.message || 'Failed to reissue check-in pass',
        );
        this.checkInPassLoadingId.set(null);
      },
    });
  }

  copyCheckInPassLink(item: ReservationItem): void {
    const pass = this.getCheckInPass(item);
    if (!pass) return;
    this.checkInPassError.set(null);
    this.writeClipboard(pass.url).then((ok) => {
      this.checkInPassNotice.set(
        ok ? 'Check-in pass link copied.' : 'Copy failed. Please copy manually.',
      );
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

  getPaymentLink(item: ReservationItem | null | undefined): GeneratedPaymentLink | null {
    if (!item?.reservationId) return null;
    return this.paymentLinksByReservationId()[item.reservationId] ?? null;
  }

  generatePaymentLink(item: ReservationItem): void {
    if (!this.canGeneratePaymentLink(item)) return;
    if (this.paymentLinkLoadingId()) return;

    const remaining = this.remainingAmount(item);
    if (remaining <= 0) return;

    this.paymentLinkLoadingId.set(item.reservationId);
    this.paymentLinkError.set(null);
    this.paymentLinkNotice.set(null);

    this.reservationsApi
      .createSquarePaymentLink({
        reservationId: item.reservationId,
        eventDate: item.eventDate,
        amount: remaining,
        note: `Square link for ${formatTableLabelLower(item)}`,
      })
      .subscribe({
        next: (res) => {
          const url = String(res?.square?.url ?? '').trim();
          if (!url) {
            this.paymentLinkError.set('Square link generation succeeded but no URL was returned.');
            this.paymentLinkLoadingId.set(null);
            return;
          }
          this.paymentLinksByReservationId.update((current) => ({
            ...current,
            [item.reservationId]: {
              method: 'square',
              url,
              amount: Number(res?.reservation?.linkAmount ?? remaining),
              createdAtMs: Date.now(),
              audit: res?.square?.audit,
            },
          }));
          this.paymentLinkNotice.set('Square link ready to share.');
          this.paymentLinkLoadingId.set(null);
        },
        error: (err) => {
          this.paymentLinkError.set(
            err?.error?.message || err?.message || 'Failed to generate Square link',
          );
          this.paymentLinkLoadingId.set(null);
        },
      });
  }

  sendPaymentLinkSms(item: ReservationItem): void {
    if (!this.canGeneratePaymentLink(item)) return;
    if (this.paymentLinkLoadingId()) return;

    const remaining = this.remainingAmount(item);
    if (remaining <= 0) return;

    this.paymentLinkLoadingId.set(item.reservationId);
    this.paymentLinkError.set(null);
    this.paymentLinkNotice.set(null);

    this.reservationsApi
      .createSquarePaymentLinkSms({
        reservationId: item.reservationId,
        eventDate: item.eventDate,
        amount: remaining,
        note: `Square link for ${formatTableLabelLower(item)} via SMS`,
      })
      .subscribe({
        next: (res) => {
          const url = String(res?.square?.url ?? '').trim();
          if (!url) {
            this.paymentLinkError.set('SMS sent flow succeeded but no Square URL was returned.');
            this.paymentLinkLoadingId.set(null);
            return;
          }
          this.paymentLinksByReservationId.update((current) => ({
            ...current,
            [item.reservationId]: {
              method: 'square',
              url,
              amount: Number(res?.reservation?.linkAmount ?? remaining),
              createdAtMs: Date.now(),
              audit: res?.square?.audit,
            },
          }));
          const to = String(res?.sms?.to ?? '').trim();
          const messageId = String(res?.sms?.messageId ?? '').trim();
          this.paymentLinkNotice.set(
            to
              ? `Square link sent by FF SMS to ${to}${messageId ? ` (${messageId})` : ''}.`
              : 'SMS sent successfully.',
          );
          this.paymentLinkLoadingId.set(null);
        },
        error: (err) => {
          this.paymentLinkError.set(
            err?.error?.message || err?.message || 'Failed to send Square link SMS',
          );
          this.paymentLinkLoadingId.set(null);
        },
      });
  }

  sendGeneratedLinkSms(item: ReservationItem): void {
    this.sendPaymentLinkSms(item);
  }

  copyPaymentLink(item: ReservationItem): void {
    const link = this.getPaymentLink(item);
    if (!link) return;
    this.paymentLinkError.set(null);
    this.writeClipboard(link.url).then((ok) => {
      this.paymentLinkNotice.set(
        ok ? 'Link copied.' : 'Copy failed. Please copy manually from the link box.',
      );
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

  // ---------------------------------------------------------------------------
  // <take-payment-modal> output handlers
  // ---------------------------------------------------------------------------
  // The modal owns all form state + Cash App QR pad lifecycle. Parent just
  // dispatches its existing service calls based on the modal's outputs.

  onModalRecordPayment(item: ReservationItem, payload: RecordPaymentPayload): void {
    this.paymentLoading.set(true);
    this.paymentError.set(null);
    this.paymentLinkError.set(null);
    this.paymentCreditsError.set(null);

    if (payload.method === 'credit') {
      const creditAmount = payload.amount; // modal pre-clamps to min(remaining, creditRemaining)
      this.reservationsApi
        .addPayment({
          reservationId: item.reservationId,
          eventDate: item.eventDate,
          amount: creditAmount,
          method: 'credit',
          creditId: payload.creditId,
          note: payload.note,
        })
        .subscribe({
          next: (creditRes) => {
            const afterCredit = creditRes.item;
            this.applyReservationUpdate(afterCredit);
            const remaining = this.remainingAmount(afterCredit);
            if (remaining <= 0) {
              this.paymentLoading.set(false);
              this.closeUrgentPayment();
              return;
            }
            if (payload.remainingMethod === 'square') {
              this.recordSquareRemainder(afterCredit, remaining, payload.note);
              return;
            }
            this.recordCashRemainder(afterCredit, remaining, payload.receiptNumber, payload.note);
          },
          error: (err) => {
            this.paymentError.set(err?.error?.message || err?.message || 'Failed to apply credit');
            this.paymentLoading.set(false);
          },
        });
      return;
    }

    this.reservationsApi
      .addPayment({
        reservationId: item.reservationId,
        eventDate: item.eventDate,
        amount: payload.amount,
        method: payload.method,
        receiptNumber: payload.method === 'cash' ? payload.receiptNumber : '',
        note: payload.note,
      })
      .subscribe({
        next: (res) => {
          this.applyReservationUpdate(res.item);
          this.paymentLoading.set(false);
          this.closeUrgentPayment();
        },
        error: (err) => {
          this.paymentError.set(err?.error?.message || err?.message || 'Failed to record payment');
          this.paymentLoading.set(false);
        },
      });
  }

  onModalRequestSquareLink(item: ReservationItem, _payload: SquareLinkRequestPayload): void {
    if (!this.canGeneratePaymentLink(item)) return;
    if (this.paymentLinkLoadingId()) return;
    this.generatePaymentLink(item);
    this.closeUrgentPayment();
    this.openReservationDetails(item);
  }

  onModalCashAppTokenized(item: ReservationItem, payload: CashAppTokenizedPayload): void {
    if (this.paymentLoading()) return;
    this.paymentLoading.set(true);
    this.paymentError.set(null);
    this.reservationsApi
      .addSquarePayment({
        reservationId: item.reservationId,
        eventDate: item.eventDate,
        amount: payload.amount,
        sourceId: payload.sourceId,
        note: payload.note,
      })
      .subscribe({
        next: (res) => {
          this.applyReservationUpdate(res.item);
          // Brief green "Paid" display before dismissing the modal.
          this.cashAppPaymentSuccess.set(true);
          setTimeout(() => {
            this.paymentLoading.set(false);
            this.closeUrgentPayment();
          }, 1500);
        },
        error: (err) => {
          this.paymentError.set(
            err?.error?.message || err?.message || 'Failed to process Cash App payment',
          );
          this.paymentLoading.set(false);
        },
      });
  }

  private applyReservationUpdate(updated: ReservationItem): void {
    this.reservations.update((list) =>
      list.map((r) => (r.reservationId === updated.reservationId ? updated : r)),
    );
    this.urgentPayments.set(this.computeUrgentPayments(this.reservations()));
    this.recentActivity.set(this.computeRecentActivity(this.reservations()));
  }

  private recordSquareRemainder(
    afterCredit: ReservationItem,
    remaining: number,
    note: string,
  ): void {
    this.paymentLinkLoadingId.set(afterCredit.reservationId);
    this.paymentLinkError.set(null);
    this.paymentLinkNotice.set(null);
    this.reservationsApi
      .createSquarePaymentLink({
        reservationId: afterCredit.reservationId,
        eventDate: afterCredit.eventDate,
        amount: remaining,
        note: note || `Remaining payment for ${formatTableLabelLower(afterCredit)}`,
      })
      .subscribe({
        next: (res) => {
          const url = String(res?.square?.url ?? '').trim();
          if (!url) {
            this.paymentError.set('Credit applied, but Square link URL was not returned.');
            this.paymentLoading.set(false);
            this.paymentLinkLoadingId.set(null);
            return;
          }
          this.paymentLinksByReservationId.update((current) => ({
            ...current,
            [afterCredit.reservationId]: {
              method: 'square',
              url,
              amount: Number(res?.reservation?.linkAmount ?? remaining),
              createdAtMs: Date.now(),
              audit: res?.square?.audit,
            },
          }));
          this.paymentLinkNotice.set('Credit applied. Square link is ready.');
          this.paymentLoading.set(false);
          this.paymentLinkLoadingId.set(null);
          this.closeUrgentPayment();
          this.openReservationDetails(afterCredit);
        },
        error: (err) => {
          this.paymentError.set(
            err?.error?.message ||
              err?.message ||
              'Credit applied, but failed to generate Square link',
          );
          this.paymentLoading.set(false);
          this.paymentLinkLoadingId.set(null);
        },
      });
  }

  private recordCashRemainder(
    afterCredit: ReservationItem,
    remaining: number,
    receiptNumber: string,
    note: string,
  ): void {
    this.reservationsApi
      .addPayment({
        reservationId: afterCredit.reservationId,
        eventDate: afterCredit.eventDate,
        amount: remaining,
        method: 'cash',
        receiptNumber,
        note: note || 'Remaining balance after credit',
      })
      .subscribe({
        next: (finalRes) => {
          this.applyReservationUpdate(finalRes.item);
          this.paymentLoading.set(false);
          this.closeUrgentPayment();
        },
        error: (err) => {
          this.paymentError.set(
            err?.error?.message ||
              err?.message ||
              'Credit was applied, but failed to process remaining payment',
          );
          this.paymentLoading.set(false);
        },
      });
  }

  activityBadgeVariant(activity: ActivityItem): BadgeVariants['variant'] {
    if (activity.type === 'CANCELLED') return 'danger';
    if (activity.type === 'CHECKED_IN') return 'success';
    if (activity.type === 'PAID') return 'success';
    if (activity.type === 'PARTIAL') return 'warning';
    return 'secondary';
  }

  activityCardClass(activity: ActivityItem): string {
    if (activity.type === 'CHECKED_IN') {
      return 'border-success-200 bg-success-50 hover:border-success-300 hover:bg-success-100/60';
    }
    return 'border-brand-100 hover:border-brand-300 hover:bg-brand-50/60';
  }

  activityTypeLabel(activity: ActivityItem): string {
    return String(activity.type ?? '')
      .toUpperCase()
      .replace(/_/g, ' ');
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

  private todayString(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private normalizePollingSeconds(value: number | null | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(120, Math.max(5, Math.round(parsed)));
  }

  private normalizeUrgentWindowMinutes(value: number | null | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(1440, Math.max(5, Math.round(parsed)));
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

  private remainingAmount(item: ReservationItem): number {
    const due = Number(item.amountDue ?? 0);
    const paid = Number(item.depositAmount ?? 0);
    return Math.max(0, Number((due - paid).toFixed(2)));
  }

  private hydrateStoredPaymentLinks(items: ReservationItem[]): void {
    const next: Record<string, GeneratedPaymentLink> = { ...this.paymentLinksByReservationId() };
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
        const provider = String(item?.paymentLinkProvider ?? '').trim().toLowerCase();
        next[reservationId] = {
          method: provider === 'square' ? 'square' : (next[reservationId]?.method ?? 'square'),
          url,
          amount: Number((remaining > 0 ? remaining : fallbackAmount).toFixed(2)),
          createdAtMs: createdAt > 0 ? createdAt * 1000 : Date.now(),
          audit: next[reservationId]?.audit,
        };
      } else if (linkStatus && linkStatus !== 'ACTIVE') {
        delete next[reservationId];
      }
    }
    this.paymentLinksByReservationId.set(next);
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
      this.paymentCredits.set([]);
      this.paymentCreditsError.set('Reservation has no phone number to find credits.');
      return;
    }
    this.paymentCreditsLoading.set(true);
    this.paymentCreditsError.set(null);
    this.paymentCredits.set([]);

    this.clientsApi.listRescheduleCredits(phone, this.resolvePhoneCountry(item)).subscribe({
      next: (items) => {
        const filtered = (items ?? []).filter((credit) => {
          const status = String(credit.status ?? '').trim().toUpperCase();
          return status === 'ACTIVE' && Number(credit.amountRemaining ?? 0) > 0;
        });
        this.paymentCredits.set(filtered);
        if (!filtered.length) {
          this.paymentCreditsError.set('No active reservation credits available for this client.');
        }
        // The modal observes `availableCredits` and auto-selects the only
        // credit + recomputes the applied amount on its own.
        this.paymentCreditsLoading.set(false);
      },
      error: (err) => {
        this.paymentCreditsLoading.set(false);
        this.paymentCreditsError.set(
          err?.error?.message || err?.message || 'Failed to load reservation credits',
        );
      },
    });
  }

  private buildShareMessage(item: ReservationItem, url: string): string {
    const tablesLabel = formatTableLabelLower(item);
    const noun =
      Array.isArray(item.tableIds) && item.tableIds.length > 1
        ? 'tables link'
        : 'table link';
    const suffix = tablesLabel ? ` ${tablesLabel}` : '';
    return `Hi ${item.customerName}, here is your ${noun} for ${item.eventDate}${suffix}: ${url}`;
  }

  private buildCheckInPassShareMessage(item: ReservationItem, url: string): string {
    const tablesLabel = formatTableLabelLower(item);
    const suffix = tablesLabel ? ` ${tablesLabel}` : '';
    return `Hi ${item.customerName}, here is your FF check-in pass for ${item.eventDate}${suffix}: ${url}`;
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
}
