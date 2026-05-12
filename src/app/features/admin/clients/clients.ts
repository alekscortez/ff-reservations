import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
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

import { ClientsService } from '../../../core/http/clients.service';
import { FrequentClientsService } from '../../../core/http/frequent-clients.service';
import { CrmClient } from '../../../shared/models/client.model';
import {
  inferPhoneCountryFromE164,
  normalizePhoneCountry,
  normalizePhoneToE164,
} from '../../../shared/phone';
import { PhoneDisplayPipe } from '../../../shared/phone-display.pipe';
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

const PAGE_SIZE = 50;

@Component({
  selector: 'app-clients',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    PhoneDisplayPipe,
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
  templateUrl: './clients.html',
  styleUrl: './clients.scss',
})
export class Clients implements OnInit {
  private clientsApi = inject(ClientsService);
  private frequentApi = inject(FrequentClientsService);

  readonly items = signal<CrmClient[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly editingPhone = signal<string | null>(null);
  editPhoneCountry: 'US' | 'MX' = 'US';

  readonly filterQuery = new FormControl('', { nonNullable: true });
  private readonly query = toSignal(this.filterQuery.valueChanges, { initialValue: '' });

  readonly sorting = signal<SortingState>([{ id: 'lastEventDate', desc: true }]);
  readonly pagination = signal<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE });

  private readonly columns: ColumnDef<CrmClient>[] = [
    { id: 'name', accessorKey: 'name', enableSorting: true, sortingFn: 'alphanumeric' },
    { id: 'phone', accessorKey: 'phone', enableSorting: true, sortingFn: 'alphanumeric' },
    {
      id: 'totalSpend',
      accessorFn: (c) => Number(c.totalSpend ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    {
      id: 'totalReservations',
      accessorFn: (c) => Number(c.totalReservations ?? 0),
      enableSorting: true,
      sortingFn: 'basic',
    },
    {
      id: 'lastEventDate',
      accessorFn: (c) => c.lastEventDate ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    { id: 'lastTableId', accessorKey: 'lastTableId', enableSorting: true, sortingFn: 'alphanumeric' },
    { id: 'updatedBy', accessorKey: 'updatedBy', enableSorting: true, sortingFn: 'alphanumeric' },
    { id: 'actions', enableSorting: false },
  ];

  readonly table = createAngularTable<CrmClient>(() => ({
    data: this.items(),
    columns: this.columns,
    state: {
      sorting: this.sorting(),
      globalFilter: this.query(),
      pagination: this.pagination(),
    },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(this.sorting()) : updater;
      this.sorting.set(next);
    },
    onPaginationChange: (updater) => {
      const next = typeof updater === 'function' ? updater(this.pagination()) : updater;
      this.pagination.set(next);
    },
    globalFilterFn: (row, _columnId, filterValue: string) => {
      const q = String(filterValue ?? '').trim().toLowerCase();
      if (!q) return true;
      const c = row.original;
      return Boolean(
        c.name?.toLowerCase().includes(q) || c.phone?.includes(q),
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  }));

  /** Filtered + sorted slice for the *current* page (mobile cards + desktop tbody). */
  readonly currentRows = computed(() =>
    this.table.getRowModel().rows.map((r) => r.original),
  );
  readonly totalFiltered = computed(() => this.table.getFilteredRowModel().rows.length);

  /** 1-based mirror of `pagination().pageIndex` for `<hlm-numbered-pagination>`. */
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

  editForm = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
    phone: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    effect(() => {
      // Reset to page 0 whenever the search query changes.
      this.query();
      this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
    });
  }

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.clientsApi.list().subscribe({
      next: (items) => {
        this.items.set(items);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to load clients');
        this.loading.set(false);
      },
    });
  }

  onPageChange(page: number): void {
    this.pagination.update((s) => ({ ...s, pageIndex: Math.max(0, page - 1) }));
  }

  onPageSizeChange(size: number): void {
    this.pagination.update((s) => ({ ...s, pageSize: size, pageIndex: 0 }));
  }

  /** Adapter used by sort-header components in the template. */
  column(id: string) {
    return this.table.getColumn(id);
  }

  formatMoney(value?: number): string {
    const num = Number(value ?? 0);
    return num.toFixed(2);
  }

  trackByPhone(_: number, item: CrmClient): string {
    return item.phone ?? '';
  }

  startEdit(item: CrmClient): void {
    this.editingPhone.set(item.phone);
    this.editPhoneCountry =
      inferPhoneCountryFromE164(item.phone) ??
      normalizePhoneCountry(item.phoneCountry ?? 'US');
    this.editForm.setValue({
      name: item.name ?? '',
      phone: item.phone ?? '',
    });
  }

  cancelEdit(): void {
    this.editingPhone.set(null);
  }

  saveEdit(): void {
    const editingPhone = this.editingPhone();
    if (!editingPhone) return;
    const phone = normalizePhoneToE164(
      this.editForm.controls.phone.value.trim(),
      normalizePhoneCountry(this.editPhoneCountry),
    );
    if (!phone) {
      this.error.set('Phone must be a valid US or MX number.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    const patch = {
      name: this.editForm.controls.name.value.trim(),
      phone,
      phoneCountry: this.editPhoneCountry,
    };
    this.clientsApi.update(editingPhone, patch).subscribe({
      next: (item) => {
        this.items.update((list) => list.map((x) => (x.phone === editingPhone ? item : x)));
        this.editingPhone.set(null);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to update client');
        this.loading.set(false);
      },
    });
  }

  addToFrequent(item: CrmClient): void {
    const defaultTables = window.prompt('Default tables (e.g. A01, A02):', '');
    if (!defaultTables) return;
    const notes = window.prompt('Notes (optional):', '') || '';
    this.loading.set(true);
    this.error.set(null);
    this.frequentApi
      .create({
        name: item.name ?? 'Unknown',
        phone: item.phone ?? '',
        phoneCountry: item.phoneCountry,
        defaultTableIds: defaultTables
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
        notes: notes.trim(),
      })
      .subscribe({
        next: () => {
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(
            err?.error?.message || err?.message || 'Failed to add frequent client',
          );
          this.loading.set(false);
        },
      });
  }

  deleteClient(item: CrmClient): void {
    const ok = window.confirm(`Delete client ${item.name}?`);
    if (!ok) return;
    this.loading.set(true);
    this.error.set(null);
    this.clientsApi.delete(item.phone ?? '').subscribe({
      next: () => {
        this.items.update((list) => list.filter((x) => x.phone !== item.phone));
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to delete client');
        this.loading.set(false);
      },
    });
  }
}
