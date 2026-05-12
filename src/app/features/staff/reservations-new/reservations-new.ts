import {
  AfterViewInit,
  Component,
  DestroyRef,
  DoCheck,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TablesService } from '../../../core/http/tables.service';
import { HoldLockItem, HoldsService } from '../../../core/http/holds.service';
import { ReservationsService } from '../../../core/http/reservations.service';
import { TableForEvent } from '../../../shared/models/table.model';
import { EventItem } from '../../../shared/models/event.model';
import { ClientsService, RescheduleCredit } from '../../../core/http/clients.service';
import { CrmClient } from '../../../shared/models/client.model';
import { debounceTime, distinctUntilChanged, interval, of, Subscription, switchMap } from 'rxjs';
import { EventsService } from '../../../core/http/events.service';
import {
  formatEventDate as formatEventDateUtil,
  formatHm,
  isFutureDeadline,
  isThisWeek as isThisWeekUtil,
  nextDate,
  normalizeDeadlineLocalIso,
  normalizeHour,
  normalizeMinute,
  normalizePhone,
  normalizePollingSeconds,
  normalizeSectionMapColors,
  nowInTimeZoneLocalIso,
  phonesMatch,
  todayString,
} from './reservations-new-utils';
import {
  ActiveHoldEntry,
  ActiveHoldSession,
  clearActiveHoldSessionStorage,
  findActiveHoldLock,
  findActiveHoldLocks,
  readActiveHoldSession,
  writeActiveHoldSession,
} from './reservations-new-active-hold';
import {
  applyTableFilters,
  formatSectionFilterLabel,
  formatStatusFilterLabel,
  readSavedFilters,
  TableFilterStatus,
  writeSavedFilters,
} from './reservations-new-filters';
import {
  computeCreditAppliedAmount,
  computeCreditRemainingAmount,
  findCreditById,
  formatCreditLabel,
  sumCreditsRemaining,
} from './reservations-new-credits';
import {
  buildShareMessage,
  CreatedReservationContext,
  formatTablesLabel as formatBookingTablesLabel,
  toCreatePaymentMethod,
  toLinkMode,
  toSmsRecipient,
  toWhatsAppRecipient,
  writeClipboard,
} from './reservations-new-confirm';
import {
  inferPhoneCountryFromE164,
  normalizePhoneCountry,
  normalizePhoneToE164,
} from '../../../shared/phone';
import { PhoneDisplayPipe } from '../../../shared/phone-display.pipe';
import { TableMap } from '../../../shared/components/table-map/table-map';

@Component({
  selector: 'app-reservations-new',
  imports: [CommonModule, ReactiveFormsModule, PhoneDisplayPipe, TableMap],
  templateUrl: './reservations-new.html',
  styleUrl: './reservations-new.scss',
})
export class ReservationsNew implements OnInit, OnDestroy, DoCheck, AfterViewInit {
  private readonly sidebarModalLockClass = 'reservations-new-modal-open';
  private readonly workspaceLockClass = 'reservations-new-workspace-lock';
  private sidebarModalLockActive = false;
  private workspaceLockActive = false;
  private activeHoldSession: ActiveHoldSession | null = null;
  private holdRestoreInFlight = false;
  private visualViewportRef: VisualViewport | null = null;
  private readonly onVisualViewportChanged = () => {
    this.scheduleDesktopSplitLayout();
    this.syncWorkspaceScrollLock();
  };
  private route = inject(ActivatedRoute);
  private eventsApi = inject(EventsService);
  private tablesApi = inject(TablesService);
  private holdsApi = inject(HoldsService);
  private reservationsApi = inject(ReservationsService);
  private clientsApi = inject(ClientsService);
  private destroyRef = inject(DestroyRef);
  private ngZone = inject(NgZone);
  @ViewChild('desktopSplitPanel') desktopSplitPanel?: ElementRef<HTMLElement>;
  @ViewChild('compactMapShell') compactMapShell?: ElementRef<HTMLElement>;
  @ViewChild('compactListShell') compactListShell?: ElementRef<HTMLElement>;
  @ViewChild('mobileCtaBar') mobileCtaBar?: ElementRef<HTMLElement>;

  eventDate: string | null = null;
  event: EventItem | null = null;
  events: EventItem[] = [];
  eventsLoading = false;
  eventsError: string | null = null;
  showPastModal = false;
  tables: TableForEvent[] = [];
  loading = false;
  error: string | null = null;

  selectedTable: TableForEvent | null = null;
  selectedTableId: string | null = null;
  holdId: string | null = null;
  holdExpiresAt: number | null = null;
  holdCountdown = 0;
  private holdTimer: ReturnType<typeof setInterval> | null = null;
  holdCreatedByMe = false;
  showReleaseConfirm = false;
  // Multi-table booking state. selectedTables stays in 1:1 alignment with
  // holdEntries (same length, same order); the scalars above mirror the
  // first element for back-compat with existing template bindings + the
  // hold-countdown timer (which is keyed off the primary hold).
  selectedTables: TableForEvent[] = [];
  holdEntries: ActiveHoldEntry[] = [];
  // True after the staff clicks "+ Add another table" in the modal. The
  // next AVAILABLE-table click in the map gets appended to the booking
  // instead of replacing the selection. The flag is consumed on click
  // and reset.
  addAnotherTablePending = false;
  addAnotherTableError: string | null = null;
  // Max tables enforced server-side too; keep this in sync with
  // MAX_TABLES_PER_RESERVATION in services-reservations-shared.mjs.
  readonly maxTablesPerBooking = 10;
  private pollSub: Subscription | null = null;
  showReservationModal = false;
  sections: string[] = [];
  allowCustomDeposit = false;
  paymentDeadlineEnabled = false;
  paymentDeadlineDate = new FormControl('', { nonNullable: true });
  paymentDeadlineTime = new FormControl('00:00', { nonNullable: true });
  paymentDeadlineTz = 'America/Chicago';
  businessDate = todayString();
  tablePollingSeconds = 10;
  defaultPaymentDeadlineHour = 0;
  defaultPaymentDeadlineMinute = 0;
  tableSectionColors: Record<string, string> = {
    A: '#ec008c',
    B: '#2e3192',
    C: '#00aeef',
    D: '#f7941d',
    E: '#711411',
  };
  readonly paymentMethodOptions: Array<{ value: 'cash' | 'square' | 'client'; label: string }> = [
    { value: 'square', label: 'Square' },
    { value: 'client', label: 'Cash App' },
    { value: 'cash', label: 'Cash' },
  ];

  form = new FormGroup({
    customerName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    depositAmount: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    amountDue: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    paymentStatus: new FormControl<'PAID' | 'PARTIAL' | 'PENDING' | 'COURTESY'>('PAID', {
      nonNullable: true,
    }),
    paymentMethod: new FormControl<'cash' | 'square' | 'client'>('square', {
      nonNullable: true,
    }),
    useCredit: new FormControl(false, { nonNullable: true }),
    creditId: new FormControl('', { nonNullable: true }),
    remainingMethod: new FormControl<'cash' | 'square' | 'client'>('cash', {
      nonNullable: true,
    }),
  });

  filterQuery = new FormControl('', { nonNullable: true });
  filterStatus = new FormControl<TableFilterStatus>('ALL', {
    nonNullable: true,
  });
  filterSection = new FormControl<string>('ALL', { nonNullable: true });
  tableViewMode = new FormControl<'MAP' | 'LIST'>('MAP', { nonNullable: true });
  showFiltersPanel = false;
  phoneCountry: 'US' | 'MX' = 'US';
  pastFilterDate = new FormControl('', { nonNullable: true });
  pastFilterName = new FormControl('', { nonNullable: true });
  clientMatches: CrmClient[] = [];
  clientLoading = false;
  noClientMatch = false;
  exactMatchPhone: string | null = null;
  clientCredits: RescheduleCredit[] = [];
  clientCreditsLoading = false;
  clientCreditsError: string | null = null;
  private creditsLookupKey: string | null = null;
  private creditsLookupSeq = 0;
  creatingPaymentLink = false;
  paymentLinkError: string | null = null;
  paymentLinkNotice: string | null = null;
  paymentLinkUrl: string | null = null;
  createdReservation: CreatedReservationContext | null = null;
  desktopSplitHeightPx: number | null = null;
  compactBottomInsetPx = 96;
  compactPanelHeightPx: number | null = null;
  compactSectionBottomPaddingPx: number | null = null;
  private desktopLayoutRafId: number | null = null;

