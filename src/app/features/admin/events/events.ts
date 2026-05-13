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
import { lucideEllipsis, lucideX } from '@ng-icons/lucide';
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
import { TablesService } from '../../../core/http/tables.service';
import { FrequentClientsService } from '../../../core/http/frequent-clients.service';
import { CreateEventPayload, EventItem } from '../../../shared/models/event.model';
import { TableInfo } from '../../../shared/models/table.model';
import { FrequentClient } from '../../../shared/models/frequent-client.model';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmConfirmDialog, HlmDialog } from '../../../shared/ui/dialog';
import { HlmButton } from '../../../shared/ui/button';
import { HlmInput } from '../../../shared/ui/input';
import { HlmToggle } from '../../../shared/ui/toggle';
import {
  HlmMenu,
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

const PAGE_SIZE = 25;

@Component({
  selector: 'app-events',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    NgIcon,
    HlmAlert,
    HlmConfirmDialog,
    HlmDialog,
    HlmButton,
    HlmInput,
    HlmToggle,
    HlmMenu,
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
  ],
  providers: [provideIcons({ lucideEllipsis, lucideX })],
  templateUrl: './events.html',
  styleUrl: './events.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Events implements OnInit, OnDestroy {
  private eventsApi = inject(EventsService);
  private tablesApi = inject(TablesService);
  private frequentApi = inject(FrequentClientsService);

  readonly items = signal<EventItem[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly conflictDate = signal<string | null>(null);
  readonly editingId = signal<string | null>(null);
  readonly showCreateModal = signal(false);
  readonly templateSections = signal<SectionKey[]>([]);
  readonly templateTablesBySection = signal<Record<string, TableInfo[]>>({});

  readonly createDisabled = signal<Set<string>>(new Set());
  readonly editDisabled = signal<Set<string>>(new Set());
  readonly frequentClients = signal<FrequentClient[]>([]);
  readonly createDisabledClients = signal<Set<string>>(new Set());
  readonly editDisabledClients = signal<Set<string>>(new Set());

  form = new FormGroup({
    eventName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    eventDate: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    minDeposit: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
  });

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

  createSectionPricing = new FormGroup({
    A: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    B: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    C: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    D: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    E: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
  });

  editForm = new FormGroup({
    eventName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    eventDate: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    minDeposit: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    status: new FormControl<'ACTIVE' | 'INACTIVE'>('ACTIVE', { nonNullable: true }),
  });

  editSectionPricing = new FormGroup({
    A: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    B: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    C: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    D: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    E: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
  });

  constructor() {
    effect(() => {
      this.query();
      this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
    });
  }

  ngOnInit(): void {
    this.loadEvents();
    this.loadTemplate();
    this.loadFrequentClients();
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

  ngOnDestroy(): void {
    this.syncSidebarModalLock(true);
  }

  loadEvents(): void {
    this.loading.set(true);
    this.error.set(null);
    this.conflictDate.set(null);
    this.eventsApi.listEvents().subscribe({
      next: (items) => {
        this.items.set(
          [...items].sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || '')),
        );
        this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message || 'Failed to load events');
        this.loading.set(false);
      },
    });
  }

  loadTemplate(): void {
    this.tablesApi.getTemplate().subscribe({
      next: (template) => {
        const sections = Object.keys(template.sections ?? {}).sort() as SectionKey[];
        this.templateSections.set(sections);
        this.templateTablesBySection.set(
          sections.reduce((acc, s) => {
            acc[s] = template.tables.filter((t) => t.section === s);
            return acc;
          }, {} as Record<string, TableInfo[]>),
        );

        for (const s of sections) {
          const price = template.sections[s] ?? 0;
          this.createSectionPricing.controls[s].setValue(price);
          this.editSectionPricing.controls[s].setValue(price);
        }
      },
      error: () => {
        // keep UI usable even if template fails
      },
    });
  }

  loadFrequentClients(): void {
    this.frequentApi.list().subscribe({
      next: (items) => {
        this.frequentClients.set(items);
      },
      error: () => {
        this.frequentClients.set([]);
      },
    });
  }

  createEvent(): void {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set(null);
    this.conflictDate.set(null);

    const payload: CreateEventPayload = {
      eventName: this.form.controls.eventName.value.trim(),
      eventDate: this.form.controls.eventDate.value,
      minDeposit: this.form.controls.minDeposit.value,
      sectionPricing: this.sectionPricingValue(this.createSectionPricing.value),
      disabledTables: Array.from(this.createDisabled()),
      disabledClients: Array.from(this.createDisabledClients()),
    };

    this.eventsApi.createEvent(payload).subscribe({
      next: (item) => {
        this.items.update((list) =>
          [item, ...list].sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || '')),
        );
        this.form.reset({ eventName: '', eventDate: '', minDeposit: 0 });
        this.createDisabled.set(new Set());
        this.createDisabledClients.set(new Set());
        this.showCreateModal.set(false);
        this.syncSidebarModalLock();
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to create event');
        if (err?.status === 409) {
          this.conflictDate.set(payload.eventDate);
        }
        this.loading.set(false);
      },
    });
  }

  startEdit(item: EventItem): void {
    this.editingId.set(item.eventId);
    this.error.set(null);
    this.conflictDate.set(null);
    this.editForm.setValue({
      eventName: item.eventName ?? '',
      eventDate: item.eventDate ?? '',
      minDeposit: item.minDeposit ?? 0,
      status: item.status ?? 'ACTIVE',
    });
    this.editDisabled.set(new Set(item.disabledTables ?? []));
    this.editDisabledClients.set(new Set(item.disabledClients ?? []));
    const sp = item.sectionPricing ?? {};
    for (const s of Object.keys(this.editSectionPricing.controls) as SectionKey[]) {
      const current = this.editSectionPricing.controls[s].value;
      const val = sp[s] ?? current;
      this.editSectionPricing.controls[s].setValue(val);
    }
    this.syncSidebarModalLock();
  }

  cancelEdit(): void {
    if (this.loading()) return;
    this.editingId.set(null);
    this.syncSidebarModalLock();
  }

  openCreateModal(): void {
    this.showCreateModal.set(true);
    this.error.set(null);
    this.conflictDate.set(null);
    this.syncSidebarModalLock();
  }

  closeCreateModal(): void {
    this.showCreateModal.set(false);
    this.syncSidebarModalLock();
  }

  saveEdit(): void {
    const editingId = this.editingId();
    if (!editingId) return;
    if (this.editForm.invalid) return;

    this.loading.set(true);
    this.error.set(null);
    this.conflictDate.set(null);

    const patch: Partial<EventItem> = {
      eventName: this.editForm.controls.eventName.value.trim(),
      eventDate: this.editForm.controls.eventDate.value,
      minDeposit: this.editForm.controls.minDeposit.value,
      status: this.editForm.controls.status.value,
      sectionPricing: this.sectionPricingValue(this.editSectionPricing.value),
      disabledTables: Array.from(this.editDisabled()),
      disabledClients: Array.from(this.editDisabledClients()),
    };

    this.eventsApi.updateEvent(editingId, patch).subscribe({
      next: (item) => {
        this.items.update((list) =>
          list
            .map((x) => (x.eventId === item.eventId ? item : x))
            .sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || '')),
        );
        this.editingId.set(null);
        this.loading.set(false);
        this.syncSidebarModalLock();
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to update event');
        if (err?.status === 409) {
          this.conflictDate.set(patch.eventDate ?? null);
        }
        this.loading.set(false);
      },
    });
  }

  readonly deleteTarget = signal<EventItem | null>(null);

  deleteEvent(item: EventItem): void {
    this.deleteTarget.set(item);
  }

  cancelDeleteEvent(): void {
    this.deleteTarget.set(null);
  }

  confirmDeleteEvent(): void {
    const item = this.deleteTarget();
    if (!item) return;
    this.deleteTarget.set(null);

    this.loading.set(true);
    this.error.set(null);
    this.conflictDate.set(null);
    this.eventsApi.deleteEvent(item.eventId).subscribe({
      next: () => {
        this.items.update((list) => list.filter((x) => x.eventId !== item.eventId));
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to delete event');
        this.loading.set(false);
      },
    });
  }

  toggleCreateDisabled(id: string): void {
    this.createDisabled.update((current) => this.toggleSetEntry(current, id));
  }

  toggleEditDisabled(id: string): void {
    this.editDisabled.update((current) => this.toggleSetEntry(current, id));
  }

  isCreateDisabled(id: string): boolean {
    return this.createDisabled().has(id);
  }

  isEditDisabled(id: string): boolean {
    return this.editDisabled().has(id);
  }

  toggleCreateDisabledClient(id: string): void {
    this.createDisabledClients.update((current) => this.toggleSetEntry(current, id));
  }

  toggleEditDisabledClient(id: string): void {
    this.editDisabledClients.update((current) => this.toggleSetEntry(current, id));
  }

  isCreateDisabledClient(id: string): boolean {
    return this.createDisabledClients().has(id);
  }

  isEditDisabledClient(id: string): boolean {
    return this.editDisabledClients().has(id);
  }

  private toggleSetEntry(current: Set<string>, id: string): Set<string> {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  formatClientTables(client: FrequentClient): string {
    const list = client.defaultTableIds?.length
      ? client.defaultTableIds
      : client.defaultTableId
        ? [client.defaultTableId]
        : [];
    return list.join(', ');
  }

  private sectionPricingValue(value: any): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value ?? {})) {
      const num = Number(v);
      if (Number.isFinite(num)) out[k] = num;
    }
    return out;
  }

  private syncSidebarModalLock(forceClear = false): void {
    if (typeof document === 'undefined') return;
    const isLocked = forceClear ? false : this.showCreateModal() || !!this.editingId();
    document.body.classList.toggle('events-modal-open', isLocked);
  }

  getSectionControl(
    form: FormGroup<{
      A: FormControl<number>;
      B: FormControl<number>;
      C: FormControl<number>;
      D: FormControl<number>;
      E: FormControl<number>;
    }>,
    section: SectionKey
  ): FormControl<number> {
    return form.controls[section];
  }
}

type SectionKey = 'A' | 'B' | 'C' | 'D' | 'E';
