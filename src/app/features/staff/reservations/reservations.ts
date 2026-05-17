import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideEllipsis, lucideRefreshCw, lucideX } from '@ng-icons/lucide';
import {
  type ColumnDef,
  type PaginationState,
  type SortingState,
  type VisibilityState,
  createAngularTable,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
} from '@tanstack/angular-table';
import {
  ReservationHistoryItem,
  ReservationsService,
} from '../../../core/http/reservations.service';
import { CheckInPass, CheckInService } from '../../../core/http/check-in.service';
import { ReservationItem } from '../../../shared/models/reservation.model';
import {
  CheckInPassState,
  GeneratedCheckInPass,
  GeneratedPaymentLink,
  PaymentLinkSmsState,
  ReservationHistoryViewItem,
} from '../../../shared/models/reservation-detail.model';
import { EventsService } from '../../../core/http/events.service';
import { EventItem } from '../../../shared/models/event.model';
import {
  formatTableLabelLower,
  TableLabelPipe,
} from '../../../shared/table-label.pipe';
import { ClientsService, RescheduleCredit } from '../../../core/http/clients.service';
import {
  CashAppTokenizedPayload,
  RecordPaymentPayload,
  SquareLinkRequestPayload,
  TakePaymentModal,
} from '../../../shared/components/take-payment-modal/take-payment-modal';
import {
  consumeJustPaidBeacon,
  subscribeToJustPaid,
} from '../../../shared/components/take-payment-modal/just-paid-beacon';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmDialog } from '../../../shared/ui/dialog';
import { HlmButton } from '../../../shared/ui/button';
import { HlmBadge, type BadgeVariants } from '../../../shared/ui/badge';
import { HlmInput } from '../../../shared/ui/input';
import {
  HlmMenu,
  HlmMenuCheckbox,
  HlmMenuItem,
  HlmMenuSeparator,
  HlmMenuTrigger,
} from '../../../shared/ui/dropdown-menu';
import { HlmNumberedPagination } from '../../../shared/ui/pagination';
import {
  HlmTable,
  HlmTBody,
  HlmTHead,
  HlmTableContainer,
  HlmTableSortHeader,
  HlmTd,
  HlmTh,
  HlmTr,
} from '../../../shared/ui/table';
import { ReservationDetailModal } from '../../../shared/components/reservation-detail-modal/reservation-detail-modal';


const PAGE_SIZE = 25;

