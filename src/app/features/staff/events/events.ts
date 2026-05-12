import {
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  type ColumnDef,
  type PaginationState,
  type SortingState,
  createAngularTable,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
} from '@tanstack/angular-table';
import { EventsService } from '../../../core/http/events.service';
import { EventItem } from '../../../shared/models/event.model';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';
import { HlmInput } from '../../../shared/ui/input';
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

@Component({
  selector: 'app-staff-events',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    HlmAlert,
    HlmButton,
    HlmInput,
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
  templateUrl: './events.html',
  styleUrl: './events.scss',
})
export class StaffEvents implements OnInit {
  private eventsApi = inject(EventsService);
  private router = inject(Router);

  readonly items = signal<EventItem[]>([]);
  loading = false;
  error: string | null = null;
  filterQuery = new FormControl('', { nonNullable: true });

  private readonly query = toSignal(this.filterQuery.valueChanges, { initialValue: '' });
  readonly sorting = signal<SortingState>([{ id: 'eventDate', desc: false }]);
  readonly pagination = signal<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE });

  private readonly tableColumns: ColumnDef<EventItem>[] = [
    {
      id: 'eventDate',
      accessorFn: (e) => e.eventDate ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'eventName',
      accessorFn: (e) => e.eventName ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'status',
      accessorFn: (e) => e.status ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'minDeposit',
      accessorFn: (e) => Number(e.minDeposit ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    { id: 'actions', enableSorting: false },
  ];

  readonly table = createAngularTable<EventItem>(() => ({
    data: this.items(),
    columns: this.tableColumns,
    state: {
      sorting: this.sorting(),
      globalFilter: this.query(),
      pagination: this.pagination(),
    },
    onSortingChange: (u) => {
      const next = typeof u === 'function' ? u(this.sorting()) : u;
      this.sorting.set(next);
    },
    onPaginationChange: (u) => {
      const next = typeof u === 'function' ? u(this.pagination()) : u;
      this.pagination.set(next);
    },
    globalFilterFn: (row, _id, filterValue: string) => {
      const q = String(filterValue ?? '').trim().toLowerCase();
      if (!q) return true;
      const e = row.original;
      return Boolean(
        (e.eventName || '').toLowerCase().includes(q) ||
          (e.eventDate || '').toLowerCase().includes(q) ||
          (e.status || '').toLowerCase().includes(q),
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

  constructor() {
    effect(() => {
      this.query();
      this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
    });
  }

  ngOnInit(): void {
    this.loadEvents();
  }

  loadEvents(): void {
    this.loading = true;
    this.error = null;
    this.eventsApi.listEvents().subscribe({
      next: (items) => {
        this.items.set(
          [...items].sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || '')),
        );
        this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.message || 'Failed to load events';
        this.loading = false;
      },
    });
  }

  onPageChange(page: number): void {
    this.pagination.update((s) => ({ ...s, pageIndex: Math.max(0, page - 1) }));
  }

  onPageSizeChange(size: number): void {
    this.pagination.update((s) => ({ ...s, pageSize: size, pageIndex: 0 }));
  }

  column(id: string) {
    return this.table.getColumn(id);
  }

  trackByEventId(_: number, item: EventItem): string {
    return item.eventId;
  }

  goToReservations(eventDate: string): void {
    this.router.navigate(['/staff/reservations/new'], {
      queryParams: { date: eventDate },
    });
  }
}
