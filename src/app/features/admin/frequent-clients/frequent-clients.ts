import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideCopy,
  lucideEllipsis,
  lucideMessageCircle,
  lucideRefreshCw,
  lucideX,
} from '@ng-icons/lucide';
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
  FrequentClientsService,
  FrequentClientActiveLink,
} from '../../../core/http/frequent-clients.service';
import { ReservationsService } from '../../../core/http/reservations.service';
import { TablesService } from '../../../core/http/tables.service';
import {
  FrequentClient,
  FrequentClientTableSetting,
  PaymentStatus,
} from '../../../shared/models/frequent-client.model';
import { TableInfo } from '../../../shared/models/table.model';
import {
  inferPhoneCountryFromE164,
  normalizePhoneCountry,
  normalizePhoneToE164,
} from '../../../shared/phone';
import { PhoneDisplayPipe } from '../../../shared/phone-display.pipe';
import { SettingsService } from '../../../core/http/settings.service';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmButton } from '../../../shared/ui/button';
import { HlmConfirmDialog, HlmDialog } from '../../../shared/ui/dialog';
import { HlmInput } from '../../../shared/ui/input';
import { HlmToggle } from '../../../shared/ui/toggle';
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

const PAGE_SIZE = 25;

@Component({
  selector: 'app-frequent-clients',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    NgIcon,
    PhoneDisplayPipe,
    HlmAlert,
    HlmButton,
    HlmConfirmDialog,
    HlmDialog,
    HlmInput,
    HlmToggle,
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
  ],
  providers: [
    provideIcons({
      lucideChevronDown,
      lucideCopy,
      lucideEllipsis,
      lucideMessageCircle,
      lucideRefreshCw,
      lucideX,
    }),
  ],
  templateUrl: './frequent-clients.html',
  styleUrl: './frequent-clients.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FrequentClients implements OnInit {
  private clientsApi = inject(FrequentClientsService);
  private reservationsApi = inject(ReservationsService);
  private tablesApi = inject(TablesService);
  private settingsApi = inject(SettingsService);
  private destroyRef = inject(DestroyRef);
  private router = inject(Router);

  readonly items = signal<FrequentClient[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly editingId = signal<string | null>(null);
  readonly templateSections = signal<string[]>([]);
  readonly templateTablesBySection = signal<Record<string, TableInfo[]>>({});
  readonly tableInfoById = signal<Record<string, TableInfo>>({});
  readonly tablePriceById = signal<Record<string, number>>({});
  readonly activeSection = signal('');
  readonly createSelectedTables = signal<Set<string>>(new Set());
  readonly editSelectedTables = signal<Set<string>>(new Set());
  readonly createTableSettings = signal<Record<string, FrequentClientTableSetting>>({});
  readonly editTableSettings = signal<Record<string, FrequentClientTableSetting>>({});
  editSettings = new FormArray<FormGroup>([]);
  readonly showCreateForm = signal(false);
  filterQuery = new FormControl('', { nonNullable: true });
  paymentStatuses: PaymentStatus[] = ['PENDING', 'PARTIAL', 'PAID', 'COURTESY'];
  readonly defaultDeadlineTime = signal('00:00');
  readonly defaultDeadlineTz = signal('America/Chicago');
  readonly createPhoneCountry = signal<'US' | 'MX'>('US');
  readonly editPhoneCountry = signal<'US' | 'MX'>('US');
  readonly deleteTarget = signal<FrequentClient | null>(null);

  // Payment-links panel state — separate dialog opened from the row menu.
  // Loads on open, refetches after each successful mutation (extend
  // deadline / regenerate link) so the staff sees fresh data without
  // closing + reopening.
  readonly linksTarget = signal<FrequentClient | null>(null);
  readonly linksLoading = signal(false);
  readonly linksError = signal<string | null>(null);
  readonly activeLinks = signal<FrequentClientActiveLink[]>([]);
  // Reservation IDs currently mid-mutation. Disables both buttons on the
  // row + shows a "saving…" hint so staff doesn't double-click.
  readonly mutatingReservationIds = signal<Set<string>>(new Set());
  readonly expandedExtendId = signal<string | null>(null);
  // Holds the custom datetime input per-row when the staff chooses
  // "Custom". One control because only one row's Custom panel is open
  // at a time.
  customDeadline = new FormControl('', { nonNullable: true });
  readonly copyFeedbackId = signal<string | null>(null);

  form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    defaultTableIds: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    notes: new FormControl('', { nonNullable: true }),
  });

  editForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    defaultTableIds: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    notes: new FormControl('', { nonNullable: true }),
    status: new FormControl<'ACTIVE' | 'DISABLED'>('ACTIVE', { nonNullable: true }),
  });

  private readonly query = toSignal(this.filterQuery.valueChanges, { initialValue: '' });
  readonly sorting = signal<SortingState>([{ id: 'name', desc: false }]);
  readonly pagination = signal<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE });
  readonly columnVisibility = signal<VisibilityState>({});

  readonly hidableColumnIds: ReadonlyArray<string> = [
    'name',
    'phone',
    'tables',
    'status',
    'notes',
  ];

  private readonly columnLabels: Record<string, string> = {
    name: 'Name',
    phone: 'Phone',
    tables: 'Reserved Tables',
    status: 'Status',
    notes: 'Notes',
  };

  private readonly tableColumns: ColumnDef<FrequentClient>[] = [
    {
      id: 'name',
      accessorFn: (c) => c.name ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'phone',
      accessorFn: (c) => c.phone ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'tables',
      accessorFn: (c) => this.formatTables(c),
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'status',
      accessorFn: (c) => c.status ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    {
      id: 'notes',
      accessorFn: (c) => c.notes ?? '',
      enableSorting: true,
      sortingFn: 'alphanumeric',
    },
    { id: 'actions', enableSorting: false },
  ];

  readonly table = createAngularTable<FrequentClient>(() => ({
    data: this.items(),
    columns: this.tableColumns,
    state: {
      sorting: this.sorting(),
      globalFilter: this.query(),
      pagination: this.pagination(),
      columnVisibility: this.columnVisibility(),
    },
    onSortingChange: (u) => {
      const next = typeof u === 'function' ? u(this.sorting()) : u;
      this.sorting.set(next);
    },
    onPaginationChange: (u) => {
      const next = typeof u === 'function' ? u(this.pagination()) : u;
      this.pagination.set(next);
    },
    onColumnVisibilityChange: (u) => {
      const next = typeof u === 'function' ? u(this.columnVisibility()) : u;
      this.columnVisibility.set(next);
    },
    globalFilterFn: (row, _id, filterValue: string) => {
      const q = String(filterValue ?? '').trim().toLowerCase();
      if (!q) return true;
      const c = row.original;
      return Boolean(
        (c.name ?? '').toLowerCase().includes(q) ||
          String(c.phone ?? '').toLowerCase().includes(q) ||
          this.formatTables(c).toLowerCase().includes(q),
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

  constructor() {
    effect(() => {
      this.query();
      this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
    });
  }

  ngOnInit(): void {
    this.load();
    this.loadTemplate();
    this.loadGlobalTimezone();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.clientsApi.list().subscribe({
      next: (items) => {
        this.items.set(items);
        this.pagination.update((s) => ({ ...s, pageIndex: 0 }));
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

  trackByClientId(_: number, item: FrequentClient): string {
    return item.clientId;
  }

  loadTemplate(): void {
    this.tablesApi.getTemplate().subscribe({
      next: (template) => {
        const sections = Object.keys(template.sections ?? {}).sort();
        this.templateSections.set(sections);
        this.activeSection.set(sections[0] ?? '');
        this.templateTablesBySection.set(
          sections.reduce((acc, s) => {
            acc[s] = template.tables.filter((t) => t.section === s);
            return acc;
          }, {} as Record<string, TableInfo[]>),
        );
        this.tableInfoById.set(
          template.tables.reduce((acc, t) => {
            acc[t.id] = t;
            return acc;
          }, {} as Record<string, TableInfo>),
        );
        this.tablePriceById.set(
          template.tables.reduce((acc, t) => {
            acc[t.id] = t.price;
            return acc;
          }, {} as Record<string, number>),
        );
      },
      error: () => {
        this.templateSections.set([]);
        this.templateTablesBySection.set({});
        this.activeSection.set('');
      },
    });
  }

  private loadGlobalTimezone(): void {
    this.settingsApi.getAdminSettings().subscribe({
      next: (settings) => this.applyGlobalDeadlineTimezone(settings.operatingTz),
      error: () => {
        // Keep current default timezone if settings load fails.
      },
    });
  }

  private applyGlobalDeadlineTimezone(timezone: string | null | undefined): void {
    const normalized = String(timezone ?? '').trim();
    if (!normalized) return;
    this.defaultDeadlineTz.set(normalized);

    this.createTableSettings.update((current) => {
      const next: Record<string, FrequentClientTableSetting> = { ...current };
      for (const tableId of Object.keys(next)) {
        next[tableId] = { ...next[tableId], paymentDeadlineTz: normalized };
      }
      return next;
    });

    this.editTableSettings.update((current) => {
      const next: Record<string, FrequentClientTableSetting> = { ...current };
      for (const tableId of Object.keys(next)) {
        next[tableId] = { ...next[tableId], paymentDeadlineTz: normalized };
      }
      return next;
    });

    for (const group of this.editSettings.controls) {
      group.controls['paymentDeadlineTz'].setValue(normalized, { emitEvent: false });
    }
  }

  create(): void {
    if (this.form.invalid) return;
    const country = this.createPhoneCountry();
    const phone = normalizePhoneToE164(
      this.form.controls.phone.value.trim(),
      normalizePhoneCountry(country)
    );
    if (!phone) {
      this.error.set('Phone must be a valid US or MX number.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    const selected = this.createSelectedTables();
    this.clientsApi
      .create({
        name: this.form.controls.name.value.trim(),
        phone,
        phoneCountry: country,
        defaultTableIds: Array.from(selected),
        tableSettings: this.serializeSettings(selected, this.createTableSettings()),
        notes: this.form.controls.notes.value.trim(),
      })
      .subscribe({
        next: (item) => {
          this.items.update((list) => [item, ...list]);
          this.form.reset({ name: '', phone: '', defaultTableIds: '', notes: '' });
          this.createPhoneCountry.set('US');
          this.createSelectedTables.set(new Set());
          this.createTableSettings.set({});
          this.showCreateForm.set(false);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(err?.error?.message || err?.message || 'Failed to create client');
          this.loading.set(false);
        },
      });
  }

  startEdit(item: FrequentClient): void {
    this.editingId.set(item.clientId);
    this.loading.set(true);
    this.clientsApi.get(item.clientId).subscribe({
      next: (full) => {
        this.applyEditClient(full);
        this.loading.set(false);
      },
      error: () => {
        this.applyEditClient(item);
        this.loading.set(false);
      },
    });
  }

  private applyEditClient(item: FrequentClient): void {
    const selected = this.normalizeTableList(item.defaultTableIds ?? item.defaultTableId);
    this.editSelectedTables.set(new Set(selected));
    const nextSettings: Record<string, FrequentClientTableSetting> = {};
    (item.tableSettings ?? []).forEach((setting) => {
      const key = String(setting.tableId ?? '').trim().toUpperCase();
      if (!key) return;
      nextSettings[key] = this.normalizeSetting({ ...setting, tableId: key });
    });
    this.editTableSettings.set(nextSettings);
    this.editSettings.clear();
    this.editSelectedTables().forEach((tableId) => {
      this.ensureEditSetting(tableId);
      const setting = this.editTableSettings()[tableId];
      if (setting) {
        const group = this.buildSettingGroup(setting);
        group.controls['paymentStatus'].valueChanges
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe((status) => {
          const current = group.getRawValue() as FrequentClientTableSetting;
          const next = this.applyRules({
            ...current,
            paymentStatus: status as PaymentStatus,
          });
          group.patchValue(
            {
              amountDue: next.amountDue,
              amountPaid: next.amountPaid ?? 0,
              paymentDeadlineTime: next.paymentDeadlineTime ?? this.defaultDeadlineTime(),
              paymentDeadlineTz: next.paymentDeadlineTz ?? this.defaultDeadlineTz(),
            },
            { emitEvent: false }
          );
        });
        this.editSettings.push(group);
      }
    });
    this.editForm.setValue({
      name: item.name ?? '',
      phone: item.phone ?? '',
      defaultTableIds: this.formatTables(item),
      notes: item.notes ?? '',
      status: item.status ?? 'ACTIVE',
    });
    this.editPhoneCountry.set(
      inferPhoneCountryFromE164(item.phone) ??
        normalizePhoneCountry(item.phoneCountry ?? 'US'),
    );
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  saveEdit(): void {
    const editingId = this.editingId();
    if (!editingId) return;
    if (this.editForm.invalid) return;
    const country = this.editPhoneCountry();
    const phone = normalizePhoneToE164(
      this.editForm.controls.phone.value.trim(),
      normalizePhoneCountry(country)
    );
    if (!phone) {
      this.error.set('Phone must be a valid US or MX number.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    const settings = this.editSettings.controls.map((group) => {
      const raw = group.getRawValue() as FrequentClientTableSetting;
      return this.applyRules({
        tableId: String(raw.tableId ?? '').trim().toUpperCase(),
        paymentStatus: raw.paymentStatus,
        amountDue: Number(raw.amountDue ?? 0),
        amountPaid: Number(raw.amountPaid ?? 0),
        paymentDeadlineTime: raw.paymentDeadlineTime,
        paymentDeadlineTz: raw.paymentDeadlineTz,
      });
    });
    const tableIds = settings.map((s) => s.tableId);
    const patch = {
      name: this.editForm.controls.name.value.trim(),
      phone,
      phoneCountry: country,
      defaultTableIds: tableIds,
      tableSettings: settings,
      notes: this.editForm.controls.notes.value.trim(),
      status: this.editForm.controls.status.value,
    };
    this.clientsApi.update(editingId, patch).subscribe({
      next: (item) => {
        this.items.update((list) =>
          list.map((x) => (x.clientId === item.clientId ? item : x)),
        );
        this.editingId.set(null);
        this.load();
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to update client');
        this.loading.set(false);
      },
    });
  }

  delete(item: FrequentClient): void {
    this.deleteTarget.set(item);
  }

  cancelDelete(): void {
    this.deleteTarget.set(null);
  }

  confirmDelete(): void {
    const item = this.deleteTarget();
    if (!item) return;
    this.deleteTarget.set(null);
    this.loading.set(true);
    this.error.set(null);
    this.clientsApi.delete(item.clientId).subscribe({
      next: () => {
        this.items.update((list) => list.filter((x) => x.clientId !== item.clientId));
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || err?.message || 'Failed to delete client');
        this.loading.set(false);
      },
    });
  }

  // ---- Payment-links panel ---------------------------------------------------

  openLinks(item: FrequentClient): void {
    this.linksTarget.set(item);
    this.expandedExtendId.set(null);
    this.copyFeedbackId.set(null);
    this.loadActiveLinks(item.clientId);
  }

  closeLinks(): void {
    this.linksTarget.set(null);
    this.expandedExtendId.set(null);
    this.activeLinks.set([]);
    this.linksError.set(null);
  }

  private loadActiveLinks(clientId: string): void {
    this.linksLoading.set(true);
    this.linksError.set(null);
    this.clientsApi.listActiveLinks(clientId).subscribe({
      next: (items) => {
        this.activeLinks.set(items);
        this.linksLoading.set(false);
      },
      error: (err) => {
        this.linksError.set(
          err?.error?.message || err?.message || 'Failed to load payment links'
        );
        this.linksLoading.set(false);
      },
    });
  }

  isLinkRowMutating(reservationId: string): boolean {
    return this.mutatingReservationIds().has(reservationId);
  }

  private setRowMutating(reservationId: string, mutating: boolean): void {
    this.mutatingReservationIds.update((current) => {
      const next = new Set(current);
      if (mutating) next.add(reservationId);
      else next.delete(reservationId);
      return next;
    });
  }

  toggleExtend(reservationId: string, currentDeadlineAt: string | null): void {
    if (this.expandedExtendId() === reservationId) {
      this.expandedExtendId.set(null);
      return;
    }
    this.expandedExtendId.set(reservationId);
    // Seed the custom input with the current deadline so staff can nudge
    // it instead of re-typing the whole thing.
    this.customDeadline.setValue(
      String(currentDeadlineAt ?? '').slice(0, 16) || '',
      { emitEvent: false }
    );
  }

  async copyLink(link: FrequentClientActiveLink): Promise<void> {
    const url = String(link?.paymentLinkUrl ?? '').trim();
    if (!url) return;
    try {
      await navigator.clipboard?.writeText?.(url);
    } catch {
      // Clipboard refused (some browsers gate behind permissions / focus).
      // Fall back to the legacy execCommand path — works inside ng modals.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
    }
    this.copyFeedbackId.set(link.reservationId);
    setTimeout(() => {
      if (this.copyFeedbackId() === link.reservationId) {
        this.copyFeedbackId.set(null);
      }
    }, 1500);
  }

  shareWhatsApp(link: FrequentClientActiveLink): void {
    const url = String(link?.paymentLinkUrl ?? '').trim();
    if (!url) return;
    const code = String(link?.confirmationCode ?? '').trim();
    const name = String(link?.customerName ?? '').trim();
    const tableLine = link.tableIds.length
      ? (link.tableIds.length > 1 ? `Tables ${link.tableIds.join(', ')}` : `Table ${link.tableIds[0]}`)
      : '';
    const message = [
      name ? `Hola ${name},` : 'Hola,',
      `Aquí está tu enlace de pago para Famoso Fuego${code ? ` (Reserva #FF-${code})` : ''}:`,
      tableLine ? `• ${tableLine}` : '',
      `• Fecha: ${link.eventDate}`,
      '',
      url,
    ]
      .filter((line) => line !== '')
      .join('\n');
    const phone = String(link?.phone ?? '').replace(/\D/g, '');
    const waUrl = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(waUrl, '_blank', 'noopener');
  }

  private wallClockInTz(date: Date, tz: string): string {
    // Format `date` as YYYY-MM-DDTHH:mm:ss in `tz`. Returns "" if Intl
    // rejects the tz (caller falls back to America/Chicago).
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      const parts: Record<string, string> = {};
      for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
      if (!parts['year']) return '';
      const hr = parts['hour'] === '24' ? '00' : parts['hour'];
      return `${parts['year']}-${parts['month']}-${parts['day']}T${hr}:${parts['minute']}:${parts['second']}`;
    } catch {
      return '';
    }
  }

  private deadlineForPreset(
    link: FrequentClientActiveLink,
    preset: 'event-night' | 'plus-24h' | 'custom'
  ): { paymentDeadlineAt: string; paymentDeadlineTz: string } | null {
    const tz = String(link?.paymentDeadlineTz ?? '').trim() || 'America/Chicago';
    if (preset === 'event-night') {
      return { paymentDeadlineAt: `${link.eventDate}T22:00:00`, paymentDeadlineTz: tz };
    }
    if (preset === 'plus-24h') {
      const target = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const iso = this.wallClockInTz(target, tz) || this.wallClockInTz(target, 'America/Chicago');
      if (!iso) return null;
      return { paymentDeadlineAt: iso, paymentDeadlineTz: tz };
    }
    // custom: take HTML5 datetime-local "YYYY-MM-DDTHH:mm" and add :00 seconds
    const raw = String(this.customDeadline.value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return null;
    return { paymentDeadlineAt: `${raw}:00`, paymentDeadlineTz: tz };
  }

  extendDeadline(
    link: FrequentClientActiveLink,
    preset: 'event-night' | 'plus-24h' | 'custom'
  ): void {
    const body = this.deadlineForPreset(link, preset);
    if (!body) {
      this.linksError.set('Pick a valid date and time before saving');
      return;
    }
    const reservationId = link.reservationId;
    this.linksError.set(null);
    this.setRowMutating(reservationId, true);
    this.reservationsApi
      .extendPaymentDeadline({
        reservationId,
        eventDate: link.eventDate,
        paymentDeadlineAt: body.paymentDeadlineAt,
        paymentDeadlineTz: body.paymentDeadlineTz,
      })
      .subscribe({
        next: () => {
          this.expandedExtendId.set(null);
          const targetId = this.linksTarget()?.clientId;
          if (targetId) this.loadActiveLinks(targetId);
          this.setRowMutating(reservationId, false);
        },
        error: (err) => {
          this.linksError.set(
            err?.error?.message || err?.message || 'Failed to extend deadline'
          );
          this.setRowMutating(reservationId, false);
        },
      });
  }

  regenerateLink(link: FrequentClientActiveLink): void {
    const reservationId = link.reservationId;
    const remaining = Math.max(0, Number(link.amountDue) - Number(link.depositAmount));
    if (remaining <= 0) {
      this.linksError.set('Nothing to charge — reservation is fully paid');
      return;
    }
    this.linksError.set(null);
    this.setRowMutating(reservationId, true);
    this.reservationsApi
      .createSquarePaymentLink({
        reservationId,
        eventDate: link.eventDate,
        amount: remaining,
        note: '',
        idempotencyKey: `freq:regen:${reservationId}:${Date.now()}`,
      })
      .subscribe({
        next: () => {
          const targetId = this.linksTarget()?.clientId;
          if (targetId) this.loadActiveLinks(targetId);
          this.setRowMutating(reservationId, false);
        },
        error: (err) => {
          this.linksError.set(
            err?.error?.message || err?.message || 'Failed to generate link'
          );
          this.setRowMutating(reservationId, false);
        },
      });
  }

  // Deep-link to the staff Reservations page with the detail modal
  // auto-opened on this row. From there staff uses the existing Change
  // Tables flow (Overview tab → "Change Tables") to add a table, swap a
  // table, or downgrade — that path already collects the delta, deactivates
  // the old payment link, and re-issues the pass. Reservations page reads
  // ?date= + ?open= via ActivatedRoute on init.
  manageReservation(link: FrequentClientActiveLink): void {
    if (!link?.eventDate || !link?.reservationId) return;
    this.closeLinks();
    this.router.navigate(['/staff/reservations'], {
      queryParams: { date: link.eventDate, open: link.reservationId },
    });
  }

  tableLabelFor(link: FrequentClientActiveLink): string {
    if (!link?.tableIds?.length) return '';
    if (link.tableIds.length === 1) return `Table ${link.tableIds[0]}`;
    return `Tables ${link.tableIds.join(', ')}`;
  }

  trackByLinkId(_: number, item: FrequentClientActiveLink): string {
    return item.reservationId;
  }

  toggleCreateForm(): void {
    this.showCreateForm.update((v) => !v);
  }

  toggleSection(section: string): void {
    this.activeSection.set(section);
  }

  toggleCreateTable(id: string): void {
    const current = this.createSelectedTables();
    if (current.has(id)) {
      const next = new Set(current);
      next.delete(id);
      this.createSelectedTables.set(next);
      this.createTableSettings.update((settings) => {
        const { [id]: _omit, ...rest } = settings;
        return rest;
      });
    } else {
      const next = new Set(current);
      next.add(id);
      this.createSelectedTables.set(next);
      this.ensureCreateSetting(id);
    }
    this.form.controls.defaultTableIds.setValue(
      Array.from(this.createSelectedTables()).join(', '),
    );
  }

  toggleEditTable(id: string): void {
    const current = this.editSelectedTables();
    if (current.has(id)) {
      const next = new Set(current);
      next.delete(id);
      this.editSelectedTables.set(next);
      this.editTableSettings.update((settings) => {
        const { [id]: _omit, ...rest } = settings;
        return rest;
      });
      const idx = this.findEditSettingIndex(id);
      if (idx >= 0) this.editSettings.removeAt(idx);
    } else {
      const next = new Set(current);
      next.add(id);
      this.editSelectedTables.set(next);
      this.ensureEditSetting(id);
      const setting = this.editTableSettings()[id];
      if (setting) {
        const group = this.buildSettingGroup(setting);
        group.controls['paymentStatus'].valueChanges
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe((status) => {
          const groupCurrent = group.getRawValue() as FrequentClientTableSetting;
          const nextSetting = this.applyRules({
            ...groupCurrent,
            paymentStatus: status as PaymentStatus,
          });
          group.patchValue(
            {
              amountDue: nextSetting.amountDue,
              amountPaid: nextSetting.amountPaid ?? 0,
              paymentDeadlineTime: nextSetting.paymentDeadlineTime ?? this.defaultDeadlineTime(),
              paymentDeadlineTz: nextSetting.paymentDeadlineTz ?? this.defaultDeadlineTz(),
            },
            { emitEvent: false }
          );
        });
        this.editSettings.push(group);
      }
    }
    this.editForm.controls.defaultTableIds.setValue(
      Array.from(this.editSelectedTables()).join(', '),
    );
  }

  isCreateSelected(id: string): boolean {
    return this.createSelectedTables().has(id);
  }

  isEditSelected(id: string): boolean {
    return this.editSelectedTables().has(id);
  }

  removeCreateTable(id: string): void {
    this.createSelectedTables.update((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    this.createTableSettings.update((settings) => {
      const { [id]: _omit, ...rest } = settings;
      return rest;
    });
    this.form.controls.defaultTableIds.setValue(
      Array.from(this.createSelectedTables()).join(', '),
    );
  }

  removeEditTable(id: string): void {
    this.editSelectedTables.update((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    this.editTableSettings.update((settings) => {
      const { [id]: _omit, ...rest } = settings;
      return rest;
    });
    const idx = this.findEditSettingIndex(id);
    if (idx >= 0) this.editSettings.removeAt(idx);
    this.editForm.controls.defaultTableIds.setValue(
      Array.from(this.editSelectedTables()).join(', '),
    );
  }

  formatTables(item: FrequentClient): string {
    const list = this.normalizeTableList(item.defaultTableIds ?? item.defaultTableId);
    return list.join(', ');
  }

  private normalizeTableList(value: string[] | string | undefined): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map((v) => String(v).trim().toUpperCase())
        .filter(Boolean);
    }
    return value
      .split(',')
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean);
  }

  toNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  readonly createSelectedList = computed(() =>
    Array.from(this.createSelectedTables()).sort(),
  );
  readonly editSelectedList = computed(() =>
    Array.from(this.editSelectedTables()).sort(),
  );

  getTableInfo(id: string): TableInfo | undefined {
    return this.tableInfoById()[id];
  }

  getCreateSetting(tableId: string): FrequentClientTableSetting {
    this.ensureCreateSetting(tableId);
    return this.createTableSettings()[tableId];
  }

  getEditSetting(tableId: string): FrequentClientTableSetting {
    this.ensureEditSetting(tableId);
    return this.editTableSettings()[tableId];
  }

  updateCreateSetting(tableId: string, patch: Partial<FrequentClientTableSetting>): void {
    this.createTableSettings.update((current) => {
      const existing = current[tableId] ?? this.buildDefaultSetting(tableId);
      return { ...current, [tableId]: this.applyRules({ ...existing, ...patch }) };
    });
  }

  updateEditSetting(tableId: string, patch: Partial<FrequentClientTableSetting>): void {
    this.editTableSettings.update((current) => {
      const existing = current[tableId] ?? this.buildDefaultSetting(tableId);
      return { ...current, [tableId]: this.applyRules({ ...existing, ...patch }) };
    });
  }

  private ensureCreateSetting(tableId: string): void {
    if (this.createTableSettings()[tableId]) return;
    this.createTableSettings.update((current) => ({
      ...current,
      [tableId]: this.buildDefaultSetting(tableId),
    }));
  }

  private ensureEditSetting(tableId: string): void {
    if (this.editTableSettings()[tableId]) return;
    this.editTableSettings.update((current) => ({
      ...current,
      [tableId]: this.buildDefaultSetting(tableId),
    }));
  }

  private buildSettingGroup(setting: FrequentClientTableSetting): FormGroup {
    return new FormGroup({
      tableId: new FormControl(setting.tableId, { nonNullable: true }),
      paymentStatus: new FormControl(setting.paymentStatus, { nonNullable: true }),
      amountDue: new FormControl(setting.amountDue, { nonNullable: true }),
      amountPaid: new FormControl(setting.amountPaid ?? 0, { nonNullable: true }),
      paymentDeadlineTime: new FormControl(setting.paymentDeadlineTime ?? this.defaultDeadlineTime(), {
        nonNullable: true,
      }),
      paymentDeadlineTz: new FormControl(setting.paymentDeadlineTz ?? this.defaultDeadlineTz(), {
        nonNullable: true,
      }),
    });
  }

  private findEditSettingIndex(tableId: string): number {
    const normalized = String(tableId ?? '').trim().toUpperCase();
    return this.editSettings.controls.findIndex(
      (group) => group.controls['tableId'].value === normalized
    );
  }

  editTableIdAt(index: number): string {
    return this.editSettings.at(index)?.controls['tableId'].value ?? '';
  }

  editStatusAt(index: number): PaymentStatus {
    return this.editSettings.at(index)?.controls['paymentStatus'].value ?? 'PENDING';
  }

  isEditCourtesy(index: number): boolean {
    return this.editStatusAt(index) === 'COURTESY';
  }

  isEditPendingOrPartial(index: number): boolean {
    const status = this.editStatusAt(index);
    return status === 'PENDING' || status === 'PARTIAL';
  }

  private buildDefaultSetting(tableId: string): FrequentClientTableSetting {
    const normalized = String(tableId ?? '').trim().toUpperCase();
    const amountDue = this.tablePriceById()[normalized] ?? 0;
    return {
      tableId: normalized,
      paymentStatus: 'PENDING',
      amountDue,
      amountPaid: 0,
      paymentDeadlineTime: this.defaultDeadlineTime(),
      paymentDeadlineTz: this.defaultDeadlineTz(),
    };
  }

  private normalizeSetting(
    setting: FrequentClientTableSetting
  ): FrequentClientTableSetting {
    const tableId = String(setting.tableId ?? '').trim().toUpperCase();
    const amountDue = Number(setting.amountDue ?? this.tablePriceById()[tableId] ?? 0);
    const base: FrequentClientTableSetting = {
      tableId,
      paymentStatus: (setting.paymentStatus ?? 'PENDING') as PaymentStatus,
      amountDue,
      amountPaid: setting.amountPaid ?? 0,
      paymentDeadlineTime: setting.paymentDeadlineTime ?? this.defaultDeadlineTime(),
      paymentDeadlineTz: setting.paymentDeadlineTz ?? this.defaultDeadlineTz(),
    };
    return this.applyRules(base);
  }

  private applyRules(setting: FrequentClientTableSetting): FrequentClientTableSetting {
    const next = { ...setting };
    if (next.paymentStatus === 'COURTESY') {
      next.amountDue = 0;
      next.amountPaid = 0;
      return next;
    }
    if (next.amountDue < 0 || Number.isNaN(next.amountDue)) {
      next.amountDue = 0;
    }
    if (next.paymentStatus === 'PAID') {
      next.amountPaid = next.amountDue;
      return next;
    }
    if (next.paymentStatus === 'PENDING') {
      next.amountPaid = 0;
      if (!next.paymentDeadlineTime) next.paymentDeadlineTime = this.defaultDeadlineTime();
      next.paymentDeadlineTz = this.defaultDeadlineTz();
      return next;
    }
    if (next.paymentStatus === 'PARTIAL') {
      const paid = Number(next.amountPaid ?? 0);
      next.amountPaid = Number.isFinite(paid) ? Math.max(0, paid) : 0;
      if (!next.paymentDeadlineTime) next.paymentDeadlineTime = this.defaultDeadlineTime();
      next.paymentDeadlineTz = this.defaultDeadlineTz();
      return next;
    }
    return next;
  }

  private serializeSettings(
    selected: Set<string>,
    settings: Record<string, FrequentClientTableSetting>
  ): FrequentClientTableSetting[] {
    return Array.from(selected)
      .map((tableId) => settings[tableId])
      .filter(Boolean)
      .map((setting) => ({
        tableId: setting.tableId,
        paymentStatus: setting.paymentStatus,
        amountDue: Number(setting.amountDue ?? 0),
        amountPaid:
          setting.paymentStatus === 'PAID'
            ? Number(setting.amountDue ?? 0)
            : setting.paymentStatus === 'COURTESY'
              ? 0
              : Number(setting.amountPaid ?? 0),
        paymentDeadlineTime:
          setting.paymentStatus === 'PENDING' || setting.paymentStatus === 'PARTIAL'
            ? setting.paymentDeadlineTime ?? this.defaultDeadlineTime()
            : undefined,
        paymentDeadlineTz:
          setting.paymentStatus === 'PENDING' || setting.paymentStatus === 'PARTIAL'
            ? setting.paymentDeadlineTz ?? this.defaultDeadlineTz()
            : undefined,
      }));
  }
}