@Component({
  selector: 'app-reservations',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    NgIcon,
    TableLabelPipe,
    HlmAlert,
    HlmDialog,
    HlmButton,
    HlmBadge,
    HlmInput,
    HlmMenu,
    HlmMenuCheckbox,
    HlmMenuItem,
    HlmMenuSeparator,
    HlmMenuTrigger,
    HlmNumberedPagination,
    HlmTable,
    HlmTBody,
    HlmTHead,
    HlmTableContainer,
    HlmTableSortHeader,
    HlmTd,
    HlmTh,
    HlmTr,
    ReservationDetailModal,
    TakePaymentModal,
  ],
  providers: [provideIcons({ lucideChevronDown, lucideEllipsis, lucideRefreshCw, lucideX })],
  templateUrl: './reservations.html',
  styleUrl: './reservations.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Reservations implements OnInit, OnDestroy {
  private reservationsApi = inject(ReservationsService);
  private eventsApi = inject(EventsService);
  private checkInApi = inject(CheckInService);
  private clientsApi = inject(ClientsService);

  filterDate = new FormControl('', { nonNullable: true });
  // Staff lookup by 6-char confirmation code (FF-XXXXXX). Drives the
  // "Find by code" mini-form in the page header — useful at the door
  // when a customer arrives without their pass and reads the code off
  // their phone. On success, switches filterDate to the reservation's
  // eventDate and opens the detail modal.
  searchCode = new FormControl('', { nonNullable: true });
  readonly searchCodeLoading = signal(false);
  readonly searchCodeError = signal<string | null>(null);
  filterQuery = new FormControl('', { nonNullable: true });
  readonly items = signal<ReservationItem[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly paymentError = signal<string | null>(null);

  private readonly query = toSignal(this.filterQuery.valueChanges, { initialValue: '' });
  readonly sorting = signal<SortingState>([{ id: 'updated', desc: true }]);
  readonly pagination = signal<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE });
  readonly columnVisibility = signal<VisibilityState>({});

  readonly hidableColumnIds: ReadonlyArray<string> = [
    'tableId',
    'paymentStatus',
    'remaining',
    'deadline',
    'updated',
  ];

  private readonly columnLabels: Record<string, string> = {
    tableId: 'Reservation',
    paymentStatus: 'Payment',
    remaining: 'Remaining',
    deadline: 'Deadline',
    updated: 'Updated',
  };

  private readonly tableColumns: ColumnDef<ReservationItem>[] = [
    {
      id: 'tableId',
      accessorFn: (r) => `${r.tableId || ''} ${r.customerName || ''}`.toLowerCase(),
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'paymentStatus',
      accessorFn: (r) => `${r.status} ${r.paymentStatus ?? ''}`,
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'remaining',
      accessorFn: (r) => {
        if (r.status === 'CANCELLED') return 0;
        const due = Number(r.amountDue ?? 0);
        const paid = Number(r.depositAmount ?? 0);
        return Math.max(0, Number((due - paid).toFixed(2)));
      },
      enableSorting: true,
      sortingFn: 'basic',
    },
    {
      id: 'deadline',
      accessorFn: (r) => r.paymentDeadlineAt ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'updated',
      accessorFn: (r) => Number(r.updatedAt ?? r.createdAt ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    { id: 'actions', enableSorting: false },
  ];

  readonly table = createAngularTable<ReservationItem>(() => ({
    data: this.items(),
    columns: this.tableColumns,
    state: {
      sorting: this.sorting(),
      globalFilter: this.query(),
      pagination: this.pagination(),
      columnVisibility: this.columnVisibility(),
    },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(this.sorting()) : updater;
      this.sorting.set(next);
    },
    onPaginationChange: (updater) => {
      const next = typeof updater === 'function' ? updater(this.pagination()) : updater;
      this.pagination.set(next);
    },
    onColumnVisibilityChange: (updater) => {
      const next =
        typeof updater === 'function' ? updater(this.columnVisibility()) : updater;
      this.columnVisibility.set(next);
    },
    globalFilterFn: (row, _columnId, filterValue: string) => {
      const raw = String(filterValue ?? '').trim().toLowerCase();
      if (!raw) return true;
      // Strip a "ff-" prefix so the existing in-table filter accepts the
      // customer-friendly "FF-K7M3X2" shape too — narrows the loaded
      // event without firing the cross-date search-by-code API.
      const q = raw.startsWith('ff-') ? raw.slice(3) : raw;
      const r = row.original;
      const code = String(r.confirmationCode ?? '').toLowerCase();
      return Boolean(
        (r.tableId || '').toLowerCase().includes(q) ||
          (r.customerName || '').toLowerCase().includes(q) ||
          (r.phone || '').includes(q) ||
          formatTableLabelLower(r).includes(q) ||
          (code && code.includes(q)),
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  }));

  readonly currentRows = computed(() =>
    this.table.getRowModel().rows.map((r) => r.original),
  );
  readonly totalFiltered = computed(() => this.table.getFilteredRowModel().rows.length);
  readonly currentPage = computed(() => this.pagination().pageIndex + 1);
  readonly pageSize = computed(() => this.pagination().pageSize);
  readonly pageStart = computed(() =>
    this.totalFiltered() === 0
      ? 0
      : this.pagination().pageIndex * this.pagination().pageSize + 1,
  );
  readonly pageEnd = computed(() =>
    Math.min(
      (this.pagination().pageIndex + 1) * this.pagination().pageSize,
      this.totalFiltered(),
    ),
  );
  readonly visibleColumnCount = computed(
    () => this.hidableColumnIds.filter((id) => this.isColumnVisible(id)).length + 1,
  );
  readonly events = signal<EventItem[]>([]);
  readonly eventsLoading = signal(false);
  readonly eventsError = signal<string | null>(null);
  readonly businessDate = signal(this.todayString());
  readonly cashReceiptNumberRequired = signal(true);
  readonly squareEnvMode = signal<'sandbox' | 'production'>('sandbox');
  readonly squareApplicationId = signal('');
  readonly squareLocationId = signal('');
  readonly contextPreferredEventDate = signal<string | null>(null);
  readonly detailItem = signal<ReservationItem | null>(null);
  readonly showDetailsModal = signal(false);
  readonly paymentItem = signal<ReservationItem | null>(null);
  readonly showPaymentModal = signal(false);
  readonly paymentCredits = signal<RescheduleCredit[]>([]);
  readonly paymentCreditsLoading = signal(false);
  readonly paymentCreditsError = signal<string | null>(null);
  readonly paymentLinkLoadingId = signal<string | null>(null);
  readonly paymentLinkError = signal<string | null>(null);
  readonly paymentLinkNotice = signal<string | null>(null);
  readonly paymentLinksByReservationId = signal<Record<string, GeneratedPaymentLink>>({});
  readonly checkInPassLoadingId = signal<string | null>(null);
  readonly checkInPassError = signal<string | null>(null);
  readonly checkInPassNotice = signal<string | null>(null);
  readonly checkInPassByReservationId = signal<Record<string, GeneratedCheckInPass>>({});
  readonly checkInPassStateByReservationId = signal<Record<string, CheckInPassState>>({});
  readonly historyLoadingId = signal<string | null>(null);
  readonly historyError = signal<string | null>(null);
  readonly historyByReservationId = signal<Record<string, ReservationHistoryViewItem[]>>({});
  readonly cashAppPaymentSuccess = signal(false);
  // Card on Stand "just paid" toast surfaced when /square-stand-callback
  // hands the user back here with a fresh beacon in localStorage. Auto-
  // dismisses after a short timer so it doesn't linger on the page.
  readonly justPaidStandNotice = signal<{ reservationId: string; amount: number } | null>(
    null,
  );

  constructor() {
    effect(() => {
      this.query();
      this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
    });
  }

  private standJustPaidUnsub: (() => void) | null = null;

  ngOnInit(): void {
    this.loadContextAndEvents();
    this.consumeStandJustPaidBeacon();
    // Cross-tab signal: if the user is sitting on this page and a Stand
    // payment lands in another tab (e.g. host iPad opened Square POS in
    // a new tab and the new tab's callback ran), surface the same toast.
    this.standJustPaidUnsub = subscribeToJustPaid((beacon) => {
      this.showJustPaidNotice(beacon.reservationId, beacon.amount);
    });
  }

  private consumeStandJustPaidBeacon(): void {
    const beacon = consumeJustPaidBeacon();
    if (!beacon) return;
    this.showJustPaidNotice(beacon.reservationId, beacon.amount);
  }

  private showJustPaidNotice(reservationId: string, amount: number): void {
    this.justPaidStandNotice.set({ reservationId, amount });
    // Auto-dismiss after 6s. Long enough to read, short enough to clear
    // before the user starts the next action.
    setTimeout(() => {
      const current = this.justPaidStandNotice();
      if (current && current.reservationId === reservationId) {
        this.justPaidStandNotice.set(null);
      }
    }, 6000);
  }

  dismissStandJustPaidNotice(): void {
    this.justPaidStandNotice.set(null);
  }

  ngOnDestroy(): void {
    this.showDetailsModal.set(false);
    this.showPaymentModal.set(false);
    this.syncSidebarModalLock();
    this.standJustPaidUnsub?.();
    this.standJustPaidUnsub = null;
  }

  private loadContextAndEvents(): void {
    this.eventsApi.getCurrentContext().subscribe({
      next: (ctx) => {
        this.businessDate.set(String(ctx?.businessDate ?? '').trim() || this.todayString());
        this.cashReceiptNumberRequired.set(
          this.normalizeBooleanSetting(ctx?.settings?.cashReceiptNumberRequired, true),
        );
        this.squareEnvMode.set(ctx?.settings?.squareEnvMode === 'production' ? 'production' : 'sandbox');
        this.squareApplicationId.set(String(ctx?.settings?.squareApplicationId ?? '').trim());
        this.squareLocationId.set(String(ctx?.settings?.squareLocationId ?? '').trim());
        this.contextPreferredEventDate.set(
          String(ctx?.event?.eventDate ?? '').trim() ||
            String(ctx?.nextEvent?.eventDate ?? '').trim() ||
            null,
        );
        this.loadEvents();
      },
      error: () => {
        this.businessDate.set(this.todayString());
        this.cashReceiptNumberRequired.set(true);
        this.contextPreferredEventDate.set(null);
        this.loadEvents();
      },
    });
  }

  loadEvents(): void {
    this.eventsLoading.set(true);
    this.eventsError.set(null);
    this.eventsApi.listEvents().subscribe({
      next: (items) => {
        this.events.set(
          (items ?? []).sort((a, b) =>
            (a.eventDate || '').localeCompare(b.eventDate || '')
          ),
        );
        this.eventsLoading.set(false);
        this.autoSelectCurrentWeekEvent();
      },
      error: (err) => {
        this.eventsError.set(err?.error?.message || err?.message || 'Failed to load events');
        this.eventsLoading.set(false);
      },
    });
  }

  upcomingEvents(): EventItem[] {
    return this.events()
      .filter((e) => (e.eventDate || '') >= this.businessDate())
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
    const preferred = this.contextPreferredEventDate();
    if (preferred) {
      const hasPreferred = this.events().some((e) => e.eventDate === preferred);
      if (hasPreferred) {
        this.filterDate.setValue(preferred);
        this.load();
        return;
      }
    }
    const currentWeek = this.events().find((e) => this.isThisWeek(e.eventDate));
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
      this.items.set([]);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.reservationsApi.list(date).subscribe({
      next: (items) => {
        // TanStack applies `sorting` (now defaulting to updated DESC).
        // No need to pre-sort here.
        const next = items ?? [];
        this.items.set(next);
        this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
        this.hydrateStoredPaymentLinks(next);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to load reservations');
        this.loading.set(false);
      },
    });
  }

  readonly cancelTarget = signal<ReservationItem | null>(null);
  cancelForm = new FormGroup({
    reason: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    resolution: new FormControl<'CANCEL_NO_REFUND' | 'RESCHEDULE_CREDIT' | 'REFUND'>(
      'CANCEL_NO_REFUND',
      { nonNullable: true },
    ),
  });
  readonly cancelLoading = signal(false);
  readonly cancelError = signal<string | null>(null);

  cancel(item: ReservationItem): void {
    this.cancelTarget.set(item);
    this.cancelForm.reset({
      reason: '',
      resolution: this.refundableAmount(item) > 0 ? 'REFUND' : 'CANCEL_NO_REFUND',
    });
    this.cancelError.set(null);
  }

  cancelTargetRefundable(): number {
    const target = this.cancelTarget();
    return target ? this.refundableAmount(target) : 0;
  }

  closeCancelDialog(): void {
    if (this.cancelLoading()) return;
    this.cancelTarget.set(null);
    this.cancelError.set(null);
  }

  confirmCancel(): void {
    const item = this.cancelTarget();
    if (!item) return;
    const reason = this.cancelForm.controls.reason.value.trim();
    if (!reason) {
      this.cancelForm.controls.reason.markAsTouched();
      return;
    }
    const resolutionType = this.cancelForm.controls.resolution.value;
    if (resolutionType === 'REFUND' && this.refundableAmount(item) <= 0) {
      this.cancelError.set('No refundable payments on this reservation.');
      return;
    }

    this.cancelLoading.set(true);
    this.cancelError.set(null);
    this.reservationsApi
      .cancel(item.reservationId, item.eventDate, item.tableId, reason, resolutionType)
      .subscribe({
        next: () => {
          this.items.update((list) =>
            list.map((x) =>
              x.reservationId === item.reservationId
                ? {
                    ...x,
                    status: 'CANCELLED',
                    cancelReason: reason,
                    ...(resolutionType === 'REFUND'
                      ? { paymentStatus: 'REFUNDED' as const }
                      : {}),
                  }
                : x,
            ),
          );
          const updated =
            this.items().find((x) => x.reservationId === item.reservationId) ?? null;
          if (updated && this.detailItem()?.reservationId === item.reservationId) {
            this.detailItem.set(updated);
          }
          this.cancelLoading.set(false);
          this.cancelTarget.set(null);
        },
        error: (err) => {
          this.cancelError.set(
            err?.error?.message || err?.message || 'Failed to cancel reservation',
          );
          this.cancelLoading.set(false);
        },
      });
  }

  private refundableAmount(item: ReservationItem): number {
    const paymentStatus = String(item?.paymentStatus ?? '').toUpperCase();
    if (paymentStatus !== 'PAID' && paymentStatus !== 'PARTIAL') return 0;
    const payments = Array.isArray(item?.payments) ? item.payments : [];
    let total = 0;
    for (const p of payments) {
      const method = String(p?.method ?? '').toLowerCase();
      if (method !== 'square' && method !== 'cashapp') continue;
      const providerPaymentId = String(p?.provider?.providerPaymentId ?? '').trim();
      if (!providerPaymentId) continue;
      const amt = Number(p?.amount ?? 0);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      total += amt;
    }
    return Number(total.toFixed(2));
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
    return eventDate < this.businessDate();
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

  paymentStatusBadgeVariant(item: ReservationItem): BadgeVariants['variant'] {
    if (item.status === 'CANCELLED') return 'danger';
    const status = String(item.paymentStatus ?? '').trim().toUpperCase();
    if (status === 'PAID') return 'success';
    if (status === 'PARTIAL') return 'warning';
    if (status === 'PENDING') return 'warning';
    if (status === 'COURTESY') return 'secondary';
    return 'secondary';
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
    this.detailItem.set(item);
    this.showDetailsModal.set(true);
    this.syncSidebarModalLock();
    this.checkInPassError.set(null);
    this.checkInPassNotice.set(null);
    this.loadCheckInPass(item);
    this.loadHistory(item);
  }

  closeDetails(): void {
    this.showDetailsModal.set(false);
    this.detailItem.set(null);
    this.syncSidebarModalLock();
    this.paymentLinkError.set(null);
    this.paymentLinkNotice.set(null);
    this.checkInPassError.set(null);
    this.checkInPassNotice.set(null);
    this.historyError.set(null);
  }

  // Resolve a staff-typed confirmation code to a reservation. Strips
  // a "FF-" prefix and uppercases before sending — backend also handles
  // both shapes but we mirror its parsing client-side for the inline
  // validation message. On 200, switches the page's eventDate filter
  // to the reservation's date so the row appears in the table, then
  // opens the detail modal.
  searchByCode(): void {
    if (this.searchCodeLoading()) return;
    const raw = String(this.searchCode.value ?? '').trim().toUpperCase();
    const stripped = raw.startsWith('FF-') ? raw.slice(3) : raw;
    if (!/^[A-Z0-9]{6}$/.test(stripped)) {
      this.searchCodeError.set(
        'Enter the 6-character code (e.g. FF-K7M3X2 or K7M3X2).',
      );
      return;
    }
    this.searchCodeError.set(null);
    this.searchCodeLoading.set(true);
    this.reservationsApi.findByCode(stripped).subscribe({
      next: (reservation) => {
        this.searchCodeLoading.set(false);
        if (!reservation?.reservationId || !reservation?.eventDate) {
          this.searchCodeError.set(
            `No reservation found for code FF-${stripped}.`,
          );
          return;
        }
        // Switch the page filter so the row shows up in the table once
        // the user closes the modal — they can keep working with that
        // event's reservations.
        if (this.filterDate.value !== reservation.eventDate) {
          this.filterDate.setValue(reservation.eventDate);
        }
        this.searchCode.setValue('');
        this.openDetails(reservation);
      },
      error: (err: unknown) => {
        this.searchCodeLoading.set(false);
        const status = (err as { status?: number })?.status;
        const code = String(
          ((err as { error?: { code?: string } })?.error?.code ?? '').trim(),
        );
        if (status === 404 || code === 'RESERVATION_NOT_FOUND') {
          this.searchCodeError.set(
            `No reservation found for code FF-${stripped}.`,
          );
        } else if (status === 400 || code === 'BAD_CONFIRMATION_CODE') {
          this.searchCodeError.set(
            'Code must be 6 alphanumeric characters.',
          );
        } else {
          this.searchCodeError.set(
            'Could not look up that code. Please try again.',
          );
        }
      },
    });
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

  takePaymentFromDetail(item: ReservationItem): void {
    if (!this.canTakePayment(item)) return;
    this.closeDetails();
    this.openPayment(item);
  }

  openPayment(item: ReservationItem): void {
    this.paymentItem.set(item);
    this.showPaymentModal.set(true);
    this.paymentLinkError.set(null);
    this.paymentLinkNotice.set(null);
    this.cashAppPaymentSuccess.set(false);
    this.syncSidebarModalLock();
    this.loadRescheduleCreditsForPayment(item);
  }

  closePayment(): void {
    this.showPaymentModal.set(false);
    this.paymentItem.set(null);
    this.syncSidebarModalLock();
    this.paymentCredits.set([]);
    this.paymentCreditsLoading.set(false);
    this.paymentCreditsError.set(null);
    this.paymentLinkError.set(null);
    this.paymentError.set(null);
    this.cashAppPaymentSuccess.set(false);
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

  private syncSidebarModalLock(): void {
    if (typeof document === 'undefined') return;
    const isModalOpen = this.showDetailsModal() || this.showPaymentModal();
    document.body.classList.toggle('reservations-modal-open', isModalOpen);
  }

  // ---------------------------------------------------------------------------
  // <take-payment-modal> output handlers
  // ---------------------------------------------------------------------------

  onModalRecordPayment(item: ReservationItem, payload: RecordPaymentPayload): void {
    this.loading.set(true);
    this.error.set(null);
    this.paymentError.set(null);
    this.paymentLinkError.set(null);
    this.paymentCreditsError.set(null);

    if (payload.method === 'credit') {
      const creditAmount = payload.amount;
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
            this.applyItemUpdate(afterCredit);
            const remaining = this.remainingAmount(afterCredit);
            if (remaining <= 0) {
              this.loading.set(false);
              this.closePayment();
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
            this.loading.set(false);
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
          this.applyItemUpdate(res.item);
          this.loading.set(false);
          this.closePayment();
        },
        error: (err) => {
          this.paymentError.set(err?.error?.message || err?.message || 'Failed to record payment');
          this.loading.set(false);
        },
      });
  }

  onModalRequestSquareLink(item: ReservationItem, _payload: SquareLinkRequestPayload): void {
    if (!this.canGeneratePaymentLink(item)) return;
    if (this.paymentLinkLoadingId()) return;
    this.generatePaymentLink(item);
    this.closePayment();
    this.openDetails(item);
  }

  onModalCashAppTokenized(item: ReservationItem, payload: CashAppTokenizedPayload): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.paymentError.set(null);
    this.paymentLinkError.set(null);
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
          this.applyItemUpdate(res.item);
          this.cashAppPaymentSuccess.set(true);
          setTimeout(() => {
            this.loading.set(false);
            this.closePayment();
          }, 1500);
        },
        error: (err) => {
          this.loading.set(false);
          this.paymentError.set(
            err?.error?.message || err?.message || 'Failed to process Cash App payment',
          );
        },
      });
  }

  private applyItemUpdate(updated: ReservationItem): void {
    this.items.update((list) =>
      list.map((x) => (x.reservationId === updated.reservationId ? updated : x)),
    );
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
            this.loading.set(false);
            this.paymentLinkLoadingId.set(null);
            return;
          }
          this.paymentLinksByReservationId()[afterCredit.reservationId] = {
            method: 'square',
            url,
            amount: Number(res?.reservation?.linkAmount ?? remaining),
            createdAtMs: Date.now(),
            audit: res?.square?.audit,
          };
          this.paymentLinkNotice.set('Credit applied. Square link is ready.');
          this.loading.set(false);
          this.paymentLinkLoadingId.set(null);
          this.closePayment();
          this.openDetails(afterCredit);
        },
        error: (err) => {
          this.paymentError.set(
            err?.error?.message ||
              err?.message ||
              'Credit applied, but failed to generate Square link',
          );
          this.loading.set(false);
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
          this.applyItemUpdate(finalRes.item);
          this.loading.set(false);
          this.closePayment();
        },
        error: (err) => {
          this.paymentError.set(
            err?.error?.message ||
              err?.message ||
              'Credit was applied, but failed to process remaining payment',
          );
          this.loading.set(false);
        },
      });
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
        // The modal observes `availableCredits` and auto-selects + recomputes
        // applied amount on its own.
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

  onPageChange(page: number): void {
    this.pagination.update((s) => ({ ...s, pageIndex: Math.max(0, page - 1) }));
  }

  onPageSizeChange(size: number): void {
    this.pagination.update((s) => ({ ...s, pageSize: size, pageIndex: 0 }));
  }

  isColumnVisible(id: string): boolean {
    return this.columnVisibility()[id] !== false;
  }

  toggleColumnVisibility(id: string): void {
    this.columnVisibility.update((s) => ({ ...s, [id]: !this.isColumnVisible(id) }));
  }

  columnLabel(id: string): string {
    return this.columnLabels[id] ?? id;
  }

  column(id: string) {
    return this.table.getColumn(id);
  }

  trackByReservationId(_: number, item: ReservationItem): string {
    return item.reservationId;
  }
}