  ngOnInit(): void {
    this.restoreSavedFilters();
    this.activeHoldSession = readActiveHoldSession();
    this.loadRuntimeContext();
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        this.eventDate = params.get('date');
        if (this.eventDate) {
          this.loadTables(this.eventDate);
          this.startPolling();
          return;
        }
        if (this.activeHoldSession?.eventDate) {
          this.selectEvent(this.activeHoldSession.eventDate);
        }
      });
    this.loadEvents();

    this.form.controls.amountDue.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => {
        const status = this.form.controls.paymentStatus.value;
        const method = this.form.controls.paymentMethod.value;
        if (method !== 'cash') return;
        if (status === 'PAID') {
          this.form.controls.depositAmount.setValue(value, { emitEvent: false });
        }
        if (status === 'COURTESY') {
          this.form.controls.amountDue.setValue(0, { emitEvent: false });
          this.form.controls.depositAmount.setValue(0, { emitEvent: false });
        }
      });

    this.form.controls.paymentMethod.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.onPaymentMethodChange();
      });
    this.form.controls.useCredit.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.onUseClientCreditChanged();
      });
    this.form.controls.creditId.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.onClientCreditChanged();
      });
    this.form.controls.remainingMethod.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.onClientCreditRemainingMethodChanged();
      });
    this.form.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.saveActiveHoldSessionIfNeeded();
      });

    this.form.controls.phone.valueChanges
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((value) => {
          const digits = normalizePhone(value);
          if (digits.length < 4) {
            this.clientMatches = [];
            this.noClientMatch = false;
            this.exactMatchPhone = null;
            this.clearClientCreditsState();
            return of([]);
          }
          this.clientLoading = true;
          return this.clientsApi.searchByPhone(digits);
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: (items: CrmClient[]) => {
          const matches = items ?? [];
          const entered = normalizePhone(this.form.controls.phone.value);
          const exact = matches.find(
            (m) => phonesMatch(m.phone, entered) && entered.length >= 10
          );
          this.exactMatchPhone = exact ? normalizePhone(exact.phone) : null;
          this.clientMatches = matches;
          this.noClientMatch = entered.length >= 10 && matches.length === 0;
          this.clientLoading = false;
          if (exact) {
            this.form.controls.customerName.setValue(exact.name || '');
            this.form.controls.phone.setValue(exact.phone || entered);
            this.phoneCountry = inferPhoneCountryFromE164(exact.phone) ?? this.phoneCountry;
            this.clientMatches = [];
            this.noClientMatch = false;
          }
          this.refreshClientCreditsForCurrentPhone();
        },
        error: () => {
          this.clientMatches = [];
          this.noClientMatch = false;
          this.exactMatchPhone = null;
          this.clientLoading = false;
          this.refreshClientCreditsForCurrentPhone();
        },
      });

    // Mirror search-by-phone but for the customer name input. Catches the
    // typo'd-phone case (PR #X / Julio Torres incident): staff who knows the
    // name can pick the existing CRM record from the dropdown instead of
    // typing a wrong phone number.
    this.form.controls.customerName.valueChanges
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((value) => {
          const q = String(value ?? '').trim();
          // Only search once the user has typed enough to be meaningful, and
          // skip the search if a non-empty phone is also being typed (the
          // phone search is already firing for that case).
          const phoneDigits = normalizePhone(this.form.controls.phone.value);
          if (q.length < 2 || phoneDigits.length >= 4) {
            return of(null);
          }
          this.clientLoading = true;
          return this.clientsApi.searchByName(q);
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: (items: CrmClient[] | null) => {
          if (items === null) return; // skipped — leave existing matches alone
          const matches = items ?? [];
          this.clientMatches = matches;
          this.noClientMatch =
            matches.length === 0 &&
            String(this.form.controls.customerName.value ?? '').trim().length >= 2;
          this.clientLoading = false;
          this.exactMatchPhone = null;
        },
        error: () => {
          this.clientMatches = [];
          this.noClientMatch = false;
          this.clientLoading = false;
        },
      });
  }

  ngAfterViewInit(): void {
    this.attachVisualViewportListeners();
    this.scheduleDesktopSplitLayout();
  }

  ngOnDestroy(): void {
    this.syncSidebarModalLock(true);
    this.syncWorkspaceScrollLock(true);
    this.detachVisualViewportListeners();
    this.stopPolling();
    this.clearHoldTimer();
    if (this.desktopLayoutRafId !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.desktopLayoutRafId);
      this.desktopLayoutRafId = null;
    }
  }

  ngDoCheck(): void {
    this.syncSidebarModalLock();
    this.syncWorkspaceScrollLock();
    if (this.eventDate || this.desktopSplitHeightPx !== null || this.compactPanelHeightPx !== null) {
      this.scheduleDesktopSplitLayout();
    }
  }

  loadTables(date: string, opts: { silent?: boolean } = {}): void {
    const silent = opts.silent === true;
    if (!silent) {
      this.loading = true;
      this.error = null;
    }
    this.tablesApi.getForEvent(date).subscribe({
      next: (res) => {
        this.event = res.event;
        // Most polls return identical tables. Reassigning this.tables forces
        // TableMap's ngOnChanges to fire — which re-parses + serializes the
        // 193KB SVG. Keep the same array reference when nothing changed so
        // the map skips the re-render entirely.
        if (!this.isSameTablesShape(this.tables, res.tables)) {
          this.tables = res.tables;
        }
        this.sections = Array.from(new Set(res.tables.map((t) => t.section))).sort();
        if (this.filterSection.value !== 'ALL' && !this.sections.includes(this.filterSection.value)) {
          this.filterSection.setValue('ALL');
          this.saveFilters();
        }
        if (this.selectedTableId) {
          this.selectedTable = this.tables.find((t) => t.id === this.selectedTableId) ?? null;
        } else {
          this.selectedTable = null;
        }
        this.tryRestoreActiveHoldSession();
        if (!silent) this.loading = false;
        this.scheduleDesktopSplitLayout();
      },
      error: (err) => {
        if (!silent) {
          this.error = err?.error?.message || err?.message || 'Failed to load tables';
          this.loading = false;
        }
      },
    });
  }

  private isSameTablesShape(a: TableForEvent[], b: TableForEvent[]): boolean {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i];
      const y = b[i];
      if (x.id !== y.id) return false;
      if (x.status !== y.status) return false;
      if (x.disabled !== y.disabled) return false;
      if (x.price !== y.price) return false;
      if (x.section !== y.section) return false;
    }
    return true;
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollSub = interval(this.tablePollingSeconds * 1000).subscribe(() => {
      if (!this.eventDate) return;
      if (this.showReservationModal) return;
      // Skip ticks while the tab is hidden — staff isn't watching the
      // table availability map. Resumes on next tick once the tab is
      // visible again.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      this.loadTables(this.eventDate, { silent: true });
    });
  }

  private stopPolling(): void {
    if (this.pollSub) {
      this.pollSub.unsubscribe();
      this.pollSub = null;
    }
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
      },
      error: (err) => {
        this.eventsError = err?.error?.message || err?.message || 'Failed to load events';
        this.eventsLoading = false;
      },
    });
  }

  selectEvent(date: string): void {
    this.eventDate = date;
    this.showPastModal = false;
    this.loadTables(date);
    this.startPolling();
  }

  clearEventSelection(): void {
    this.clearActiveHoldSession();
    this.eventDate = null;
    this.event = null;
    this.tables = [];
    this.selectedTable = null;
    this.selectedTableId = null;
    this.selectedTables = [];
    this.holdEntries = [];
    this.holdId = null;
    this.holdExpiresAt = null;
    this.holdCountdown = 0;
    this.clearHoldTimer();
    this.addAnotherTablePending = false;
    this.addAnotherTableError = null;
    this.showPastModal = false;
    this.showReservationModal = false;
    this.showFiltersPanel = false;
    this.stopPolling();
    this.desktopSplitHeightPx = null;
    this.compactPanelHeightPx = null;
    this.compactSectionBottomPaddingPx = null;
  }

  upcomingEvents(): EventItem[] {
    return this.events
      .filter((e) => (e.eventDate || '') >= this.businessDate)
      .slice(0, 4);
  }

  pastEvents(): EventItem[] {
    const dateFilter = this.pastFilterDate.value.trim();
    const nameFilter = this.pastFilterName.value.trim().toLowerCase();
    return this.events
      .filter((e) => (e.eventDate || '') < this.businessDate)
      .filter((e) => (dateFilter ? e.eventDate === dateFilter : true))
      .filter((e) =>
        nameFilter ? (e.eventName || '').toLowerCase().includes(nameFilter) : true
      )
      .reverse();
  }

  // Template-bound helpers: keep on `this` so the .html bindings can find
  // them. Implementation lives in reservations-new-utils.ts.
  isThisWeek = isThisWeekUtil;
  formatEventDate = formatEventDateUtil;

  selectTable(t: TableForEvent): void {
    if (t.status !== 'AVAILABLE') return;
    // Multi-table "Add another" path: the staff clicked "+ Add another
    // table" in the modal, then a free table on the map. Append it to
    // the booking instead of replacing the selection. Releases the flag
    // either way (consume-on-click).
    if (this.addAnotherTablePending && this.holdId && this.eventDate) {
      this.addAnotherTablePending = false;
      if (this.selectedTables.some((existing) => existing.id === t.id)) return;
      this.addAnotherTable(t);
      return;
    }
    this.addAnotherTablePending = false;
    this.addAnotherTableError = null;
    this.clearActiveHoldSession();
    this.selectedTable = t;
    this.selectedTableId = t.id;
    this.selectedTables = [t];
    this.holdEntries = [];
    this.resetCreatedReservationState();
    this.holdId = null;
    this.holdExpiresAt = null;
    this.holdCountdown = 0;
    this.clearHoldTimer();
    this.holdCreatedByMe = false;
    this.showReleaseConfirm = false;
    this.allowCustomDeposit = false;
    const price = t.price ?? 0;
    this.form.controls.amountDue.setValue(price);
    this.applyPaymentDefaultsForCurrentMethod();
  }

  // "Add another table" toggle in the modal. Sets a one-shot pending
  // flag — the staff's next AVAILABLE-table click on the map appends
  // instead of replacing.
  beginAddAnotherTable(): void {
    if (!this.holdId || !this.eventDate) return;
    if (this.selectedTables.length >= this.maxTablesPerBooking) {
      this.addAnotherTableError = `Maximum ${this.maxTablesPerBooking} tables per booking.`;
      return;
    }
    this.addAnotherTableError = null;
    this.addAnotherTablePending = true;
    // Closing the modal makes the map reachable; staff picks the next
    // table from the same view they used to pick the primary.
    this.showReservationModal = false;
    this.saveActiveHoldSessionIfNeeded();
  }

  cancelAddAnotherTable(): void {
    this.addAnotherTablePending = false;
    this.addAnotherTableError = null;
  }

  // Creates a hold for an additional table and appends it to the
  // booking. Reopens the reservation modal on success so the staff can
  // confirm the multi-table booking.
  addAnotherTable(t: TableForEvent): void {
    if (!this.eventDate) return;
    if (this.selectedTables.some((existing) => existing.id === t.id)) return;
    if (this.selectedTables.length >= this.maxTablesPerBooking) {
      this.addAnotherTableError = `Maximum ${this.maxTablesPerBooking} tables per booking.`;
      this.showReservationModal = true;
      return;
    }
    this.loading = true;
    this.error = null;
    this.addAnotherTableError = null;
    const phone = normalizePhoneToE164(
      this.form.controls.phone.value,
      normalizePhoneCountry(this.phoneCountry)
    );
    this.holdsApi
      .createHold({
        eventDate: this.eventDate,
        tableId: t.id,
        customerName: this.form.controls.customerName.value,
        phone: phone || undefined,
        phoneCountry: this.phoneCountry,
      })
      .subscribe({
        next: (item) => {
          this.selectedTables = [...this.selectedTables, t];
          this.holdEntries = [
            ...this.holdEntries,
            {
              tableId: t.id,
              holdId: item.holdId,
              holdExpiresAt: item.expiresAt ?? null,
              holdCreatedByMe: true,
            },
          ];
          // Reflect the added table's per-unit cost into amountDue if
          // the staff hasn't manually overridden it. The form's `amountDue`
          // starts as the primary table's price; we top it up by the new
          // table's price so the default deposit math stays correct.
          const extraPrice = Number(t.price ?? 0);
          if (Number.isFinite(extraPrice) && extraPrice > 0) {
            const next = Number(
              (Number(this.form.controls.amountDue.value ?? 0) + extraPrice).toFixed(2)
            );
            this.form.controls.amountDue.setValue(next);
            this.applyPaymentDefaultsForCurrentMethod();
          }
          this.showReservationModal = true;
          this.saveActiveHoldSessionIfNeeded();
          this.loadTables(this.eventDate!);
          this.loading = false;
        },
        error: (err) => {
          this.addAnotherTableError =
            err?.error?.message ||
            err?.message ||
            `Failed to hold table ${t.id}`;
          this.showReservationModal = true;
          this.loading = false;
        },
      });
  }

  // Removes one table from a multi-table booking, releasing its hold.
  // Cannot remove the last remaining table — use "Close" / release-all
  // for that.
  removeSelectedTable(tableId: string): void {
    if (!this.eventDate) return;
    if (this.selectedTables.length <= 1) return;
    const entry = this.holdEntries.find((h) => h.tableId === tableId);
    if (!entry) return;
    this.loading = true;
    this.holdsApi.releaseHold(this.eventDate, tableId).subscribe({
      next: () => {
        this.selectedTables = this.selectedTables.filter((t) => t.id !== tableId);
        this.holdEntries = this.holdEntries.filter((h) => h.tableId !== tableId);
        // Rebalance amountDue: deduct the removed table's price.
        const removed = entry && this.tables.find((t) => t.id === tableId);
        const extraPrice = Number(removed?.price ?? 0);
        if (Number.isFinite(extraPrice) && extraPrice > 0) {
          const next = Math.max(
            0,
            Number(
              (Number(this.form.controls.amountDue.value ?? 0) - extraPrice).toFixed(2)
            )
          );
          this.form.controls.amountDue.setValue(next);
          this.applyPaymentDefaultsForCurrentMethod();
        }
        this.saveActiveHoldSessionIfNeeded();
        this.loadTables(this.eventDate!);
        this.loading = false;
      },
      error: (err) => {
        this.addAnotherTableError =
          err?.error?.message ||
          err?.message ||
          `Failed to release hold on table ${tableId}`;
        this.loading = false;
      },
    });
  }

  bookingTablesLabel(): string {
    const ids = this.selectedTables.map((t) => t.id).filter(Boolean);
    return formatBookingTablesLabel(ids);
  }

  hasMultipleTables(): boolean {
    return this.selectedTables.length > 1;
  }

  startHoldFlow(): void {
    if (!this.eventDate || !this.selectedTable) return;
    this.holdCreatedByMe = true;
    this.createHold(true);
  }

  createHold(openModal = false): void {
    if (!this.eventDate || !this.selectedTable) return;
    const phone = normalizePhoneToE164(
      this.form.controls.phone.value,
      normalizePhoneCountry(this.phoneCountry)
    );
    this.loading = true;
    this.error = null;
    const primaryTable = this.selectedTable;
    this.holdsApi
      .createHold({
        eventDate: this.eventDate,
        tableId: primaryTable.id,
        customerName: this.form.controls.customerName.value,
        phone: phone || undefined,
        phoneCountry: this.phoneCountry,
      })
      .subscribe({
        next: (item) => {
          this.holdId = item.holdId;
          this.holdExpiresAt = item.expiresAt ?? null;
          this.holdCreatedByMe = true;
          // Sync the multi-table mirrors. createHold owns the primary
          // entry; addAnotherTable owns subsequent entries.
          this.selectedTables = [primaryTable];
          this.holdEntries = [
            {
              tableId: primaryTable.id,
              holdId: item.holdId,
              holdExpiresAt: item.expiresAt ?? null,
              holdCreatedByMe: true,
            },
          ];
          this.startHoldTimer();
          this.saveActiveHoldSessionIfNeeded();
          this.loading = false;
          this.loadTables(this.eventDate!);
          if (openModal) this.openReservationModal();
        },
        error: (err) => {
          this.error = err?.error?.message || err?.message || 'Failed to hold table';
          this.loading = false;
        },
      });
  }

  releaseHold(): void {
    if (!this.eventDate) return;
    const eventDate = this.eventDate;
    const entries =
      this.holdEntries.length > 0
        ? this.holdEntries
        : this.selectedTable
        ? [
            {
              tableId: this.selectedTable.id,
              holdId: this.holdId ?? '',
              holdExpiresAt: this.holdExpiresAt,
              holdCreatedByMe: this.holdCreatedByMe,
            } as ActiveHoldEntry,
          ]
        : [];
    if (entries.length === 0) return;
    this.loading = true;
    this.error = null;
    // Release every hold in parallel. Individual releaseHold rejections
    // (e.g. the lock was already swept) shouldn't block clearing local
    // state — the cron sweeps stale rows independently. We log a single
    // best-effort error if any failed.
    Promise.allSettled(
      entries.map(
        (entry) =>
          new Promise<void>((resolve, reject) => {
            this.holdsApi.releaseHold(eventDate, entry.tableId).subscribe({
              next: () => resolve(),
              error: (err) => reject(err),
            });
          })
      )
    ).then((results) => {
      const failed = results.find((r) => r.status === 'rejected');
      this.selectedTables = [];
      this.holdEntries = [];
      this.holdId = null;
      this.holdExpiresAt = null;
      this.holdCountdown = 0;
      this.clearHoldTimer();
      this.holdCreatedByMe = false;
      this.showReleaseConfirm = false;
      this.showReservationModal = false;
      this.clearActiveHoldSession();
      this.loadTables(eventDate);
      this.loading = false;
      if (failed && failed.status === 'rejected') {
        const reason = (failed as PromiseRejectedResult).reason;
        this.error =
          reason?.error?.message ||
          reason?.message ||
          'Failed to release one or more holds';
      }
    });
  }

  confirmReservation(): void {
    if (this.createdReservation) {
      this.finishReservationFlow();
      return;
    }
    if (!this.eventDate || !this.selectedTable) {
      this.error = 'Select an event and table first.';
      return;
    }
    if (!this.holdId) {
      this.error = 'Hold expired or missing. Please hold the table again.';
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error = this.formErrorMessage();
      return;
    }
    this.loading = true;
    this.error = null;
    const depositAmount = this.form.controls.depositAmount.value;
    const amountDue = this.form.controls.amountDue.value;
    const paymentStatus = this.form.controls.paymentStatus.value;
    const paymentMethod = this.form.controls.paymentMethod.value;
    const usingCredit = this.isUsingClientCredit();
    const selectedCredit = usingCredit ? this.selectedClientCredit() : null;
    const creditAppliedAmount = usingCredit ? this.clientCreditAppliedAmount() : 0;
    const creditRemainingAmount = usingCredit ? this.clientCreditRemainingAmount() : 0;
    const remainingMethod = this.form.controls.remainingMethod.value;
    const phone = normalizePhoneToE164(
      this.form.controls.phone.value,
      normalizePhoneCountry(this.phoneCountry)
    );
    if (!phone) {
      this.error = 'Phone must be a valid US or MX number.';
      this.loading = false;
      return;
    }
    if (usingCredit && !selectedCredit) {
      this.error = 'Select a reservation credit to apply.';
      this.loading = false;
      return;
    }
    if (usingCredit && creditAppliedAmount <= 0) {
      this.error = 'Selected credit cannot be applied to this reservation.';
      this.loading = false;
      return;
    }

    const createPaymentStatus = usingCredit ? 'PENDING' : paymentStatus;
    const createPaymentMethod = usingCredit
      ? null
      : toCreatePaymentMethod(paymentMethod);
    const createDepositAmount = usingCredit ? 0 : depositAmount;
    const needsDeadline = usingCredit
      ? this.creditNeedsDeadline()
      : paymentStatus === 'PENDING' || paymentStatus === 'PARTIAL';
    if (needsDeadline && !this.paymentDeadlineEnabled) {
      this.error = 'Payment deadline is required for unpaid or partial reservations.';
      this.loading = false;
      return;
    }
    let paymentDeadlineAt: string | null = null;
    if (needsDeadline) {
      const date = this.paymentDeadlineDate.value;
      const time = this.paymentDeadlineTime.value || '00:00';
      if (!date) {
        this.error = 'Payment deadline date is required.';
        this.loading = false;
        return;
      }
      paymentDeadlineAt = `${date}T${time}:00`;
      if (!isFutureDeadline(paymentDeadlineAt, this.paymentDeadlineTz)) {
        this.error = 'Payment deadline must be in the future.';
        this.loading = false;
        return;
      }
    }
    // Build the multi-table arrays from the live selection. When the
    // booking is single-table these collapse to length-1 arrays and the
    // backend handles them identically. The scalars below stay for back-
    // compat with the old singular branch.
    const bookingTableIds =
      this.selectedTables.length > 0
        ? this.selectedTables.map((t) => t.id)
        : [this.selectedTable.id];
    const bookingHoldIds =
      this.holdEntries.length > 0
        ? this.holdEntries.map((h) => h.holdId)
        : [this.holdId];
    if (bookingTableIds.length !== bookingHoldIds.length) {
      this.error = 'Selected tables and holds are out of sync. Refresh and try again.';
      this.loading = false;
      return;
    }
    this.reservationsApi
      .create({
        eventDate: this.eventDate,
        tableId: bookingTableIds[0],
        holdId: bookingHoldIds[0]!,
        tableIds: bookingTableIds,
        holdIds: bookingHoldIds.map((h) => String(h ?? '')),
        customerName: this.form.controls.customerName.value,
        phone,
        phoneCountry: this.phoneCountry,
        depositAmount: createDepositAmount,
        amountDue,
        paymentStatus: createPaymentStatus,
        paymentMethod: createPaymentMethod,
        paymentDeadlineAt,
        paymentDeadlineTz: needsDeadline ? this.paymentDeadlineTz : null,
      })
      .subscribe({
        next: (created) => {
          const createdItem = created?.item;
          const autoSquareLinkSms = created?.autoSquareLinkSms;
          const reservationId = String(createdItem?.reservationId ?? '');
          this.holdId = null;
          this.holdExpiresAt = null;
          this.holdCountdown = 0;
          this.clearHoldTimer();
          this.holdCreatedByMe = false;
          this.showReleaseConfirm = false;
          // Holds have been promoted to RESERVED in the same TransactWrite
          // as the reservation row; clearing the local hold map keeps the
          // UI from showing a stale "release" action.
          this.holdEntries = [];
          this.addAnotherTablePending = false;
          this.addAnotherTableError = null;
          this.clearActiveHoldSession();
          this.loadTables(this.eventDate!);

          if (!reservationId) {
            this.error = 'Reservation created but reservation id was missing.';
            this.loading = false;
            return;
          }

          if (usingCredit) {
            this.createdReservation = {
              reservationId,
              eventDate: this.eventDate!,
              tableId: bookingTableIds[0],
              tableIds: bookingTableIds,
              customerName: this.form.controls.customerName.value,
              phone,
              amount: creditRemainingAmount > 0 ? creditRemainingAmount : amountDue,
              linkMode: creditRemainingAmount > 0 ? toLinkMode(remainingMethod) : null,
            };

            this.reservationsApi
              .addPayment({
                reservationId,
                eventDate: this.eventDate!,
                amount: creditAppliedAmount,
                method: 'credit',
                creditId: selectedCredit?.creditId,
                note: 'Applied reservation credit',
              })
              .subscribe({
                next: () => {
                  if (creditRemainingAmount > 0) {
                    if (remainingMethod === 'square' || remainingMethod === 'client') {
                      this.loading = false;
                      this.generatePaymentLinkForCurrentFlow();
                      return;
                    }

                    this.reservationsApi
                      .addPayment({
                        reservationId,
                        eventDate: this.eventDate!,
                        amount: creditRemainingAmount,
                        method: remainingMethod,
                        note: 'Remaining balance after credit',
                      })
                      .subscribe({
                        next: () => {
                          this.loading = false;
                          this.finishReservationFlow();
                        },
                        error: (err) => {
                          this.error =
                            err?.error?.message ||
                            err?.message ||
                            `Credit applied, but remaining payment failed. Reservation ID: ${reservationId}`;
                          this.loading = false;
                        },
                      });
                    return;
                  }

                  this.loading = false;
                  this.finishReservationFlow();
                },
                error: (err) => {
                  this.error =
                    err?.error?.message ||
                    err?.message ||
                    `Reservation created, but credit apply failed. Reservation ID: ${reservationId}`;
                  this.loading = false;
                },
              });
            return;
          }

          if (paymentMethod === 'square') {
            if (autoSquareLinkSms?.sent) {
              this.loading = false;
              this.finishReservationFlow();
              return;
            }
            this.createdReservation = {
              reservationId,
              eventDate: this.eventDate!,
              tableId: bookingTableIds[0],
              tableIds: bookingTableIds,
              customerName: this.form.controls.customerName.value,
              phone,
              amount: amountDue,
              linkMode: 'square',
            };
            this.loading = false;
            this.generatePaymentLinkForCurrentFlow();
            return;
          }

          if (paymentMethod === 'client') {
            if (autoSquareLinkSms?.sent) {
              this.loading = false;
              this.finishReservationFlow();
              return;
            }
            this.createdReservation = {
              reservationId,
              eventDate: this.eventDate!,
              tableId: bookingTableIds[0],
              tableIds: bookingTableIds,
              customerName: this.form.controls.customerName.value,
              phone,
              amount: amountDue,
              linkMode: 'client',
            };
            this.loading = false;
            this.generatePaymentLinkForCurrentFlow();
            return;
          }

          this.loading = false;
          this.finishReservationFlow();
        },
        error: (err) => {
          this.error =
            err?.error?.message || err?.message || 'Failed to confirm reservation';
          this.loading = false;
        },
      });
  }

  openReservationModal(): void {
    if (!this.selectedTable) return;
    this.resetCreatedReservationState();
    this.showReservationModal = true;
    this.saveActiveHoldSessionIfNeeded();
  }

  closeReservationModal(): void {
    if (this.createdReservation) {
      this.finishReservationFlow();
      return;
    }
    if (this.holdId && this.holdCreatedByMe) {
      this.showReleaseConfirm = true;
      this.saveActiveHoldSessionIfNeeded();
      return;
    }
    this.showReservationModal = false;
    this.saveActiveHoldSessionIfNeeded();
  }

  cancelReleasePrompt(): void {
    this.showReleaseConfirm = false;
  }

  private startHoldTimer(): void {
    this.clearHoldTimer();
    if (!this.holdExpiresAt) return;
    // First tick goes through Angular so the initial countdown renders.
    const now = Math.floor(Date.now() / 1000);
    this.holdCountdown = Math.max(0, this.holdExpiresAt - now);
    // Subsequent ticks run OUTSIDE Angular's NgZone so the 1Hz tick doesn't
    // trigger a global change-detection cycle every second — that CD storm
    // (combined with ngDoCheck's layout reads) blocked the main thread enough
    // to freeze iOS Chrome when the native share sheet opened on top.
    // Re-enter the zone only when the displayed second actually changes.
    this.ngZone.runOutsideAngular(() => {
      this.holdTimer = setInterval(() => {
        const next = Math.floor(Date.now() / 1000);
        const newCountdown = Math.max(0, this.holdExpiresAt! - next);
        if (newCountdown === this.holdCountdown) return;
        this.ngZone.run(() => {
          this.holdCountdown = newCountdown;
          if (this.holdCountdown <= 0) {
            this.clearHoldTimer();
            this.clearActiveHoldSession();
          }
        });
      }, 1000);
    });
  }

  private clearHoldTimer(): void {
    if (this.holdTimer) {
      clearInterval(this.holdTimer);
      this.holdTimer = null;
    }
  }

  get holdCountdownLabel(): string {
    const total = this.holdCountdown || 0;
    const min = Math.floor(total / 60);
    const sec = String(total % 60).padStart(2, '0');
    return `${min}:${sec}`;
  }

  selectClient(client: CrmClient): void {
    if (!client) return;
    this.form.controls.phone.setValue(client.phone || '');
    this.form.controls.customerName.setValue(client.name || '');
    this.phoneCountry = inferPhoneCountryFromE164(client.phone) ?? this.phoneCountry;
    this.clientMatches = [];
    this.noClientMatch = false;
    this.exactMatchPhone = normalizePhone(client.phone);
    this.refreshClientCreditsForCurrentPhone(true);
  }

  onPhoneCountryChanged(value: string): void {
    const normalized = normalizePhoneCountry(value);
    if (this.phoneCountry === normalized) return;
    this.phoneCountry = normalized;
    this.refreshClientCreditsForCurrentPhone(true);
    this.saveActiveHoldSessionIfNeeded();
  }

  clientCreditsTotalRemaining(): number {
    return sumCreditsRemaining(this.clientCredits);
  }

  clientCreditLabel(credit: RescheduleCredit): string {
    return formatCreditLabel(credit);
  }

  isUsingClientCredit(): boolean {
    return this.form.controls.useCredit.value && this.clientCredits.length > 0;
  }

  onUseClientCreditChanged(): void {
    if (!this.form.controls.useCredit.value) {
      this.form.controls.creditId.setValue('', { emitEvent: false });
      this.form.controls.remainingMethod.setValue('cash', { emitEvent: false });
      return;
    }
    if (this.clientCredits.length === 1) {
      this.form.controls.creditId.setValue(this.clientCredits[0].creditId, { emitEvent: false });
    }
    if (!this.form.controls.creditId.value && this.clientCredits.length > 1) {
      this.form.controls.creditId.setValue(this.clientCredits[0].creditId, { emitEvent: false });
    }
    this.onClientCreditChanged();
  }

  onClientCreditChanged(): void {
    if (!this.isUsingClientCredit()) return;
    const selected = this.selectedClientCredit();
    if (!selected) return;
    if (this.clientCreditRemainingAmount() <= 0) {
      this.form.controls.remainingMethod.setValue('cash', { emitEvent: false });
    }
    this.onClientCreditRemainingMethodChanged();
  }

  onClientCreditRemainingMethodChanged(): void {
    if (!this.isUsingClientCredit()) return;
    if (this.creditNeedsDeadline()) {
      this.paymentDeadlineEnabled = true;
      this.setDefaultPaymentDeadline();
      return;
    }
    this.paymentDeadlineEnabled = false;
  }

  selectedClientCredit(): RescheduleCredit | null {
    return findCreditById(this.clientCredits, this.form.controls.creditId.value ?? '');
  }

  clientCreditAppliedAmount(): number {
    if (!this.isUsingClientCredit()) return 0;
    return computeCreditAppliedAmount(
      this.selectedClientCredit(),
      this.form.controls.amountDue.value
    );
  }

  clientCreditRemainingAmount(): number {
    if (!this.isUsingClientCredit()) {
      return Number(Math.max(0, this.form.controls.amountDue.value).toFixed(2));
    }
    return computeCreditRemainingAmount(
      this.form.controls.amountDue.value,
      this.clientCreditAppliedAmount()
    );
  }

  shouldShowCreditRemainingMethod(): boolean {
    return this.isUsingClientCredit() && this.clientCreditRemainingAmount() > 0;
  }

  creditNeedsDeadline(): boolean {
    return (
      this.isUsingClientCredit() &&
      this.clientCreditRemainingAmount() > 0 &&
      this.form.controls.remainingMethod.value !== 'cash'
    );
  }

  toggleCustomDeposit(): void {
    this.allowCustomDeposit = !this.allowCustomDeposit;
    if (!this.allowCustomDeposit && this.selectedTable) {
      const price = this.selectedTable.price ?? 0;
      this.form.controls.amountDue.setValue(price);
      this.form.controls.depositAmount.setValue(price);
    }
  }

  onPaymentStatusChange(): void {
    if (this.form.controls.paymentMethod.value !== 'cash') {
      this.form.controls.paymentStatus.setValue('PENDING');
      this.form.controls.depositAmount.setValue(0);
      this.allowCustomDeposit = false;
      this.paymentDeadlineEnabled = true;
      this.setDefaultPaymentDeadline();
      return;
    }

    const status = this.form.controls.paymentStatus.value;
    const amountDue = this.form.controls.amountDue.value;
    if (status === 'COURTESY') {
      this.form.controls.amountDue.setValue(0);
      this.form.controls.depositAmount.setValue(0);
      this.allowCustomDeposit = false;
      this.paymentDeadlineEnabled = false;
      return;
    }
    if (status === 'PAID') {
      this.form.controls.depositAmount.setValue(amountDue);
      this.allowCustomDeposit = false;
      this.paymentDeadlineEnabled = false;
      return;
    }
    if (status === 'PENDING') {
      this.form.controls.depositAmount.setValue(0);
      this.allowCustomDeposit = false;
      this.paymentDeadlineEnabled = true;
      this.setDefaultPaymentDeadline();
      return;
    }
    // PARTIAL: leave deposit editable
    this.allowCustomDeposit = true;
    this.paymentDeadlineEnabled = true;
    this.setDefaultPaymentDeadline();
  }

  isExactMatch(client: CrmClient): boolean {
    if (!client) return false;
    const phone = normalizePhone(client.phone);
    return !!this.exactMatchPhone && phone === this.exactMatchPhone;
  }

  private setDefaultPaymentDeadline(): void {
    if (!this.eventDate) return;
    this.paymentDeadlineDate.setValue(nextDate(this.eventDate));
    this.paymentDeadlineTime.setValue(
      formatHm(this.defaultPaymentDeadlineHour, this.defaultPaymentDeadlineMinute)
    );
  }

  private formErrorMessage(): string {
    const customerName = this.form.controls.customerName;
    if (customerName.invalid) return 'Customer name is required.';

    const phone = this.form.controls.phone;
    if (phone.invalid) return 'Phone is required.';

    const amountDue = this.form.controls.amountDue;
    if (amountDue.invalid) return 'Total amount due must be 0 or greater.';

    const deposit = this.form.controls.depositAmount;
    if (deposit.invalid) return 'Deposit amount must be 0 or greater.';

    const method = this.form.controls.paymentMethod;
    if (method.invalid) return 'Payment method is required.';

    return 'Please review the reservation details.';
  }

  onPaymentMethodChange(): void {
    this.applyPaymentDefaultsForCurrentMethod();
  }

  trackByPaymentMethodOption(
    _index: number,
    item: { value: 'cash' | 'square' | 'client' }
  ): string {
    return item.value;
  }

  isPaymentMethod(value: 'cash' | 'square' | 'client'): boolean {
    return this.form.controls.paymentMethod.value === value;
  }

  onPaymentMethodButtonClick(event: Event, value: 'cash' | 'square' | 'client'): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.form.controls.paymentMethod.value === value) return;
    this.form.controls.paymentMethod.setValue(value);
    this.form.controls.paymentMethod.markAsDirty();
  }

  isCashMethod(): boolean {
    return this.form.controls.paymentMethod.value === 'cash';
  }

  isSquareMethod(): boolean {
    return this.form.controls.paymentMethod.value === 'square';
  }

  isClientPayMethod(): boolean {
    return this.form.controls.paymentMethod.value === 'client';
  }

  isLinkCollectionFlow(): boolean {
    if (this.isUsingClientCredit() && this.shouldShowCreditRemainingMethod()) {
      const remainingMethod = this.form.controls.remainingMethod.value;
      return remainingMethod === 'square' || remainingMethod === 'client';
    }
    return this.isSquareMethod() || this.isClientPayMethod();
  }

  private currentLinkModeFromForm(): 'square' | 'client' | null {
    if (this.isUsingClientCredit() && this.shouldShowCreditRemainingMethod()) {
      const remainingMethod = this.form.controls.remainingMethod.value;
      return remainingMethod === 'square' || remainingMethod === 'client'
        ? remainingMethod
        : null;
    }
    const method = this.form.controls.paymentMethod.value;
    return method === 'square' || method === 'client' ? method : null;
  }

  private currentLinkMode(): 'square' | 'client' | null {
    return this.createdReservation?.linkMode ?? this.currentLinkModeFromForm();
  }

  generatePaymentLinkForCurrentFlow(): void {
    if (!this.createdReservation) return;
    const linkMode = this.currentLinkMode();
    if (!linkMode) return;
    if (this.creatingPaymentLink) return;

    this.creatingPaymentLink = true;
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;

    if (linkMode === 'client') {
      this.reservationsApi
        .createCashAppLink({
          reservationId: this.createdReservation.reservationId,
          eventDate: this.createdReservation.eventDate,
          amount: this.createdReservation.amount,
        })
        .subscribe({
          next: (res) => {
            const url = String(res?.cashAppLink?.url ?? '').trim();
            if (!url) {
              this.paymentLinkError =
                'Cash App link generation succeeded but no URL was returned.';
              this.creatingPaymentLink = false;
              return;
            }
            this.paymentLinkUrl = url;
            this.paymentLinkNotice = 'Cash App link generated. Share it with the customer.';
            this.creatingPaymentLink = false;
          },
          error: (err: any) => {
            this.paymentLinkError =
              err?.error?.message || err?.message || 'Failed to generate Cash App link';
            this.creatingPaymentLink = false;
          },
        });
      return;
    }

    this.reservationsApi
      .createSquarePaymentLink({
        reservationId: this.createdReservation.reservationId,
        eventDate: this.createdReservation.eventDate,
        amount: this.createdReservation.amount,
        note: `Square link for ${
          formatBookingTablesLabel(this.createdReservation.tableIds) ||
          `table ${this.createdReservation.tableId}`
        }`,
      })
      .subscribe({
        next: (res) => {
          const url = String(res?.square?.url ?? '').trim();
          if (!url) {
            this.paymentLinkError = 'Square link generation succeeded but no URL was returned.';
            this.creatingPaymentLink = false;
            return;
          }
          this.paymentLinkUrl = url;
          this.paymentLinkNotice = 'Square link generated. Share it with the customer.';
          this.creatingPaymentLink = false;
        },
        error: (err: any) => {
          this.paymentLinkError =
            err?.error?.message || err?.message || 'Failed to generate Square link';
          this.creatingPaymentLink = false;
        },
      });
  }

  copyGeneratedPaymentLink(): void {
    const url = String(this.paymentLinkUrl ?? '').trim();
    if (!url) return;
    writeClipboard(url).then((ok) => {
      this.paymentLinkNotice = ok
        ? 'Link copied.'
        : 'Copy failed. Please copy manually.';
    });
  }

  openSmsShareGenerated(): void {
    if (!this.createdReservation || !this.paymentLinkUrl) return;
    const body = buildShareMessage(this.createdReservation, this.paymentLinkUrl);
    const recipient = toSmsRecipient(this.createdReservation.phone);
    const target = recipient ? `sms:${recipient}?&body=${encodeURIComponent(body)}` : `sms:?&body=${encodeURIComponent(body)}`;
    window.open(target, '_blank');
  }

  openWhatsAppShareGenerated(): void {
    if (!this.createdReservation || !this.paymentLinkUrl) return;
    const body = buildShareMessage(this.createdReservation, this.paymentLinkUrl);
    const recipient = toWhatsAppRecipient(this.createdReservation.phone);
    const target = recipient
      ? `https://wa.me/${recipient}?text=${encodeURIComponent(body)}`
      : `https://wa.me/?text=${encodeURIComponent(body)}`;
    window.open(target, '_blank');
  }

  shareGeneratedPaymentLink(): void {
    if (!this.createdReservation || !this.paymentLinkUrl) return;
    const body = buildShareMessage(this.createdReservation, this.paymentLinkUrl);
    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator
        .share({
          text: body,
          url: this.paymentLinkUrl,
        })
        .catch(() => {
          this.copyGeneratedPaymentLink();
        });
      return;
    }
    this.copyGeneratedPaymentLink();
  }

  generatedLinkShareMessage(): string {
    if (!this.createdReservation || !this.paymentLinkUrl) return '';
    return buildShareMessage(this.createdReservation, this.paymentLinkUrl);
  }

  linkCollectionTitle(): string {
    const mode = this.currentLinkMode();
    return mode === 'client' ? 'Cash App Link' : 'Square Link';
  }

  reservationActionLabel(): string {
    if (this.createdReservation) return 'Done';
    if (this.isLinkCollectionFlow()) {
      return this.currentLinkModeFromForm() === 'client'
        ? 'Confirm & Generate Cash App Link'
        : 'Confirm & Generate Square Link';
    }
    return 'Confirm Reservation';
  }

  reservationActionDisabled(): boolean {
    if (this.createdReservation) return this.loading || this.creatingPaymentLink;
    if (
      this.isUsingClientCredit() &&
      (!this.selectedClientCredit() || this.clientCreditAppliedAmount() <= 0)
    ) {
      return true;
    }
    return this.loading;
  }

  filteredTables(): TableForEvent[] {
    return applyTableFilters(
      this.tables,
      this.filterQuery.value,
      this.filterStatus.value,
      this.filterSection.value
    );
  }

  setTableViewMode(mode: 'MAP' | 'LIST'): void {
    this.tableViewMode.setValue(mode);
    if (mode === 'MAP') {
      this.showFiltersPanel = false;
    }
    this.scheduleDesktopSplitLayout();
  }

  isTableViewMode(mode: 'MAP' | 'LIST'): boolean {
    return this.tableViewMode.value === mode;
  }

  setFilterStatus(status: TableFilterStatus): void {
    this.filterStatus.setValue(status);
    this.showFiltersPanel = false;
    this.saveFilters();
  }

  setFilterSection(section: string): void {
    this.filterSection.setValue(section);
    this.showFiltersPanel = false;
    this.saveFilters();
  }

  toggleFiltersPanel(): void {
    this.showFiltersPanel = !this.showFiltersPanel;
    this.scheduleDesktopSplitLayout();
  }

  clearFilters(): void {
    this.filterStatus.setValue('ALL');
    this.filterSection.setValue('ALL');
    this.showFiltersPanel = false;
    this.saveFilters();
  }

  hasActiveFilters(): boolean {
    return this.filterStatus.value !== 'ALL' || this.filterSection.value !== 'ALL';
  }

  statusFilterLabel(): string {
    return formatStatusFilterLabel(this.filterStatus.value);
  }

  sectionFilterLabel(): string {
    return formatSectionFilterLabel(this.filterSection.value);
  }

  filtersButtonLabel(): string {
    const count = this.activeFiltersCount();
    return count > 0 ? `Filters (${count})` : 'Filters';
  }

  activeFiltersCount(): number {
    let count = 0;
    if (this.filterStatus.value !== 'ALL') count += 1;
    if (this.filterSection.value !== 'ALL') count += 1;
    return count;
  }

  private saveFilters(): void {
    writeSavedFilters({
      status: this.filterStatus.value,
      section: this.filterSection.value,
    });
  }

  private restoreSavedFilters(): void {
    const saved = readSavedFilters();
    if (!saved) return;
    if (saved.status) this.filterStatus.setValue(saved.status);
    if (saved.section) this.filterSection.setValue(saved.section);
  }

  private applyPaymentDefaultsForCurrentMethod(): void {
    const method = this.form.controls.paymentMethod.value;
    const amountDue = this.form.controls.amountDue.value;

    if (method === 'cash') {
      if (this.form.controls.paymentStatus.value === 'PENDING' || this.form.controls.paymentStatus.value === 'PARTIAL') {
        this.paymentDeadlineEnabled = true;
        this.setDefaultPaymentDeadline();
      } else {
        this.paymentDeadlineEnabled = false;
      }
      this.onPaymentStatusChange();
      return;
    }

    this.form.controls.paymentStatus.setValue('PENDING', { emitEvent: false });
    this.form.controls.depositAmount.setValue(0, { emitEvent: false });
    this.allowCustomDeposit = false;
    this.paymentDeadlineEnabled = true;
    this.setDefaultPaymentDeadline();

    if (!Number.isFinite(amountDue) || amountDue < 0) {
      this.form.controls.amountDue.setValue(this.selectedTable?.price ?? 0, { emitEvent: false });
    }
  }

  private resetCreatedReservationState(): void {
    this.createdReservation = null;
    this.paymentLinkUrl = null;
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;
    this.creatingPaymentLink = false;
  }

  finishReservationFlow(): void {
    this.clearActiveHoldSession();
    this.resetCreatedReservationState();
    this.selectedTable = null;
    this.selectedTableId = null;
    this.selectedTables = [];
    this.holdEntries = [];
    this.addAnotherTablePending = false;
    this.addAnotherTableError = null;
    this.allowCustomDeposit = false;
    this.paymentDeadlineEnabled = false;
    this.showReservationModal = false;
    this.form.reset({
      customerName: '',
      phone: '',
      depositAmount: 0,
      amountDue: 0,
      paymentStatus: 'PAID',
      paymentMethod: 'square',
      useCredit: false,
      creditId: '',
      remainingMethod: 'cash',
    });
    this.phoneCountry = 'US';
    this.clearClientCreditsState();
  }

  private clearClientCreditsState(): void {
    this.clientCredits = [];
    this.clientCreditsLoading = false;
    this.clientCreditsError = null;
    this.creditsLookupKey = null;
    this.form.controls.useCredit.setValue(false, { emitEvent: false });
    this.form.controls.creditId.setValue('', { emitEvent: false });
    this.form.controls.remainingMethod.setValue('cash', { emitEvent: false });
  }

  private refreshClientCreditsForCurrentPhone(force = false): void {
    const country = normalizePhoneCountry(this.phoneCountry);
    const phone = normalizePhoneToE164(this.form.controls.phone.value, country);
    if (!phone) {
      this.clearClientCreditsState();
      return;
    }

    const lookupKey = `${country}:${phone}`;
    if (!force && this.creditsLookupKey === lookupKey) return;

    this.creditsLookupKey = lookupKey;
    this.clientCreditsLoading = true;
    this.clientCreditsError = null;
    this.clientCredits = [];
    const seq = ++this.creditsLookupSeq;

    this.clientsApi.listRescheduleCredits(phone, country).subscribe({
      next: (items) => {
        if (seq !== this.creditsLookupSeq) return;
        const currentSelectedCreditId = String(this.form.controls.creditId.value ?? '').trim();
        this.clientCredits = (items ?? []).filter((credit) => {
          const status = String(credit.status ?? '').trim().toUpperCase();
          return status === 'ACTIVE' && Number(credit.amountRemaining ?? 0) > 0;
        });
        if (!this.clientCredits.length) {
          this.form.controls.useCredit.setValue(false, { emitEvent: false });
          this.form.controls.creditId.setValue('', { emitEvent: false });
          this.form.controls.remainingMethod.setValue('cash', { emitEvent: false });
        } else if (currentSelectedCreditId) {
          const stillExists = this.clientCredits.some(
            (credit) => credit.creditId === currentSelectedCreditId
          );
          if (!stillExists) {
            this.form.controls.creditId.setValue('', { emitEvent: false });
          }
        }
        if (
          this.form.controls.useCredit.value &&
          !this.form.controls.creditId.value &&
          this.clientCredits.length > 0
        ) {
          this.form.controls.creditId.setValue(this.clientCredits[0].creditId, { emitEvent: false });
        }
        this.clientCreditsLoading = false;
      },
      error: (err) => {
        if (seq !== this.creditsLookupSeq) return;
        this.clientCredits = [];
        this.clientCreditsLoading = false;
        this.creditsLookupKey = null;
        this.clientCreditsError =
          err?.error?.message || err?.message || 'Failed to load client credits';
      },
    });
  }

  tableCounts(): {
    total: number;
    available: number;
    hold: number;
    pendingPayment: number;
    reserved: number;
    disabled: number;
  } {
    const counts = {
      total: this.tables.length,
      available: 0,
      hold: 0,
      pendingPayment: 0,
      reserved: 0,
      disabled: 0,
    };
    for (const t of this.tables) {
      if (t.status === 'AVAILABLE') counts.available += 1;
      if (t.status === 'HOLD') counts.hold += 1;
      if (t.status === 'PENDING_PAYMENT') counts.pendingPayment += 1;
      if (t.status === 'RESERVED') counts.reserved += 1;
      if (t.status === 'DISABLED') counts.disabled += 1;
    }
    return counts;
  }

  private syncSidebarModalLock(forceUnlock = false): void {
    if (typeof document === 'undefined') return;

    const shouldLock = !forceUnlock && (
      this.showPastModal ||
      this.showReservationModal ||
      this.showReleaseConfirm
    );

    if (shouldLock === this.sidebarModalLockActive) return;

    document.body.classList.toggle(this.sidebarModalLockClass, shouldLock);
    this.sidebarModalLockActive = shouldLock;
  }

  private syncWorkspaceScrollLock(forceUnlock = false): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const shouldLock =
      !forceUnlock &&
      !!this.eventDate &&
      !this.showPastModal &&
      !this.showReservationModal &&
      !this.showReleaseConfirm;

    if (shouldLock === this.workspaceLockActive) return;

    document.body.classList.toggle(this.workspaceLockClass, shouldLock);
    document.documentElement.classList.toggle(this.workspaceLockClass, shouldLock);
    this.workspaceLockActive = shouldLock;
  }

  private attachVisualViewportListeners(): void {
    if (typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    this.visualViewportRef = viewport;
    viewport.addEventListener('resize', this.onVisualViewportChanged, { passive: true });
    viewport.addEventListener('scroll', this.onVisualViewportChanged, { passive: true });
  }

  private detachVisualViewportListeners(): void {
    const viewport = this.visualViewportRef;
    if (!viewport) return;
    viewport.removeEventListener('resize', this.onVisualViewportChanged);
    viewport.removeEventListener('scroll', this.onVisualViewportChanged);
    this.visualViewportRef = null;
  }

  private loadRuntimeContext(): void {
    this.eventsApi.getCurrentContext().subscribe({
      next: (ctx) => {
        this.businessDate = String(ctx?.businessDate ?? '').trim() || todayString();
        this.paymentDeadlineTz = String(ctx?.settings?.operatingTz ?? '').trim() || 'America/Chicago';
        this.defaultPaymentDeadlineHour = normalizeHour(
          ctx?.settings?.defaultPaymentDeadlineHour,
          0
        );
        this.defaultPaymentDeadlineMinute = normalizeMinute(
          ctx?.settings?.defaultPaymentDeadlineMinute,
          0
        );
        this.paymentDeadlineTime.setValue(formatHm(this.defaultPaymentDeadlineHour, this.defaultPaymentDeadlineMinute));
        this.tablePollingSeconds = normalizePollingSeconds(
          ctx?.settings?.tableAvailabilityPollingSeconds,
          10
        );
        this.tableSectionColors = normalizeSectionMapColors(ctx?.settings?.sectionMapColors);
        if (this.eventDate) {
          this.startPolling();
          return;
        }
        if (this.activeHoldSession?.eventDate) {
          this.selectEvent(this.activeHoldSession.eventDate);
          return;
        }
        const preferredEventDate =
          String(ctx?.event?.eventDate ?? '').trim() ||
          String(ctx?.nextEvent?.eventDate ?? '').trim();
        if (preferredEventDate) {
          this.selectEvent(preferredEventDate);
        }
      },
      error: () => {
        this.businessDate = todayString();
      },
    });
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.scheduleDesktopSplitLayout();
  }

  @HostListener('window:scroll')
  onWindowScroll(): void {
    if (this.desktopSplitHeightPx !== null || this.compactPanelHeightPx !== null) {
      this.scheduleDesktopSplitLayout();
    }
  }

  private scheduleDesktopSplitLayout(): void {
    if (typeof window === 'undefined') return;
    if (this.desktopLayoutRafId !== null) {
      window.cancelAnimationFrame(this.desktopLayoutRafId);
      this.desktopLayoutRafId = null;
    }
    this.desktopLayoutRafId = window.requestAnimationFrame(() => {
      this.desktopLayoutRafId = null;
      this.recalculateDesktopSplitHeight();
      this.recalculateCompactSplitHeight();
    });
  }

  private recalculateDesktopSplitHeight(): void {
    if (typeof window === 'undefined') return;
    const isDesktop = window.matchMedia('(min-width: 1024px)').matches;
    if (!isDesktop) {
      this.desktopSplitHeightPx = null;
      return;
    }
    const host = this.desktopSplitPanel?.nativeElement;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const viewportHeight = Math.floor(visualViewport?.height ?? window.innerHeight);
    const viewportOffsetTop = Math.floor(visualViewport?.offsetTop ?? 0);
    const bottomGapPx = 8;
    const minHeightPx = 320;
    this.desktopSplitHeightPx = Math.max(
      minHeightPx,
      Math.floor(viewportHeight + viewportOffsetTop - rect.top - bottomGapPx)
    );
  }

  private recalculateCompactSplitHeight(): void {
    if (typeof window === 'undefined') return;
    const isCompact = window.matchMedia('(max-width: 1023px)').matches;
    if (!isCompact || !this.eventDate || this.showReservationModal || this.showPastModal || this.showReleaseConfirm) {
      this.compactPanelHeightPx = null;
      this.compactSectionBottomPaddingPx = null;
      return;
    }

    const visualViewport = window.visualViewport;
    const viewportHeight = Math.floor(visualViewport?.height ?? window.innerHeight);
    const viewportOffsetTop = Math.floor(visualViewport?.offsetTop ?? 0);

    const ctaHeight = Math.ceil(
      this.mobileCtaBar?.nativeElement?.getBoundingClientRect().height ?? 72
    );
    const bottomGapPx = 8;
    this.compactBottomInsetPx = Math.max(72, ctaHeight + bottomGapPx);
    this.compactSectionBottomPaddingPx = this.compactBottomInsetPx + 12;

    const activeShell = this.isTableViewMode('MAP')
      ? this.compactMapShell?.nativeElement
      : this.compactListShell?.nativeElement;
    if (!activeShell) {
      this.compactPanelHeightPx = null;
      return;
    }

    const rect = activeShell.getBoundingClientRect();
    const minHeightPx = 240;
    const available = Math.floor(
      viewportHeight + viewportOffsetTop - rect.top - this.compactBottomInsetPx - 4
    );
    this.compactPanelHeightPx = Math.max(minHeightPx, available);
  }

  private tryRestoreActiveHoldSession(): void {
    if (!this.eventDate || this.holdId || this.holdRestoreInFlight) return;
    if (!this.activeHoldSession || this.activeHoldSession.eventDate !== this.eventDate) return;
    this.holdRestoreInFlight = true;
    const session = this.activeHoldSession;
    this.holdsApi.listLocks(this.eventDate).subscribe({
      next: (items) => {
        this.holdRestoreInFlight = false;
        // Resolve every persisted hold in one shot. Holds that expired
        // or got claimed by someone else drop out — if the primary is
        // gone we treat the whole session as dead.
        const liveHolds = findActiveHoldLocks(items, session);
        const primary = liveHolds.find((h) => h.tableId === session.tableId);
        if (!primary) {
          this.clearActiveHoldSession();
          return;
        }
        const restoredTables: TableForEvent[] = [];
        const restoredEntries: ActiveHoldEntry[] = [];
        // Preserve session order; primary first.
        for (const entry of liveHolds) {
          const t = this.tables.find((tab) => tab.id === entry.tableId);
          if (!t) continue;
          restoredTables.push(t);
          restoredEntries.push(entry);
        }
        if (restoredTables.length === 0) {
          this.clearActiveHoldSession();
          return;
        }
        this.selectedTableId = restoredTables[0].id;
        this.selectedTable = restoredTables[0];
        this.selectedTables = restoredTables;
        this.holdEntries = restoredEntries;
        this.form.patchValue(
          {
            customerName: session.customerName,
            phone: session.phone,
            amountDue: session.amountDue,
            depositAmount: session.depositAmount,
            paymentStatus: session.paymentStatus,
            paymentMethod: session.paymentMethod,
          },
          { emitEvent: false }
        );
        this.phoneCountry = normalizePhoneCountry(session.phoneCountry);
        this.allowCustomDeposit = session.allowCustomDeposit;
        this.paymentDeadlineEnabled = session.paymentDeadlineEnabled;
        this.paymentDeadlineDate.setValue(session.paymentDeadlineDate, { emitEvent: false });
        this.paymentDeadlineTime.setValue(session.paymentDeadlineTime, { emitEvent: false });
        this.holdId = primary.holdId;
        this.holdExpiresAt = primary.holdExpiresAt ?? null;
        this.holdCreatedByMe = primary.holdCreatedByMe !== false;
        this.showReservationModal = session.showReservationModal !== false;
        this.showReleaseConfirm = false;
        this.startHoldTimer();
        this.saveActiveHoldSessionIfNeeded();
      },
      error: () => {
        this.holdRestoreInFlight = false;
      },
    });
  }

  private saveActiveHoldSessionIfNeeded(): void {
    if (!this.eventDate || !this.selectedTable?.id || !this.holdId) return;
    // Persist every hold so a multi-table booking survives reload. The
    // scalar (tableId/holdId/etc.) mirrors the first entry — legacy
    // reads-without-multi still resolve a single-table session.
    const holdsForStorage: ActiveHoldEntry[] = (() => {
      if (this.holdEntries.length > 0) return this.holdEntries;
      return [
        {
          tableId: this.selectedTable.id,
          holdId: this.holdId,
          holdExpiresAt: this.holdExpiresAt ?? null,
          holdCreatedByMe: this.holdCreatedByMe,
        },
      ];
    })();
    const primary = holdsForStorage[0];
    const session: ActiveHoldSession = {
      eventDate: this.eventDate,
      tableId: primary.tableId,
      holdId: primary.holdId,
      holdExpiresAt: primary.holdExpiresAt ?? null,
      holdCreatedByMe: primary.holdCreatedByMe,
      tableIds: holdsForStorage.map((h) => h.tableId),
      holds: holdsForStorage,
      showReservationModal: this.showReservationModal,
      customerName: this.form.controls.customerName.value,
      phone: this.form.controls.phone.value,
      phoneCountry: normalizePhoneCountry(this.phoneCountry),
      amountDue: Number(this.form.controls.amountDue.value ?? 0),
      depositAmount: Number(this.form.controls.depositAmount.value ?? 0),
      paymentStatus: this.form.controls.paymentStatus.value,
      paymentMethod: this.form.controls.paymentMethod.value,
      allowCustomDeposit: this.allowCustomDeposit,
      paymentDeadlineEnabled: this.paymentDeadlineEnabled,
      paymentDeadlineDate: this.paymentDeadlineDate.value,
      paymentDeadlineTime: this.paymentDeadlineTime.value,
      savedAt: Date.now(),
    };
    this.activeHoldSession = session;
    writeActiveHoldSession(session);
  }

  private clearActiveHoldSession(): void {
    this.activeHoldSession = null;
    clearActiveHoldSessionStorage();
  }
}
