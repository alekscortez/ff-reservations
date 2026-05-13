import { CommonModule } from '@angular/common';
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
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, map, of, Subscription } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowRight, lucideChevronDown } from '@ng-icons/lucide';
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
import { EventsService } from '../../../core/http/events.service';
import { ReservationsService } from '../../../core/http/reservations.service';
import { EventItem } from '../../../shared/models/event.model';
import {
  PaymentMethod,
  ReservationItem,
  ReservationPayment,
} from '../../../shared/models/reservation.model';
import { TableLabelPipe } from '../../../shared/table-label.pipe';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';
import { HlmDateRangePicker } from '../../../shared/ui/date-picker';
import { HlmInput } from '../../../shared/ui/input';
import { HlmNativeSelect } from '../../../shared/ui/native-select';
import {
  HlmMenu,
  HlmMenuCheckbox,
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

const PAGE_SIZE = 25;

interface FinancialRow {
  eventId: string;
  eventName: string;
  eventDate: string;
  reservationId: string;
  status: 'CONFIRMED' | 'CANCELLED';
  paymentStatus: 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY' | 'REFUNDED' | null;
  tableId: string;
  tableIds: string[];
  customerName: string;
  phone: string;
  amountDue: number;
  paid: number;
  balance: number;
  tablePrice: number;
  refundedAmount: number;
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
  refunded: number;
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
  refunded: number;
  netCollected: number;
}

interface EventReservationsSnapshot {
  event: EventItem;
  reservations: ReservationItem[];
}

interface MethodTotals {
  cash: number;
  square: number;
  cashapp: number;
  credit: number;
  refunds: number;
}

type LedgerSource =
  | 'manual'
  | 'square-direct'
  | 'square-webhook'
  | 'reschedule-credit'
  | 'square-refund';

interface PaymentLedgerRow {
  paymentId: string;
  eventDate: string;
  eventName: string;
  reservationId: string;
  tableId: string;
  tableIds: string[];
  customerName: string;
  amount: number;
  method: PaymentMethod;
  source: LedgerSource;
  createdAt: number;
  createdBy: string | null;
  providerPaymentId: string | null;
  orderId: string | null;
  providerStatus: string | null;
  receiptUrl: string | null;
  isFallback: boolean;
  isRefund: boolean;
}

@Component({
  selector: 'app-financials',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    NgIcon,
    TableLabelPipe,
    HlmAlert,
    HlmButton,
    HlmDateRangePicker,
    HlmInput,
    HlmNativeSelect,
    HlmMenu,
    HlmMenuCheckbox,
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
  ],
  providers: [provideIcons({ lucideArrowRight, lucideChevronDown })],
  templateUrl: './financials.html',
  styleUrl: './financials.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Financials implements OnInit, OnDestroy {
  private eventsApi = inject(EventsService);
  private reservationsApi = inject(ReservationsService);

  private snapshotSub: Subscription | null = null;

  readonly events = signal<EventItem[]>([]);
  readonly filteredEvents = signal<EventItem[]>([]);
  readonly rows = signal<FinancialRow[]>([]);
  readonly receivables = signal<FinancialRow[]>([]);
  readonly ledgerRows = signal<PaymentLedgerRow[]>([]);
  readonly eventSummaries = signal<EventFinancialSummary[]>([]);
  readonly methodTotals = signal<MethodTotals>({
    cash: 0,
    square: 0,
    cashapp: 0,
    credit: 0,
    refunds: 0,
  });

  rangeStart = signal<Date | undefined>(undefined);
  rangeEnd = signal<Date | undefined>(undefined);
  eventStatus = new FormControl<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL', { nonNullable: true });

  summariesFilter = new FormControl('', { nonNullable: true });
  receivablesFilter = new FormControl('', { nonNullable: true });
  ledgerFilter = new FormControl('', { nonNullable: true });

  private readonly summariesQuery = toSignal(this.summariesFilter.valueChanges, {
    initialValue: '',
  });
  private readonly receivablesQuery = toSignal(this.receivablesFilter.valueChanges, {
    initialValue: '',
  });
  private readonly ledgerQuery = toSignal(this.ledgerFilter.valueChanges, {
    initialValue: '',
  });

  readonly activeTab = signal<'summary' | 'receivables' | 'ledger'>('summary');

  readonly summariesSorting = signal<SortingState>([{ id: 'eventDate', desc: true }]);
  readonly summariesPagination = signal<PaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });
  readonly receivablesSorting = signal<SortingState>([{ id: 'deadline', desc: false }]);
  readonly receivablesPagination = signal<PaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });
  readonly ledgerSorting = signal<SortingState>([{ id: 'createdAt', desc: true }]);
  readonly ledgerPagination = signal<PaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });
  readonly ledgerVisibility = signal<VisibilityState>({});

  readonly ledgerHidableColumnIds: ReadonlyArray<string> = [
    'createdAt',
    'event',
    'customer',
    'amount',
    'method',
    'source',
    'providerPaymentId',
    'orderId',
    'receipt',
    'actor',
  ];

  private readonly ledgerColumnLabels: Record<string, string> = {
    createdAt: 'Paid At',
    event: 'Event',
    customer: 'Customer',
    amount: 'Amount',
    method: 'Method',
    source: 'Source',
    providerPaymentId: 'Square Txn ID',
    orderId: 'Order ID',
    receipt: 'Receipt',
    actor: 'By',
  };

  private readonly summariesColumns: ColumnDef<EventFinancialSummary>[] = [
    {
      id: 'eventDate',
      accessorFn: (r) => r.eventDate,
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    { id: 'status', accessorKey: 'status', enableSorting: true, sortingFn: 'alphanumeric' },
    {
      id: 'collected',
      accessorFn: (r) => Number(r.collected ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    {
      id: 'outstanding',
      accessorFn: (r) => Number(r.outstanding ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    {
      id: 'overdue',
      accessorFn: (r) => Number(r.overdue ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    {
      id: 'refunded',
      accessorFn: (r) => Number(r.refunded ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    {
      id: 'confirmed',
      accessorFn: (r) => Number(r.confirmed ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
  ];

  private readonly receivablesColumns: ColumnDef<FinancialRow>[] = [
    {
      id: 'event',
      accessorFn: (r) => `${r.eventDate} ${r.eventName ?? ''}`,
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'customer',
      accessorFn: (r) => r.customerName ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'tableId',
      accessorFn: (r) => r.tableId ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'status',
      accessorFn: (r) => (r.isOverdue ? 'OVERDUE' : r.isDueSoon ? 'DUE_SOON' : r.paymentStatus ?? ''),
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'balance',
      accessorFn: (r) => Number(r.balance ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    {
      id: 'deadline',
      accessorFn: (r) => r.deadlineMs ?? Number.MAX_SAFE_INTEGER,
      enableSorting: true,
      sortingFn: 'basic',
    },
  ];

  private readonly ledgerColumns: ColumnDef<PaymentLedgerRow>[] = [
    {
      id: 'createdAt',
      accessorFn: (r) => Number(r.createdAt ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    {
      id: 'event',
      accessorFn: (r) => `${r.eventDate} ${r.eventName ?? ''}`,
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'customer',
      accessorFn: (r) => r.customerName ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'amount',
      accessorFn: (r) => Number(r.amount ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    {
      id: 'method',
      accessorFn: (r) => r.method ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'source',
      accessorFn: (r) => r.source ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'providerPaymentId',
      accessorFn: (r) => r.providerPaymentId ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'orderId',
      accessorFn: (r) => r.orderId ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    { id: 'receipt', enableSorting: false },
    {
      id: 'actor',
      accessorFn: (r) => `${r.source ?? ''} ${r.createdBy ?? ''}`,
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
  ];

  readonly summariesTable = createAngularTable<EventFinancialSummary>(() => ({
    data: this.eventSummaries(),
    columns: this.summariesColumns,
    state: {
      sorting: this.summariesSorting(),
      globalFilter: this.summariesQuery(),
      pagination: this.summariesPagination(),
    },
    onSortingChange: (u) => {
      const next = typeof u === 'function' ? u(this.summariesSorting()) : u;
      this.summariesSorting.set(next);
    },
    onPaginationChange: (u) => {
      const next = typeof u === 'function' ? u(this.summariesPagination()) : u;
      this.summariesPagination.set(next);
    },
    globalFilterFn: (row, _id, filterValue: string) => {
      const q = String(filterValue ?? '').trim().toLowerCase();
      if (!q) return true;
      const r = row.original;
      return Boolean(
        (r.eventName || '').toLowerCase().includes(q) ||
          (r.eventDate || '').toLowerCase().includes(q) ||
          (r.status || '').toLowerCase().includes(q),
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  }));

  readonly receivablesTable = createAngularTable<FinancialRow>(() => ({
    data: this.receivables(),
    columns: this.receivablesColumns,
    state: {
      sorting: this.receivablesSorting(),
      globalFilter: this.receivablesQuery(),
      pagination: this.receivablesPagination(),
    },
    onSortingChange: (u) => {
      const next = typeof u === 'function' ? u(this.receivablesSorting()) : u;
      this.receivablesSorting.set(next);
    },
    onPaginationChange: (u) => {
      const next = typeof u === 'function' ? u(this.receivablesPagination()) : u;
      this.receivablesPagination.set(next);
    },
    globalFilterFn: (row, _id, filterValue: string) => {
      const q = String(filterValue ?? '').trim().toLowerCase();
      if (!q) return true;
      const r = row.original;
      return Boolean(
        (r.customerName || '').toLowerCase().includes(q) ||
          (r.phone || '').includes(q) ||
          (r.eventName || '').toLowerCase().includes(q) ||
          (r.eventDate || '').toLowerCase().includes(q) ||
          (r.tableId || '').toLowerCase().includes(q),
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  }));

  readonly ledgerTable = createAngularTable<PaymentLedgerRow>(() => ({
    data: this.ledgerRows(),
    columns: this.ledgerColumns,
    state: {
      sorting: this.ledgerSorting(),
      globalFilter: this.ledgerQuery(),
      pagination: this.ledgerPagination(),
      columnVisibility: this.ledgerVisibility(),
    },
    onSortingChange: (u) => {
      const next = typeof u === 'function' ? u(this.ledgerSorting()) : u;
      this.ledgerSorting.set(next);
    },
    onPaginationChange: (u) => {
      const next = typeof u === 'function' ? u(this.ledgerPagination()) : u;
      this.ledgerPagination.set(next);
    },
    onColumnVisibilityChange: (u) => {
      const next = typeof u === 'function' ? u(this.ledgerVisibility()) : u;
      this.ledgerVisibility.set(next);
    },
    globalFilterFn: (row, _id, filterValue: string) => {
      const q = String(filterValue ?? '').trim().toLowerCase();
      if (!q) return true;
      const r = row.original;
      return Boolean(
        (r.customerName || '').toLowerCase().includes(q) ||
          (r.eventName || '').toLowerCase().includes(q) ||
          (r.eventDate || '').toLowerCase().includes(q) ||
          (r.tableId || '').toLowerCase().includes(q) ||
          (r.providerPaymentId || '').toLowerCase().includes(q) ||
          (r.orderId || '').toLowerCase().includes(q) ||
          this.formatMethodLabel(r.method).toLowerCase().includes(q) ||
          this.formatSourceLabel(r.source).toLowerCase().includes(q),
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  }));

  readonly summariesCurrentRows = computed(() =>
    this.summariesTable.getRowModel().rows.map((r) => r.original),
  );
  readonly summariesTotalFiltered = computed(
    () => this.summariesTable.getFilteredRowModel().rows.length,
  );
  readonly summariesCurrentPage = computed(() => this.summariesPagination().pageIndex + 1);
  readonly summariesPageSize = computed(() => this.summariesPagination().pageSize);

  readonly receivablesCurrentRows = computed(() =>
    this.receivablesTable.getRowModel().rows.map((r) => r.original),
  );
  readonly receivablesTotalFiltered = computed(
    () => this.receivablesTable.getFilteredRowModel().rows.length,
  );
  readonly receivablesCurrentPage = computed(
    () => this.receivablesPagination().pageIndex + 1,
  );
  readonly receivablesPageSize = computed(() => this.receivablesPagination().pageSize);

  readonly ledgerCurrentRows = computed(() =>
    this.ledgerTable.getRowModel().rows.map((r) => r.original),
  );
  readonly ledgerTotalFiltered = computed(
    () => this.ledgerTable.getFilteredRowModel().rows.length,
  );
  readonly ledgerCurrentPage = computed(() => this.ledgerPagination().pageIndex + 1);
  readonly ledgerPageSize = computed(() => this.ledgerPagination().pageSize);

  readonly ledgerVisibleColumnCount = computed(
    () =>
      this.ledgerHidableColumnIds.filter((id) => this.isLedgerColumnVisible(id)).length,
  );

  constructor() {
    effect(() => {
      this.summariesQuery();
      this.summariesPagination.update((s) => ({ ...s, pageIndex: 0 }));
    });
    effect(() => {
      this.receivablesQuery();
      this.receivablesPagination.update((s) => ({ ...s, pageIndex: 0 }));
    });
    effect(() => {
      this.ledgerQuery();
      this.ledgerPagination.update((s) => ({ ...s, pageIndex: 0 }));
    });
  }

  readonly overview = signal<OverviewKpis>({
    eventsInRange: 0,
    reservations: 0,
    confirmed: 0,
    collected: 0,
    expected: 0,
    outstanding: 0,
    overdue: 0,
    dueSoon: 0,
    courtesyValue: 0,
    refunded: 0,
    netCollected: 0,
  });

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly warnings = signal<string[]>([]);

  ngOnInit(): void {
    this.setDefaultRange();
    this.refresh();
  }

  ngOnDestroy(): void {
    this.snapshotSub?.unsubscribe();
    this.snapshotSub = null;
  }

  refresh(): void {
    this.loading.set(true);
    this.error.set(null);
    this.warnings.set([]);

    this.eventsApi.listEvents().subscribe({
      next: (events) => {
        this.events.set(
          [...(events ?? [])].sort((a, b) =>
            (b.eventDate || '').localeCompare(a.eventDate || '')
          ),
        );
        this.loadReportForCurrentFilters();
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to load events');
        this.loading.set(false);
      },
    });
  }

  applyFilters(): void {
    this.loadReportForCurrentFilters();
  }

  exportCsv(): void {
    const rows = this.rows();
    if (rows.length === 0) return;

    const headers = [
      'event_date',
      'event_name',
      'event_status',
      'reservation_id',
      'reservation_status',
      'payment_status',
      'tables',
      'customer_name',
      'phone',
      'amount_due',
      'paid',
      'balance',
      'refunded_amount',
      'table_price',
      'payment_method',
      'payment_deadline',
    ];

    const eventByDate = new Map(this.filteredEvents().map((e) => [e.eventDate, e]));

    const body = rows.map((row) => {
      const event = eventByDate.get(row.eventDate);
      const tableList = row.tableIds.length > 0 ? row.tableIds.join(' | ') : row.tableId;
      return [
        row.eventDate,
        row.eventName,
        event?.status ?? '',
        row.reservationId,
        row.status,
        row.paymentStatus ?? '',
        tableList,
        row.customerName,
        row.phone,
        row.amountDue.toFixed(2),
        row.paid.toFixed(2),
        row.balance.toFixed(2),
        Number(row.refundedAmount || 0).toFixed(2),
        row.tablePrice.toFixed(2),
        row.paymentMethod ?? '',
        row.paymentDeadlineAt ?? '',
      ].map((x) => this.escapeCsv(x));
    });

    this.downloadCsv(headers, body, 'financials');
  }

  exportLedgerCsv(): void {
    const rows = this.ledgerRows();
    if (rows.length === 0) return;

    const headers = [
      'paid_at',
      'event_date',
      'event_name',
      'reservation_id',
      'tables',
      'customer_name',
      'amount',
      'method',
      'source',
      'square_txn_id',
      'order_id',
      'provider_status',
      'receipt_url',
      'actor',
      'is_refund',
    ];

    const body = rows.map((row) => {
      const tableList = row.tableIds.length > 0 ? row.tableIds.join(' | ') : row.tableId;
      const paidAt = row.createdAt > 0 ? new Date(row.createdAt * 1000).toISOString() : '';
      return [
        paidAt,
        row.eventDate,
        row.eventName,
        row.reservationId,
        tableList,
        row.customerName,
        row.amount.toFixed(2),
        this.formatMethodLabel(row.method),
        this.formatSourceLabel(row.source),
        row.providerPaymentId ?? '',
        row.orderId ?? '',
        row.providerStatus ?? '',
        row.receiptUrl ?? '',
        this.formatLedgerActor(row),
        row.isRefund ? 'true' : 'false',
      ].map((x) => this.escapeCsv(x));
    });

    this.downloadCsv(headers, body, 'payment-ledger');
  }

  private downloadCsv(headers: string[], body: string[][], baseName: string): void {
    const csv = [headers.join(','), ...body.map((line) => line.join(','))].join('\n');
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate()
    ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(
      now.getMinutes()
    ).padStart(2, '0')}`;
    const from = this.formatYmd(this.rangeStart()).replace(/-/g, '');
    const to = this.formatYmd(this.rangeEnd()).replace(/-/g, '');
    const rangeStamp = from && to ? `_${from}-${to}` : '';

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}${rangeStamp}-${stamp}.csv`;
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
    if (row.isDueSoon) return 'bg-warm-100 text-warm-700';
    return 'bg-brand-100 text-brand-700';
  }

  sourceBadgeClass(source: string | null | undefined): string {
    const normalized = String(source ?? '').trim().toLowerCase();
    if (normalized === 'square-webhook') return 'bg-success-100 text-success-700';
    if (normalized === 'square-direct') return 'bg-brand-100 text-brand-700';
    if (normalized === 'reschedule-credit') return 'bg-warm-100 text-warm-800';
    if (normalized === 'manual') return 'bg-warm-100 text-warm-800';
    if (normalized === 'square-refund') return 'bg-danger-100 text-danger-700';
    return 'bg-brand-50 text-brand-600';
  }

  formatMethodLabel(method: PaymentMethod | string | null | undefined): string {
    const normalized = String(method ?? '').trim().toLowerCase();
    if (!normalized) return '—';
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

  formatSourceLabel(source: string | null | undefined): string {
    const normalized = String(source ?? '').trim().toLowerCase();
    if (!normalized) return '—';
    if (normalized === 'square-webhook') return 'Square Auto Confirmed';
    if (normalized === 'square-direct') return 'Square Charged by Staff';
    if (normalized === 'reschedule-credit') return 'Applied Reservation Credit';
    if (normalized === 'manual') return 'Recorded Manually';
    if (normalized === 'square-refund') return 'Square Refund';
    return normalized
      .replace(/[_-]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  formatEpochShort(epochSeconds: number): string {
    if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return '—';
    return new Date(epochSeconds * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  formatLedgerActor(row: PaymentLedgerRow): string {
    const source = String(row?.source ?? '').trim().toLowerCase();
    if (source === 'square-webhook') return 'Square System';

    const actor = String(row?.createdBy ?? '').trim();
    const isSystemActor = actor.toLowerCase().startsWith('system:');

    if (
      (source === 'square-direct' || source === 'manual' || source === 'square-refund') &&
      (!actor || isSystemActor)
    ) {
      return 'Staff (Unknown)';
    }

    if (isSystemActor && actor.toLowerCase() === 'system:square-webhook') {
      return 'Square System';
    }

    return actor || '—';
  }

  private setDefaultRange(): void {
    // Venue takes forward bookings — almost every reservation is for a
    // future event date. The old default of From=first-of-month, To=today
    // showed zero events whenever the month had no past events yet, which
    // is the common case at the start of every month. Default now: last
    // 30 days through everything in the future (no upper bound), so the
    // operator sees recent completed events + all upcoming obligations.
    // Operator can narrow for monthly reconciliation as needed.
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
    this.rangeStart.set(thirtyDaysAgo);
    this.rangeEnd.set(undefined);
  }

  private formatYmd(date: Date | undefined): string {
    if (!date) return '';
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private loadReportForCurrentFilters(): void {
    this.error.set(null);
    this.warnings.set([]);
    const filtered = this.filterEvents(this.events());
    this.filteredEvents.set(filtered);

    if (filtered.length === 0) {
      this.clearReport();
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.snapshotSub?.unsubscribe();
    this.snapshotSub = this.loadReservationsForEvents(filtered).subscribe({
      next: (snapshots) => {
        const rows = this.buildRows(snapshots);
        this.rows.set(rows);
        const receivables = this.buildReceivables(rows);
        this.receivables.set(receivables);
        this.ledgerRows.set(this.buildPaymentLedger(snapshots));
        this.eventSummaries.set(this.buildEventSummaries(filtered, rows, receivables));
        this.overview.set(this.buildOverview(filtered, rows, receivables));
        this.methodTotals.set(this.buildMethodTotals(snapshots));
        this.summariesPagination.update((s) => ({ ...s, pageIndex: 0 }));
        this.receivablesPagination.update((s) => ({ ...s, pageIndex: 0 }));
        this.ledgerPagination.update((s) => ({ ...s, pageIndex: 0 }));
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(
          err?.error?.message || err?.message || 'Failed to load financial report',
        );
        this.loading.set(false);
      },
    });
  }

  private filterEvents(events: EventItem[]): EventItem[] {
    const from = this.formatYmd(this.rangeStart());
    const to = this.formatYmd(this.rangeEnd());
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
      this.reservationsApi.list(event.eventDate, { suppressRelease: true }).pipe(
        map((reservations) => ({ event, reservations: reservations ?? [] })),
        catchError((err) => {
          const msg =
            err?.error?.message || err?.message || `Failed to load reservations for ${event.eventDate}`;
          this.warnings.update((current) => [...current, `${event.eventDate}: ${msg}`]);
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

          const tableIds =
            Array.isArray(reservation.tableIds) && reservation.tableIds.length > 0
              ? reservation.tableIds
              : [reservation.tableId];
          const row: FinancialRow = {
            eventId: event.eventId,
            eventName: event.eventName,
            eventDate: event.eventDate,
            reservationId: reservation.reservationId,
            status: reservation.status,
            paymentStatus: reservation.paymentStatus ?? null,
            tableId: reservation.tableId,
            tableIds,
            customerName: reservation.customerName,
            phone: reservation.phone,
            amountDue,
            paid,
            balance,
            tablePrice,
            refundedAmount: Number(reservation.refundedAmount ?? 0),
            paymentMethod: reservation.paymentMethod ?? null,
            paymentDeadlineAt: reservation.paymentDeadlineAt ?? null,
            deadlineMs,
            isOverdue,
            isDueSoon,
            createdAt: Number(reservation.createdAt ?? 0),
          };
          return row;
        })
      )
      .sort((a, b) => {
        const dateCmp = b.eventDate.localeCompare(a.eventDate);
        if (dateCmp !== 0) return dateCmp;
        return a.tableId.localeCompare(b.tableId, undefined, { numeric: true, sensitivity: 'base' });
      });
  }

  private buildReceivables(rows: FinancialRow[]): FinancialRow[] {
    // Includes rows without a paymentDeadlineAt — operator still needs to
    // chase the balance even though the deadline is missing. Null-deadline
    // rows sort to the bottom (treated as +∞) so real overdue stays first.
    return rows
      .filter((row) => row.status === 'CONFIRMED')
      .filter((row) => row.paymentStatus === 'PENDING' || row.paymentStatus === 'PARTIAL')
      .filter((row) => row.balance > 0)
      .sort(
        (a, b) =>
          (a.deadlineMs ?? Number.MAX_SAFE_INTEGER) -
          (b.deadlineMs ?? Number.MAX_SAFE_INTEGER)
      );
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
      const refunded = this.sum(
        eventRows
          .filter((x) => x.paymentStatus === 'REFUNDED')
          .map((x) => Number(x.refundedAmount || 0))
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
        refunded,
      };
    });
  }

  private buildOverview(
    events: EventItem[],
    rows: FinancialRow[],
    receivables: FinancialRow[]
  ): OverviewKpis {
    const confirmed = rows.filter((row) => row.status === 'CONFIRMED');
    const collected = this.sum(confirmed.map((x) => x.paid));
    const refunded = this.sum(
      rows.filter((row) => row.paymentStatus === 'REFUNDED').map((row) => row.refundedAmount)
    );
    return {
      eventsInRange: events.length,
      reservations: rows.length,
      confirmed: confirmed.length,
      collected,
      expected: this.sum(confirmed.map((x) => x.amountDue)),
      outstanding: this.sum(receivables.map((x) => x.balance)),
      overdue: this.sum(receivables.filter((x) => x.isOverdue).map((x) => x.balance)),
      dueSoon: this.sum(receivables.filter((x) => x.isDueSoon).map((x) => x.balance)),
      courtesyValue: this.sum(
        confirmed.filter((x) => x.paymentStatus === 'COURTESY').map((x) => x.tablePrice)
      ),
      refunded,
      netCollected: collected - refunded,
    };
  }

  private buildMethodTotals(snapshots: EventReservationsSnapshot[]): MethodTotals {
    const totals: MethodTotals = { cash: 0, square: 0, cashapp: 0, credit: 0, refunds: 0 };

    for (const { reservations } of snapshots) {
      for (const reservation of reservations) {
        if (reservation.status === 'CONFIRMED') {
          const payments = reservation.payments ?? [];
          if (payments.length > 0) {
            for (const payment of payments) {
              const method = String((payment as { method?: unknown } | null | undefined)?.method ?? '')
                .trim()
                .toLowerCase();
              const amount = Number(payment.amount ?? 0);
              if (method === 'cash') totals.cash += amount;
              else if (method === 'square') totals.square += amount;
              else if (method === 'cashapp') totals.cashapp += amount;
              else if (method === 'credit') totals.credit += amount;
            }
          } else {
            const fallbackMethod = String(
              (reservation as { paymentMethod?: unknown } | null | undefined)?.paymentMethod ?? ''
            )
              .trim()
              .toLowerCase();
            const fallbackAmount = Number(reservation.depositAmount ?? 0);
            if (fallbackAmount > 0) {
              if (fallbackMethod === 'cash') totals.cash += fallbackAmount;
              else if (fallbackMethod === 'square') totals.square += fallbackAmount;
              else if (fallbackMethod === 'cashapp') totals.cashapp += fallbackAmount;
              else if (fallbackMethod === 'credit') totals.credit += fallbackAmount;
            }
          }
        }

        // Refunds — counted regardless of current reservation.status so the
        // operator can reconcile against Square. paymentStatus=REFUNDED is
        // the canonical refund marker; refundedAmount is the total dollar
        // value rolled across all successful refunds on the booking.
        if (
          String(reservation.paymentStatus ?? '').toUpperCase() === 'REFUNDED' &&
          Number(reservation.refundedAmount ?? 0) > 0
        ) {
          totals.refunds += Number(reservation.refundedAmount);
        }
      }
    }

    return totals;
  }

  private buildPaymentLedger(snapshots: EventReservationsSnapshot[]): PaymentLedgerRow[] {
    const rows: PaymentLedgerRow[] = [];

    for (const { event, reservations } of snapshots) {
      for (const reservation of reservations) {
        const eventDate = String(event.eventDate ?? '').trim();
        const eventName = String(event.eventName ?? '').trim();
        const reservationId = String(reservation.reservationId ?? '').trim();
        const tableId = String(reservation.tableId ?? '').trim();
        const tableIds =
          Array.isArray(reservation.tableIds) && reservation.tableIds.length > 0
            ? reservation.tableIds
            : tableId
            ? [tableId]
            : [];
        const customerName = String(reservation.customerName ?? '').trim();
        const payments = Array.isArray(reservation.payments) ? reservation.payments : [];

        if (payments.length > 0) {
          for (const payment of payments) {
            const mapped = this.mapPaymentLedgerRow({
              eventDate,
              eventName,
              reservationId,
              tableId,
              tableIds,
              customerName,
              reservation,
              payment,
            });
            if (mapped) rows.push(mapped);
          }
        } else {
          const fallbackAmount = Number(reservation.depositAmount ?? 0);
          const fallbackMethodRaw = String(
            (reservation as { paymentMethod?: unknown } | null | undefined)?.paymentMethod ?? ''
          )
            .trim()
            .toLowerCase();
          if (
            fallbackAmount > 0 &&
            (fallbackMethodRaw === 'cash' ||
              fallbackMethodRaw === 'square' ||
              fallbackMethodRaw === 'cashapp' ||
              fallbackMethodRaw === 'credit')
          ) {
            const fallbackMethod = fallbackMethodRaw as PaymentMethod;
            rows.push({
              paymentId: `fallback-${reservationId}`,
              eventDate,
              eventName,
              reservationId,
              tableId,
              tableIds,
              customerName,
              amount: fallbackAmount,
              method: fallbackMethod,
              source: fallbackMethod === 'credit' ? 'reschedule-credit' : 'manual',
              createdAt: Number(reservation.createdAt ?? 0),
              createdBy: String(reservation.createdBy ?? '').trim() || null,
              providerPaymentId: null,
              orderId: null,
              providerStatus: null,
              receiptUrl: null,
              isFallback: true,
              isRefund: false,
            });
          }
        }

        // Refund rows — appear as negative-amount entries so a refunded
        // reservation's charge + refund nets to zero in the ledger. Drives
        // operator reconciliation against Square.
        const refunds = Array.isArray(reservation.refunds) ? reservation.refunds : [];
        const refundedAt = Number(
          (reservation as { refundedAt?: unknown } | null | undefined)?.refundedAt ?? 0
        );
        const refundedBy = String(
          (reservation as { refundedBy?: unknown } | null | undefined)?.refundedBy ?? ''
        ).trim();
        for (const refund of refunds) {
          if (!refund || refund.success === false) continue;
          const refundAmount = Number(refund.amount ?? 0);
          if (!Number.isFinite(refundAmount) || refundAmount <= 0) continue;
          const refundMethodRaw = String(refund?.method ?? '').trim().toLowerCase();
          const refundMethod: PaymentMethod =
            refundMethodRaw === 'cashapp' ? 'cashapp' : 'square';
          const refundProviderId =
            String(refund?.refundId ?? refund?.providerPaymentId ?? '').trim() || null;
          rows.push({
            paymentId:
              `refund-${reservationId}-${String(refund?.paymentLocalId ?? refundProviderId ?? rows.length).trim()}`,
            eventDate,
            eventName,
            reservationId,
            tableId,
            tableIds,
            customerName,
            amount: -refundAmount,
            method: refundMethod,
            source: 'square-refund',
            createdAt: refundedAt || Number(reservation.updatedAt ?? reservation.createdAt ?? 0),
            createdBy: refundedBy || null,
            providerPaymentId: refundProviderId,
            orderId: null,
            providerStatus: String(refund?.refundStatus ?? '').trim() || null,
            receiptUrl: null,
            isFallback: false,
            isRefund: true,
          });
        }
      }
    }

    return rows.sort((a, b) => {
      const createdCmp = Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0);
      if (createdCmp !== 0) return createdCmp;
      const dateCmp = String(b.eventDate ?? '').localeCompare(String(a.eventDate ?? ''));
      if (dateCmp !== 0) return dateCmp;
      return String(a.tableId ?? '').localeCompare(String(b.tableId ?? ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }

  private mapPaymentLedgerRow(input: {
    eventDate: string;
    eventName: string;
    reservationId: string;
    tableId: string;
    tableIds: string[];
    customerName: string;
    reservation: ReservationItem;
    payment: ReservationPayment;
  }): PaymentLedgerRow | null {
    const { eventDate, eventName, reservationId, tableId, tableIds, customerName, reservation, payment } = input;
    const rawMethod = String(payment?.method ?? '').trim().toLowerCase();
    if (
      rawMethod !== 'cash' &&
      rawMethod !== 'cashapp' &&
      rawMethod !== 'square' &&
      rawMethod !== 'credit'
    ) {
      return null;
    }
    const method = rawMethod as PaymentMethod;

    const provider = payment?.provider && typeof payment.provider === 'object' ? payment.provider : null;
    const rawSource = String(payment?.source ?? '').trim().toLowerCase();
    const normalizedSource = this.normalizeLedgerSource(rawSource, method);

    return {
      paymentId: String(payment?.paymentId ?? '').trim() || `payment-${reservationId}`,
      eventDate,
      eventName,
      reservationId,
      tableId,
      tableIds,
      customerName,
      amount: Number(payment?.amount ?? 0),
      method,
      source: normalizedSource,
      createdAt: Number(payment?.createdAt ?? reservation.createdAt ?? 0),
      createdBy: String(payment?.createdBy ?? '').trim() || null,
      providerPaymentId: String(provider?.providerPaymentId ?? '').trim() || null,
      orderId: String(provider?.orderId ?? '').trim() || null,
      providerStatus: String(provider?.providerStatus ?? '').trim() || null,
      receiptUrl: String(provider?.receiptUrl ?? '').trim() || null,
      isFallback: false,
      isRefund: false,
    };
  }

  private normalizeLedgerSource(rawSource: string, method: PaymentMethod): LedgerSource {
    const allowed: LedgerSource[] = [
      'manual',
      'square-direct',
      'square-webhook',
      'reschedule-credit',
      'square-refund',
    ];
    if ((allowed as string[]).includes(rawSource)) return rawSource as LedgerSource;
    if (method === 'cash') return 'manual';
    if (method === 'credit') return 'reschedule-credit';
    return 'square-direct';
  }

  private clearReport(): void {
    this.rows.set([]);
    this.receivables.set([]);
    this.ledgerRows.set([]);
    this.eventSummaries.set([]);
    this.methodTotals.set({ cash: 0, square: 0, cashapp: 0, credit: 0, refunds: 0 });
    this.overview.set({
      eventsInRange: 0,
      reservations: 0,
      confirmed: 0,
      collected: 0,
      expected: 0,
      outstanding: 0,
      overdue: 0,
      dueSoon: 0,
      courtesyValue: 0,
      refunded: 0,
      netCollected: 0,
    });
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
    // Defang CSV-injection / formula-execution: spreadsheets evaluate cells
    // that start with =, +, -, or @ as formulas. Prefix a single quote so
    // the cell is parsed as literal text. The quote is invisible in the
    // grid but breaks the formula path.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
      return `"${safe.replace(/"/g, '""')}"`;
    }
    return safe;
  }

  private sum(values: number[]): number {
    return values.reduce((acc, n) => acc + Number(n || 0), 0);
  }

  onSummariesPageChange(page: number): void {
    this.summariesPagination.update((s) => ({ ...s, pageIndex: Math.max(0, page - 1) }));
  }

  onSummariesPageSizeChange(size: number): void {
    this.summariesPagination.update((s) => ({ ...s, pageSize: size, pageIndex: 0 }));
  }

  onReceivablesPageChange(page: number): void {
    this.receivablesPagination.update((s) => ({ ...s, pageIndex: Math.max(0, page - 1) }));
  }

  onReceivablesPageSizeChange(size: number): void {
    this.receivablesPagination.update((s) => ({ ...s, pageSize: size, pageIndex: 0 }));
  }

  onLedgerPageChange(page: number): void {
    this.ledgerPagination.update((s) => ({ ...s, pageIndex: Math.max(0, page - 1) }));
  }

  onLedgerPageSizeChange(size: number): void {
    this.ledgerPagination.update((s) => ({ ...s, pageSize: size, pageIndex: 0 }));
  }

  isLedgerColumnVisible(id: string): boolean {
    return this.ledgerVisibility()[id] !== false;
  }

  toggleLedgerColumnVisibility(id: string): void {
    this.ledgerVisibility.update((s) => ({
      ...s,
      [id]: !this.isLedgerColumnVisible(id),
    }));
  }

  ledgerColumnLabel(id: string): string {
    return this.ledgerColumnLabels[id] ?? id;
  }

  summariesColumn(id: string) {
    return this.summariesTable.getColumn(id);
  }

  receivablesColumn(id: string) {
    return this.receivablesTable.getColumn(id);
  }

  ledgerColumn(id: string) {
    return this.ledgerTable.getColumn(id);
  }

  trackBySummaryDate(_: number, row: EventFinancialSummary): string {
    return row.eventDate;
  }

  trackByReceivable(_: number, row: FinancialRow): string {
    return row.reservationId;
  }

  trackByPaymentId(_: number, row: PaymentLedgerRow): string {
    return row.paymentId;
  }
}
