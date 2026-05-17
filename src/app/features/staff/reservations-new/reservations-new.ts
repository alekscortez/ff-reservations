import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
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
import { CashAppQrPad } from '../../../shared/components/cash-app-qr-pad/cash-app-qr-pad';
import { SquareStandHandoff } from '../../../shared/components/square-stand-handoff/square-stand-handoff';
import { HlmAlert } from '../../../shared/ui/alert';
import { HlmDialog, HlmConfirmDialog } from '../../../shared/ui/dialog';
import { HlmButton } from '../../../shared/ui/button';
import { HlmInput } from '../../../shared/ui/input';
import { HlmNativeSelect } from '../../../shared/ui/native-select';
import { HlmToggle } from '../../../shared/ui/toggle';

@Component({
  selector: 'app-reservations-new',
  imports: [CommonModule, ReactiveFormsModule, NgIcon, PhoneDisplayPipe, TableMap, CashAppQrPad, SquareStandHandoff, HlmAlert, HlmDialog, HlmConfirmDialog, HlmButton, HlmInput, HlmNativeSelect, HlmToggle],
  providers: [provideIcons({ lucideX })],
  templateUrl: './reservations-new.html',
  styleUrl: './reservations-new.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReservationsNew implements OnInit, OnDestroy, AfterViewInit {
  private readonly workspaceLockClass = 'reservations-new-workspace-lock';
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

  constructor() {
    // Replaces the previous ngDoCheck-based syncWorkspaceScrollLock +
    // scheduleDesktopSplitLayout pair. The effect tracks the signals
    // read inside syncWorkspaceScrollLock (eventDate, showPastModal,
    // showReservationModal, showReleaseConfirm) plus the two layout
    // dimensions; it re-runs only when one of those changes instead
    // of on every CD cycle.
    effect(() => {
      this.syncWorkspaceScrollLock();
      if (
        this._eventDate() ||
        this._desktopSplitHeightPx() !== null ||
        this._compactPanelHeightPx() !== null
      ) {
        this.scheduleDesktopSplitLayout();
      }
    });
  }
  @ViewChild('desktopSplitPanel') desktopSplitPanel?: ElementRef<HTMLElement>;
  @ViewChild('compactMapShell') compactMapShell?: ElementRef<HTMLElement>;
  @ViewChild('compactListShell') compactListShell?: ElementRef<HTMLElement>;
  @ViewChild('mobileCtaBar') mobileCtaBar?: ElementRef<HTMLElement>;
  @ViewChild('cashAppQrPad') cashAppQrPad?: CashAppQrPad;
  @ViewChild('cashAppResumePad') cashAppResumePad?: CashAppQrPad;

  private readonly _eventDate = signal<string | null>(null);
  get eventDate(): string | null { return this._eventDate(); }
  set eventDate(value: string | null) { this._eventDate.set(value); }
  private readonly _event = signal<EventItem | null>(null);
  get event(): EventItem | null { return this._event(); }
  set event(value: EventItem | null) { this._event.set(value); }
  private readonly _events = signal<EventItem[]>([]);
  get events(): EventItem[] { return this._events(); }
  set events(value: EventItem[]) { this._events.set(value); }
  private readonly _eventsLoading = signal(false);
  get eventsLoading(): boolean { return this._eventsLoading(); }
  set eventsLoading(value: boolean) { this._eventsLoading.set(value); }
  private readonly _eventsError = signal<string | null>(null);
  get eventsError(): string | null { return this._eventsError(); }
  set eventsError(value: string | null) { this._eventsError.set(value); }
  private readonly _showPastModal = signal(false);
  get showPastModal(): boolean { return this._showPastModal(); }
  set showPastModal(value: boolean) { this._showPastModal.set(value); }
  private readonly _tables = signal<TableForEvent[]>([]);
  get tables(): TableForEvent[] { return this._tables(); }
  set tables(value: TableForEvent[]) { this._tables.set(value); }
  private readonly _loading = signal(false);
  get loading(): boolean { return this._loading(); }
  set loading(value: boolean) { this._loading.set(value); }
  private readonly _error = signal<string | null>(null);
  get error(): string | null { return this._error(); }
  set error(value: string | null) { this._error.set(value); }

  private readonly _selectedTable = signal<TableForEvent | null>(null);
  get selectedTable(): TableForEvent | null { return this._selectedTable(); }
  set selectedTable(value: TableForEvent | null) { this._selectedTable.set(value); }
  private readonly _selectedTableId = signal<string | null>(null);
  get selectedTableId(): string | null { return this._selectedTableId(); }
  set selectedTableId(value: string | null) { this._selectedTableId.set(value); }
  private readonly _holdId = signal<string | null>(null);
  get holdId(): string | null { return this._holdId(); }
  set holdId(value: string | null) { this._holdId.set(value); }
  private readonly _holdExpiresAt = signal<number | null>(null);
  get holdExpiresAt(): number | null { return this._holdExpiresAt(); }
  set holdExpiresAt(value: number | null) { this._holdExpiresAt.set(value); }
  private readonly _holdCountdown = signal(0);
  get holdCountdown(): number { return this._holdCountdown(); }
  set holdCountdown(value: number) { this._holdCountdown.set(value); }
  // Set when the per-second timer ticks to zero. Cleared when a fresh hold
  // is created or the modal is reset. Drives the in-modal "hold expired"
  // banner and prevents confirmReservation from firing a doomed POST.
  private readonly _holdExpired = signal(false);
  get holdExpired(): boolean { return this._holdExpired(); }
  set holdExpired(value: boolean) { this._holdExpired.set(value); }
  private holdTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _holdCreatedByMe = signal(false);
  get holdCreatedByMe(): boolean { return this._holdCreatedByMe(); }
  set holdCreatedByMe(value: boolean) { this._holdCreatedByMe.set(value); }
  private readonly _showReleaseConfirm = signal(false);
  get showReleaseConfirm(): boolean { return this._showReleaseConfirm(); }
  set showReleaseConfirm(value: boolean) { this._showReleaseConfirm.set(value); }
  // Multi-table booking state. selectedTables stays in 1:1 alignment with
  // holdEntries (same length, same order); the scalars above mirror the
  // first element for back-compat with existing template bindings + the
  // hold-countdown timer (which is keyed off the primary hold).
  private readonly _selectedTables = signal<TableForEvent[]>([]);
  get selectedTables(): TableForEvent[] { return this._selectedTables(); }
  set selectedTables(value: TableForEvent[]) { this._selectedTables.set(value); }
  private readonly _holdEntries = signal<ActiveHoldEntry[]>([]);
  get holdEntries(): ActiveHoldEntry[] { return this._holdEntries(); }
  set holdEntries(value: ActiveHoldEntry[]) { this._holdEntries.set(value); }
  // True after the staff clicks "+ Add another table" in the modal. The
  // next AVAILABLE-table click in the map gets appended to the booking
  // instead of replacing the selection. The flag is consumed on click
  // and reset.
  private readonly _addAnotherTablePending = signal(false);
  get addAnotherTablePending(): boolean { return this._addAnotherTablePending(); }
  set addAnotherTablePending(value: boolean) { this._addAnotherTablePending.set(value); }
  private readonly _addAnotherTableError = signal<string | null>(null);
  get addAnotherTableError(): string | null { return this._addAnotherTableError(); }
  set addAnotherTableError(value: string | null) { this._addAnotherTableError.set(value); }
  // Max tables enforced server-side too; keep this in sync with
  // MAX_TABLES_PER_RESERVATION in services-reservations-shared.mjs.
  readonly maxTablesPerBooking = 10;
  private pollSub: Subscription | null = null;
  private readonly _showReservationModal = signal(false);
  get showReservationModal(): boolean { return this._showReservationModal(); }
  set showReservationModal(value: boolean) { this._showReservationModal.set(value); }
  private readonly _sections = signal<string[]>([]);
  get sections(): string[] { return this._sections(); }
  set sections(value: string[]) { this._sections.set(value); }
  private readonly _allowCustomDeposit = signal(false);
  get allowCustomDeposit(): boolean { return this._allowCustomDeposit(); }
  set allowCustomDeposit(value: boolean) { this._allowCustomDeposit.set(value); }
  private readonly _paymentDeadlineEnabled = signal(false);
  get paymentDeadlineEnabled(): boolean { return this._paymentDeadlineEnabled(); }
  set paymentDeadlineEnabled(value: boolean) { this._paymentDeadlineEnabled.set(value); }
  paymentDeadlineDate = new FormControl('', { nonNullable: true });
  paymentDeadlineTime = new FormControl('00:00', { nonNullable: true });
  paymentDeadlineTz = 'America/Chicago';
  private readonly _businessDate = signal<string>(todayString());
  get businessDate(): string { return this._businessDate(); }
  set businessDate(value: string) { this._businessDate.set(value); }
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
  readonly paymentMethodOptions: Array<{
    value: 'cash' | 'square' | 'cashapp' | 'square_stand';
    label: string;
  }> = [
    { value: 'square_stand', label: 'Card on Stand' },
    { value: 'square', label: 'Square link' },
    { value: 'cashapp', label: 'Cash App' },
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
    paymentMethod: new FormControl<'cash' | 'square' | 'cashapp' | 'square_stand'>(
      'square',
      { nonNullable: true },
    ),
    useCredit: new FormControl(false, { nonNullable: true }),
    creditId: new FormControl('', { nonNullable: true }),
    // remainingMethod (after-credit balance) intentionally excludes
    // 'cashapp' — that flow needs the QR pad mount, which is harder to
    // chain after the credit-apply step. Staff can still charge the
    // remainder via Cash App from /staff/reservations after creation.
    remainingMethod: new FormControl<'cash' | 'square'>('cash', {
      nonNullable: true,
    }),
    receiptNumber: new FormControl('', { nonNullable: true }),
  });
  // Mirrors the settings-driven cashReceiptNumberRequired flag used by
  // the staff Reservations page; populated in loadRuntimeContext. Defaults
  // to true to match backend's resolveCashReceiptNumberRequired() fallback.
  private readonly _cashReceiptNumberRequired = signal(true);
  get cashReceiptNumberRequired(): boolean { return this._cashReceiptNumberRequired(); }
  set cashReceiptNumberRequired(value: boolean) { this._cashReceiptNumberRequired.set(value); }
  private readonly _confirmSubmitAttempted = signal(false);
  get confirmSubmitAttempted(): boolean { return this._confirmSubmitAttempted(); }
  set confirmSubmitAttempted(value: boolean) { this._confirmSubmitAttempted.set(value); }
  // In-flight guards: prevent a rapid double-click from firing the same
  // POST twice. Backend idempotency replays the second create, but the
  // FE's `next:` callback would run twice and churn modal/hold state.
  private creatingHold = false;
  private confirmingReservation = false;

  filterQuery = new FormControl('', { nonNullable: true });
  filterStatus = new FormControl<TableFilterStatus>('ALL', {
    nonNullable: true,
  });
  filterSection = new FormControl<string>('ALL', { nonNullable: true });
  tableViewMode = new FormControl<'MAP' | 'LIST'>('MAP', { nonNullable: true });
  private readonly _showFiltersPanel = signal(false);
  get showFiltersPanel(): boolean { return this._showFiltersPanel(); }
  set showFiltersPanel(value: boolean) { this._showFiltersPanel.set(value); }
  private readonly _phoneCountry = signal<'US' | 'MX'>('US');
  get phoneCountry(): 'US' | 'MX' { return this._phoneCountry(); }
  set phoneCountry(value: 'US' | 'MX') { this._phoneCountry.set(value); }
  pastFilterDate = new FormControl('', { nonNullable: true });
  pastFilterName = new FormControl('', { nonNullable: true });

  // Filter control values exposed as signals so the cache `computed`s
  // below stay reactive without manual recompute methods. valueChanges
  // initial-value supplied so first read isn't undefined.
  private readonly filterQuerySignal = toSignal(this.filterQuery.valueChanges, {
    initialValue: this.filterQuery.value,
  });
  private readonly filterStatusSignal = toSignal(this.filterStatus.valueChanges, {
    initialValue: this.filterStatus.value,
  });
  private readonly filterSectionSignal = toSignal(this.filterSection.valueChanges, {
    initialValue: this.filterSection.value,
  });
  private readonly pastFilterDateSignal = toSignal(this.pastFilterDate.valueChanges, {
    initialValue: this.pastFilterDate.value,
  });
  private readonly pastFilterNameSignal = toSignal(this.pastFilterName.valueChanges, {
    initialValue: this.pastFilterName.value,
  });
  private readonly _clientMatches = signal<CrmClient[]>([]);
  get clientMatches(): CrmClient[] { return this._clientMatches(); }
  set clientMatches(value: CrmClient[]) { this._clientMatches.set(value); }
  private readonly _clientLoading = signal(false);
  get clientLoading(): boolean { return this._clientLoading(); }
  set clientLoading(value: boolean) { this._clientLoading.set(value); }
  private readonly _noClientMatch = signal(false);
  get noClientMatch(): boolean { return this._noClientMatch(); }
  set noClientMatch(value: boolean) { this._noClientMatch.set(value); }
  private readonly _exactMatchPhone = signal<string | null>(null);
  get exactMatchPhone(): string | null { return this._exactMatchPhone(); }
  set exactMatchPhone(value: string | null) { this._exactMatchPhone.set(value); }
  private readonly _clientCredits = signal<RescheduleCredit[]>([]);
  get clientCredits(): RescheduleCredit[] { return this._clientCredits(); }
  set clientCredits(value: RescheduleCredit[]) { this._clientCredits.set(value); }
  private readonly _clientCreditsLoading = signal(false);
  get clientCreditsLoading(): boolean { return this._clientCreditsLoading(); }
  set clientCreditsLoading(value: boolean) { this._clientCreditsLoading.set(value); }
  private readonly _clientCreditsError = signal<string | null>(null);
  get clientCreditsError(): string | null { return this._clientCreditsError(); }
  set clientCreditsError(value: string | null) { this._clientCreditsError.set(value); }
  private creditsLookupKey: string | null = null;
  private creditsLookupSeq = 0;
  // Cached derivatives of `events` / `tables` + form-control filters.
  // Implemented as `computed()` signals so they auto-recompute only
  // when one of their inputs changes. Memoization keeps the *ngFor
  // array reference stable across CD cycles — same property that the
  // previous imperative cache offered (no touchend-drop on iOS Chrome).
  // Maximum past events kept in the cache (older events reachable via
  // the date/name filters; filtered results bypass the slice).
  private readonly maxPastEventsRendered = 50;
  readonly upcomingEventsCache = computed<EventItem[]>(() =>
    this._events()
      .filter((e) => (e.eventDate || '') >= this._businessDate())
      .slice(0, 4)
  );
  readonly pastEventsCache = computed<EventItem[]>(() => {
    const dateFilter = (this.pastFilterDateSignal() ?? '').trim();
    const nameFilter = (this.pastFilterNameSignal() ?? '').trim().toLowerCase();
    const hasFilters = Boolean(dateFilter || nameFilter);
    const filtered = this._events()
      .filter((e) => (e.eventDate || '') < this._businessDate())
      .filter((e) => (dateFilter ? e.eventDate === dateFilter : true))
      .filter((e) =>
        nameFilter ? (e.eventName || '').toLowerCase().includes(nameFilter) : true
      )
      .reverse();
    return hasFilters ? filtered : filtered.slice(0, this.maxPastEventsRendered);
  });
  readonly filteredTablesCache = computed<TableForEvent[]>(() =>
    applyTableFilters(
      this._tables(),
      this.filterQuerySignal() ?? '',
      (this.filterStatusSignal() ?? 'ALL') as TableFilterStatus,
      this.filterSectionSignal() ?? 'ALL'
    )
  );
  private readonly _creatingPaymentLink = signal(false);
  get creatingPaymentLink(): boolean { return this._creatingPaymentLink(); }
  set creatingPaymentLink(value: boolean) { this._creatingPaymentLink.set(value); }
  private readonly _paymentLinkError = signal<string | null>(null);
  get paymentLinkError(): string | null { return this._paymentLinkError(); }
  set paymentLinkError(value: string | null) { this._paymentLinkError.set(value); }
  private readonly _paymentLinkNotice = signal<string | null>(null);
  get paymentLinkNotice(): string | null { return this._paymentLinkNotice(); }
  set paymentLinkNotice(value: string | null) { this._paymentLinkNotice.set(value); }
  private readonly _paymentLinkUrl = signal<string | null>(null);
  get paymentLinkUrl(): string | null { return this._paymentLinkUrl(); }
  set paymentLinkUrl(value: string | null) { this._paymentLinkUrl.set(value); }
  private readonly _createdReservation = signal<CreatedReservationContext | null>(null);
  get createdReservation(): CreatedReservationContext | null { return this._createdReservation(); }
  set createdReservation(value: CreatedReservationContext | null) { this._createdReservation.set(value); }
  // Square Web Payments SDK config + in-venue Cash App pad state.
  // Loaded from `/events/current-context` (admin settings); the pad
  // emits tokenized → `onCashAppTokenizedInWizard` posts the source.
  readonly squareApplicationId = signal('');
  readonly squareLocationId = signal('');
  readonly squareEnvMode = signal<'sandbox' | 'production'>('sandbox');
  readonly cashAppPaymentSuccess = signal(false);
  readonly cashAppCharging = signal(false);
  // When staff closes the wizard modal before the customer scans the
  // Cash App QR, the reservation already exists with PENDING payment.
  // We capture the context here so the wizard's main view can render a
  // sticky "Resume Cash App payment" banner — clicking it reopens the
  // QR pad in a small dialog without forcing staff to navigate to
  // /staff/reservations. Cleared on success or explicit dismiss.
  readonly pendingCashAppPayment = signal<CreatedReservationContext | null>(null);
  readonly showCashAppResumeDialog = signal(false);
  readonly cashAppResumeCharging = signal(false);
  readonly cashAppResumeSuccess = signal(false);
  readonly cashAppResumeError = signal<string | null>(null);
  readonly cancelPendingConfirmOpen = signal(false);
  readonly cancelPendingLoading = signal(false);
  readonly cancelPendingError = signal<string | null>(null);
  // Square Stand handoff: symmetric with Cash App. Wizard-level state for
  // the post-create handoff UI and the "pending Stand payment" recovery
  // banner shown when staff closes the modal mid-flow (Safari leaves the
  // page during the URL-scheme handoff, but the reservation is already
  // CONFIRMED+PENDING — we surface a Resume / Cancel reservation banner).
  readonly squareStandSuccess = signal(false);
  readonly pendingSquareStandPayment = signal<CreatedReservationContext | null>(null);
  readonly cancelPendingStandConfirmOpen = signal(false);
  readonly cancelPendingStandLoading = signal(false);
  readonly cancelPendingStandError = signal<string | null>(null);
  private readonly _desktopSplitHeightPx = signal<number | null>(null);
  get desktopSplitHeightPx(): number | null { return this._desktopSplitHeightPx(); }
  set desktopSplitHeightPx(value: number | null) { this._desktopSplitHeightPx.set(value); }
  private readonly _compactBottomInsetPx = signal(96);
  get compactBottomInsetPx(): number { return this._compactBottomInsetPx(); }
  set compactBottomInsetPx(value: number) { this._compactBottomInsetPx.set(value); }
  private readonly _compactPanelHeightPx = signal<number | null>(null);
  get compactPanelHeightPx(): number | null { return this._compactPanelHeightPx(); }
  set compactPanelHeightPx(value: number | null) { this._compactPanelHeightPx.set(value); }
  private readonly _compactSectionBottomPaddingPx = signal<number | null>(null);
  get compactSectionBottomPaddingPx(): number | null { return this._compactSectionBottomPaddingPx(); }
  set compactSectionBottomPaddingPx(value: number | null) { this._compactSectionBottomPaddingPx.set(value); }
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
    this.syncWorkspaceScrollLock(true);
    this.detachVisualViewportListeners();
    this.stopPolling();
    this.clearHoldTimer();
    void this.cashAppQrPad?.destroy();
    void this.cashAppResumePad?.destroy();
    if (this.desktopLayoutRafId !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.desktopLayoutRafId);
      this.desktopLayoutRafId = null;
    }
  }


  loadTables(date: string, opts: { silent?: boolean } = {}): void {
    const silent = opts.silent === true;
    if (!silent) {
      this.loading = true;
      this.error = null;
    }
    this.tablesApi
      .getForEvent(date)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
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
    this.eventsApi
      .listEvents()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
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
    this.holdExpired = false;
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

  trackByEventDate(_: number, e: EventItem): string {
    return e.eventDate ?? '';
  }
  trackByTableId(_: number, t: TableForEvent): string {
    return t.id;
  }
  trackBySection(_: number, s: string): string {
    return s;
  }
  trackByClientPhone(_: number, c: CrmClient): string {
    return c.phone ?? '';
  }
  trackByCreditId(_: number, c: RescheduleCredit): string {
    return c.creditId ?? '';
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
    // Guard: if we own a live hold (or a multi-table booking in progress),
    // surface the modal with an explanation instead of silently clobbering
    // the local hold map. Without this, addAnotherTable-fail + subsequent
    // map-click would orphan the existing server-side holds until the cron
    // sweep — staff would see them as PENDING_PAYMENT until release.
    if (
      this.holdId &&
      this.holdCreatedByMe &&
      this.selectedTables.length > 0 &&
      !this.selectedTables.some((existing) => existing.id === t.id)
    ) {
      this.addAnotherTableError =
        'Release the current booking or click "+ Add another table" before picking a different table.';
      this.showReservationModal = true;
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
    this.holdExpired = false;
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
      .pipe(takeUntilDestroyed(this.destroyRef))
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
    this.holdsApi
      .releaseHold(this.eventDate, tableId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: () => {
        const wasPrimary = this.selectedTableId === tableId;
        this.selectedTables = this.selectedTables.filter((t) => t.id !== tableId);
        this.holdEntries = this.holdEntries.filter((h) => h.tableId !== tableId);
        // If we just removed the primary table, promote the new first
        // holdEntry to primary. Otherwise the scalars (selectedTable,
        // holdId, holdExpiresAt, holdCreatedByMe) would stay pointed at
        // the deleted table — loadTables would null out selectedTable,
        // the modal would close silently, and the remaining holds would
        // sit on the server until the cron sweep.
        if (wasPrimary) {
          const nextPrimary = this.holdEntries[0] ?? null;
          this.selectedTable = nextPrimary
            ? this.selectedTables.find((t) => t.id === nextPrimary.tableId) ?? null
            : null;
          this.selectedTableId = nextPrimary?.tableId ?? null;
          this.holdId = nextPrimary?.holdId ?? null;
          this.holdExpiresAt = nextPrimary?.holdExpiresAt ?? null;
          this.holdCreatedByMe = nextPrimary?.holdCreatedByMe ?? false;
          this.startHoldTimer();
        }
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
    if (this.creatingHold) return;
    const phone = normalizePhoneToE164(
      this.form.controls.phone.value,
      normalizePhoneCountry(this.phoneCountry)
    );
    this.creatingHold = true;
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
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (item) => {
          this.holdId = item.holdId;
          this.holdExpiresAt = item.expiresAt ?? null;
          this.holdCreatedByMe = true;
          this.holdExpired = false;
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
          this.creatingHold = false;
          this.loading = false;
          this.loadTables(this.eventDate!);
          if (openModal) this.openReservationModal();
        },
        error: (err) => {
          this.error = err?.error?.message || err?.message || 'Failed to hold table';
          this.creatingHold = false;
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
    if (entries.length === 0) {
      // Nothing to release server-side, but the user clicked Release in
      // a state where local hold flags were stale (e.g. timer expired
      // mid-action). Clear everything locally so the modal closes
      // cleanly instead of looking broken.
      this.selectedTables = [];
      this.holdEntries = [];
      this.holdId = null;
      this.holdExpiresAt = null;
      this.holdCountdown = 0;
      this.holdExpired = false;
      this.clearHoldTimer();
      this.holdCreatedByMe = false;
      this.showReleaseConfirm = false;
      this.showReservationModal = false;
      this.clearActiveHoldSession();
      return;
    }
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
            this.holdsApi
              .releaseHold(eventDate, entry.tableId)
              .pipe(takeUntilDestroyed(this.destroyRef))
              .subscribe({
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
      this.holdExpired = false;
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
    if (this.confirmingReservation) return;
    this.confirmSubmitAttempted = true;
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
    if (this.isCashReceiptRequired() && !this.normalizedReceiptNumber()) {
      this.error = 'Receipt number is required when the remaining balance is paid with cash.';
      return;
    }
    this.confirmingReservation = true;
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
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (created) => {
          const createdItem = created?.item;
          const autoSquareLinkSms = created?.autoSquareLinkSms;
          const reservationId = String(createdItem?.reservationId ?? '');
          this.holdId = null;
          this.holdExpiresAt = null;
          this.holdCountdown = 0;
          this.holdExpired = false;
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
            this.confirmingReservation = false;
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
              .pipe(takeUntilDestroyed(this.destroyRef))
              .subscribe({
                next: () => {
                  if (creditRemainingAmount > 0) {
                    if (remainingMethod === 'square') {
                      this.confirmingReservation = false;
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
                        receiptNumber:
                          remainingMethod === 'cash' ? this.normalizedReceiptNumber() : '',
                      })
                      .pipe(takeUntilDestroyed(this.destroyRef))
                      .subscribe({
                        next: () => {
                          this.confirmingReservation = false;
                          this.loading = false;
                          this.finishReservationFlow();
                        },
                        error: (err) => {
                          this.error =
                            err?.error?.message ||
                            err?.message ||
                            `Credit applied, but remaining payment failed. Reservation ID: ${reservationId}`;
                          this.confirmingReservation = false;
                          this.loading = false;
                        },
                      });
                    return;
                  }

                  this.confirmingReservation = false;
                  this.loading = false;
                  this.finishReservationFlow();
                },
                error: (err) => {
                  this.error =
                    err?.error?.message ||
                    err?.message ||
                    `Reservation created, but credit apply failed. Reservation ID: ${reservationId}`;
                  this.confirmingReservation = false;
                  this.loading = false;
                },
              });
            return;
          }

          if (paymentMethod === 'square') {
            if (autoSquareLinkSms?.sent) {
              this.confirmingReservation = false;
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
            this.confirmingReservation = false;
            this.loading = false;
            this.generatePaymentLinkForCurrentFlow();
            return;
          }

          if (paymentMethod === 'cashapp') {
            this.createdReservation = {
              reservationId,
              eventDate: this.eventDate!,
              tableId: bookingTableIds[0],
              tableIds: bookingTableIds,
              customerName: this.form.controls.customerName.value,
              phone,
              amount: amountDue,
              linkMode: 'cashapp',
            };
            this.confirmingReservation = false;
            this.loading = false;
            // No further API call here — the QR pad lives in the post-
            // create section of the modal and mounts on staff click.
            // `onCashAppTokenizedInWizard` records the payment.
            return;
          }

          if (paymentMethod === 'square_stand') {
            this.createdReservation = {
              reservationId,
              eventDate: this.eventDate!,
              tableId: bookingTableIds[0],
              tableIds: bookingTableIds,
              customerName: this.form.controls.customerName.value,
              phone,
              amount: amountDue,
              confirmationCode:
                (createdItem as { confirmationCode?: string | null })
                  ?.confirmationCode ?? null,
              linkMode: 'square_stand',
            };
            this.confirmingReservation = false;
            this.loading = false;
            // The handoff button mounts inside the post-create section of
            // the modal. Square POS opens on tap, customer swipes, Safari
            // returns to /square-stand-callback which records the payment.
            // The wizard's "pending stand payment" banner takes over if
            // staff closes the modal mid-flow.
            return;
          }

          this.confirmingReservation = false;
          this.loading = false;
          this.finishReservationFlow();
        },
        error: (err) => {
          this.error =
            err?.error?.message || err?.message || 'Failed to confirm reservation';
          this.confirmingReservation = false;
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
      // Both the modal X/backdrop AND the bottom "Done" button route
      // through finishReservationFlow(), which is where the Cash-App-
      // pending banner stash lives so the recovery path works from
      // either gesture.
      this.finishReservationFlow();
      return;
    }
    if (this.holdId && this.holdCreatedByMe) {
      this.showReleaseConfirm = true;
      this.saveActiveHoldSessionIfNeeded();
      return;
    }
    // No live hold (or hold expired): just close the modal and clear the
    // expired flag so it doesn't surface again the next time the modal opens.
    this.showReservationModal = false;
    this.holdExpired = false;
    this.saveActiveHoldSessionIfNeeded();
  }

  // --- Resume "Cash App pending" banner + dialog ------------------------

  openCashAppResumeDialog(): void {
    if (!this.pendingCashAppPayment()) return;
    this.cashAppResumeError.set(null);
    this.cashAppResumeSuccess.set(false);
    this.cashAppResumeCharging.set(false);
    this.showCashAppResumeDialog.set(true);
  }

  openCancelPendingCashApp(): void {
    if (!this.pendingCashAppPayment()) return;
    this.cancelPendingError.set(null);
    this.cancelPendingConfirmOpen.set(true);
  }

  closeCancelPendingCashApp(): void {
    if (this.cancelPendingLoading()) return;
    this.cancelPendingConfirmOpen.set(false);
  }

  confirmCancelPendingCashApp(): void {
    const ctx = this.pendingCashAppPayment();
    if (!ctx) return;
    if (this.cancelPendingLoading()) return;
    this.cancelPendingLoading.set(true);
    this.cancelPendingError.set(null);
    this.reservationsApi
      .cancel(
        ctx.reservationId,
        ctx.eventDate,
        ctx.tableId || null,
        'Cash App payment not completed',
        'CANCEL_NO_REFUND'
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.cancelPendingLoading.set(false);
          this.cancelPendingConfirmOpen.set(false);
          this.pendingCashAppPayment.set(null);
          // Reload tables so the cancelled reservation's table goes
          // back to AVAILABLE on the map immediately.
          if (this.eventDate) {
            this.loadTables(this.eventDate);
          }
        },
        error: (err: any) => {
          this.cancelPendingLoading.set(false);
          this.cancelPendingError.set(
            err?.error?.message || err?.message || 'Failed to cancel reservation.'
          );
        },
      });
  }

  closeCashAppResumeDialog(): void {
    this.showCashAppResumeDialog.set(false);
    this.cashAppResumeError.set(null);
    void this.cashAppResumePad?.destroy();
  }

  prepareCashAppResume(): void {
    const ctx = this.pendingCashAppPayment();
    if (!ctx) return;
    if (!this.canUseCashAppPay()) {
      this.cashAppResumeError.set(
        'Cash App Pay is not configured. Set Square application id and location id in Admin → Settings.'
      );
      return;
    }
    this.cashAppResumeError.set(null);
    this.cashAppResumeSuccess.set(false);
    void this.cashAppResumePad?.prepare();
  }

  onCashAppResumeTokenized(sourceId: string): void {
    const ctx = this.pendingCashAppPayment();
    if (!ctx) return;
    if (this.cashAppResumeCharging()) return;

    this.cashAppResumeCharging.set(true);
    this.cashAppResumeError.set(null);

    this.reservationsApi
      .addSquarePayment({
        reservationId: ctx.reservationId,
        eventDate: ctx.eventDate,
        amount: ctx.amount,
        sourceId,
        note: `Cash App Pay for ${
          formatBookingTablesLabel(ctx.tableIds) || `table ${ctx.tableId}`
        }`,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.cashAppResumeSuccess.set(true);
          setTimeout(() => {
            this.cashAppResumeCharging.set(false);
            this.pendingCashAppPayment.set(null);
            this.closeCashAppResumeDialog();
            // Refresh the table map so the reservation's new payment
            // status shows up immediately.
            if (this.eventDate) {
              this.loadTables(this.eventDate);
            }
          }, 1500);
        },
        error: (err: any) => {
          this.cashAppResumeCharging.set(false);
          this.cashAppResumeError.set(
            err?.error?.message || err?.message || 'Failed to record Cash App payment.'
          );
        },
      });
  }

  onCashAppResumeErrored(message: string): void {
    this.cashAppResumeError.set(message || 'Cash App payment was not completed.');
  }

  // -------------------------------------------------------------------
  // Pending Square Stand payment banner — mirrors the Cash App pair of
  // openCancelPendingCashApp + confirmCancelPendingCashApp.
  // -------------------------------------------------------------------

  openCancelPendingStand(): void {
    if (!this.pendingSquareStandPayment()) return;
    this.cancelPendingStandError.set(null);
    this.cancelPendingStandConfirmOpen.set(true);
  }

  closeCancelPendingStand(): void {
    if (this.cancelPendingStandLoading()) return;
    this.cancelPendingStandConfirmOpen.set(false);
  }

  confirmCancelPendingStand(): void {
    const ctx = this.pendingSquareStandPayment();
    if (!ctx) return;
    if (this.cancelPendingStandLoading()) return;
    this.cancelPendingStandLoading.set(true);
    this.cancelPendingStandError.set(null);
    this.reservationsApi
      .cancel(
        ctx.reservationId,
        ctx.eventDate,
        ctx.tableId || null,
        'Card on Stand payment not completed',
        'CANCEL_NO_REFUND',
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.cancelPendingStandLoading.set(false);
          this.cancelPendingStandConfirmOpen.set(false);
          this.pendingSquareStandPayment.set(null);
          if (this.eventDate) {
            this.loadTables(this.eventDate);
          }
        },
        error: (err: any) => {
          this.cancelPendingStandLoading.set(false);
          this.cancelPendingStandError.set(
            err?.error?.message || err?.message || 'Failed to cancel reservation.',
          );
        },
      });
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
            // Surface the expiry to the UI: null the scalars so the
            // countdown chip disappears, drop the multi-table holds (they
            // share the same TTL), and flag holdExpired so the modal can
            // render a "hold expired" banner instead of a stuck 0:00.
            // confirmReservation already short-circuits on !holdId.
            this.holdExpired = true;
            this.holdId = null;
            this.holdExpiresAt = null;
            this.holdEntries = [];
            this.holdCreatedByMe = false;
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

  readonly holdCountdownLabel = computed<string>(() => {
    const total = this._holdCountdown() || 0;
    const min = Math.floor(total / 60);
    const sec = String(total % 60).padStart(2, '0');
    return `${min}:${sec}`;
  });

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

  // True when the credit-applied remainder will be collected as cash and
  // the venue's settings require a receipt number for cash payments.
  // Backend services-payment-recording.mjs:578 rejects method:'cash' without
  // a receiptNumber when resolveCashReceiptNumberRequired() is true (default).
  isCashReceiptRequired(): boolean {
    if (!this.cashReceiptNumberRequired) return false;
    return (
      this.isUsingClientCredit() &&
      this.clientCreditRemainingAmount() > 0 &&
      this.form.controls.remainingMethod.value === 'cash'
    );
  }

  shouldShowCashReceiptError(): boolean {
    return (
      this.confirmSubmitAttempted &&
      this.isCashReceiptRequired() &&
      !this.normalizedReceiptNumber()
    );
  }

  private normalizedReceiptNumber(): string {
    return String(this.form.controls.receiptNumber.value ?? '')
      .replace(/\D+/g, '')
      .trim();
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
    item: { value: 'cash' | 'square' | 'cashapp' | 'square_stand' }
  ): string {
    return item.value;
  }

  isPaymentMethod(value: 'cash' | 'square' | 'cashapp' | 'square_stand'): boolean {
    return this.form.controls.paymentMethod.value === value;
  }

  onPaymentMethodButtonClick(
    event: Event,
    value: 'cash' | 'square' | 'cashapp' | 'square_stand',
  ): void {
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

  isCashAppMethod(): boolean {
    return this.form.controls.paymentMethod.value === 'cashapp';
  }

  isSquareStandMethod(): boolean {
    return this.form.controls.paymentMethod.value === 'square_stand';
  }

  isLinkCollectionFlow(): boolean {
    if (this.isUsingClientCredit() && this.shouldShowCreditRemainingMethod()) {
      return this.form.controls.remainingMethod.value === 'square';
    }
    return this.isSquareMethod() || this.isCashAppMethod() || this.isSquareStandMethod();
  }

  private currentLinkModeFromForm(): 'square' | 'cashapp' | 'square_stand' | null {
    if (this.isUsingClientCredit() && this.shouldShowCreditRemainingMethod()) {
      return this.form.controls.remainingMethod.value === 'square' ? 'square' : null;
    }
    const method = this.form.controls.paymentMethod.value;
    if (method === 'square') return 'square';
    if (method === 'cashapp') return 'cashapp';
    if (method === 'square_stand') return 'square_stand';
    return null;
  }

  private currentLinkMode(): 'square' | 'cashapp' | 'square_stand' | null {
    return this.createdReservation?.linkMode ?? this.currentLinkModeFromForm();
  }

  private newIdempotencyKey(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for non-secure contexts where crypto.randomUUID is missing
    // (e.g. older Safari, http://localhost without secure context). Random
    // enough for an idempotency token; not used for any security boundary.
    return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  generatePaymentLinkForCurrentFlow(): void {
    if (!this.createdReservation) return;
    const linkMode = this.currentLinkMode();
    if (!linkMode) return;
    if (this.creatingPaymentLink) return;

    this.creatingPaymentLink = true;
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;
    // Square's create-link route accepts an idempotencyKey; a per-attempt
    // UUID makes rapid double-clicks and component re-mount races collapse
    // onto a single Square link instead of minting orphans.
    const idempotencyKey = this.newIdempotencyKey();

    this.reservationsApi
      .createSquarePaymentLink({
        reservationId: this.createdReservation.reservationId,
        eventDate: this.createdReservation.eventDate,
        amount: this.createdReservation.amount,
        note: `Square link for ${
          formatBookingTablesLabel(this.createdReservation.tableIds) ||
          `table ${this.createdReservation.tableId}`
        }`,
        idempotencyKey,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
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

  // --- In-venue Cash App QR (linkMode === 'cashapp') --------------------
  // Parent-side glue around <cash-app-qr-pad>. Triggered from the post-
  // create "Show Cash App QR" button; the pad mounts the Web Payments
  // SDK, customer scans, SDK fires (tokenized), we POST the source to
  // addSquarePayment and flip the reservation to PAID/PARTIAL.

  canUseCashAppPay(): boolean {
    return Boolean(this.squareApplicationId() && this.squareLocationId());
  }

  cashAppPadLabel(): string {
    if (!this.createdReservation) return 'Reservation payment';
    const label =
      formatBookingTablesLabel(this.createdReservation.tableIds) ||
      (this.createdReservation.tableId ? `table ${this.createdReservation.tableId}` : '');
    return label ? `${label} payment` : 'Reservation payment';
  }

  prepareCashAppQrInWizard(): void {
    if (!this.createdReservation) return;
    if (this.createdReservation.linkMode !== 'cashapp') return;
    if (!this.canUseCashAppPay()) {
      this.paymentLinkError =
        'Cash App Pay is not configured. Set Square application id and location id in Admin → Settings.';
      return;
    }
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;
    this.cashAppPaymentSuccess.set(false);
    void this.cashAppQrPad?.prepare();
  }

  onCashAppTokenizedInWizard(sourceId: string): void {
    const ctx = this.createdReservation;
    if (!ctx) return;
    if (this.cashAppCharging()) return;

    this.cashAppCharging.set(true);
    this.paymentLinkError = null;

    this.reservationsApi
      .addSquarePayment({
        reservationId: ctx.reservationId,
        eventDate: ctx.eventDate,
        amount: ctx.amount,
        sourceId,
        note: `Cash App Pay for ${
          formatBookingTablesLabel(ctx.tableIds) || `table ${ctx.tableId}`
        }`,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          // Brief green "Paid" display before the wizard wraps up so
          // staff sees explicit confirmation without an extra dialog.
          this.cashAppPaymentSuccess.set(true);
          setTimeout(() => {
            this.cashAppCharging.set(false);
            this.finishReservationFlow();
          }, 1500);
        },
        error: (err: any) => {
          this.cashAppCharging.set(false);
          this.paymentLinkError =
            err?.error?.message || err?.message || 'Failed to record Cash App payment.';
        },
      });
  }

  onCashAppErroredInWizard(message: string): void {
    this.paymentLinkError = message || 'Cash App payment was not completed.';
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
    const target = recipient ? `sms:${recipient}?body=${encodeURIComponent(body)}` : `sms:?body=${encodeURIComponent(body)}`;
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
    if (mode === 'cashapp') return 'Cash App QR';
    if (mode === 'square_stand') return 'Card on Stand';
    return 'Square Link';
  }

  reservationActionLabel(): string {
    if (this.createdReservation) return 'Done';
    if (this.isLinkCollectionFlow()) {
      const mode = this.currentLinkModeFromForm();
      if (mode === 'cashapp') return 'Confirm & Show Cash App QR';
      if (mode === 'square_stand') return 'Confirm & Hand off to Square POS';
      return 'Confirm & Generate Square Link';
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
    this.cashAppPaymentSuccess.set(false);
    this.cashAppCharging.set(false);
    void this.cashAppQrPad?.destroy();
  }

  finishReservationFlow(): void {
    // If the wizard is wrapping up while a Cash App QR is still
    // mid-flow (reservation already created, customer hasn't scanned
    // yet), stash the context so the map view can surface a "Resume /
    // Cancel" banner. Either close gesture — modal X/backdrop or the
    // bottom "Done" button — routes through here, so this single
    // check covers both.
    const created = this.createdReservation;
    if (
      created &&
      created.linkMode === 'cashapp' &&
      !this.cashAppPaymentSuccess() &&
      !this.cashAppCharging()
    ) {
      this.pendingCashAppPayment.set(created);
    }
    // Same idea for the Stand handoff. Closing the wizard before the
    // /square-stand-callback hits /complete leaves the reservation as
    // CONFIRMED+PENDING. Stash so the user can resume or cancel from
    // the banner above the map.
    if (
      created &&
      created.linkMode === 'square_stand' &&
      !this.squareStandSuccess()
    ) {
      this.pendingSquareStandPayment.set(created);
    }
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
      receiptNumber: '',
    });
    this.confirmSubmitAttempted = false;
    this.holdExpired = false;
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

    this.clientsApi
      .listRescheduleCredits(phone, country)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
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
    this.eventsApi
      .getCurrentContext()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (ctx) => {
        // businessDate setter writes to a signal → the upcomingEventsCache +
        // pastEventsCache computeds re-evaluate automatically using the new
        // split point. No explicit recompute needed.
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
        const cashReceiptSetting = ctx?.settings?.cashReceiptNumberRequired;
        this.cashReceiptNumberRequired =
          typeof cashReceiptSetting === 'boolean' ? cashReceiptSetting : true;
        this.squareApplicationId.set(String(ctx?.settings?.squareApplicationId ?? '').trim());
        this.squareLocationId.set(String(ctx?.settings?.squareLocationId ?? '').trim());
        this.squareEnvMode.set(
          String(ctx?.settings?.squareEnvMode ?? '').trim().toLowerCase() === 'production'
            ? 'production'
            : 'sandbox'
        );
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
    // Skip if a recompute is already pending for the next frame. Audit
    // flagged the prior cancel+request churn that ran on every ngDoCheck —
    // collapsing duplicate schedules to a single rAF eliminates the
    // wasted bookkeeping while still picking up state-driven layout
    // changes (modal open, table list grow, etc.) on the next frame.
    if (this.desktopLayoutRafId !== null) return;
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
    this.holdsApi
      .listLocks(this.eventDate)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
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
        this.holdExpired = false;
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
