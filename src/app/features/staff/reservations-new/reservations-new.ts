import {
  AfterViewInit,
  Component,
  DoCheck,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
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
  inferPhoneCountryFromE164,
  normalizePhoneCountry,
  normalizePhoneToE164,
} from '../../../shared/phone';
import { PhoneDisplayPipe } from '../../../shared/phone-display.pipe';
import { TableMap } from '../../../shared/components/table-map/table-map';

interface CreatedReservationContext {
  reservationId: string;
  eventDate: string;
  tableId: string;
  customerName: string;
  phone: string;
  amount: number;
  linkMode: 'square' | 'client' | null;
}

interface ActiveHoldSession {
  eventDate: string;
  tableId: string;
  holdId: string;
  holdExpiresAt: number | null;
  holdCreatedByMe: boolean;
  showReservationModal: boolean;
  customerName: string;
  phone: string;
  phoneCountry: 'US' | 'MX';
  amountDue: number;
  depositAmount: number;
  paymentStatus: 'PAID' | 'PARTIAL' | 'PENDING' | 'COURTESY';
  paymentMethod: 'cash' | 'square' | 'client';
  allowCustomDeposit: boolean;
  paymentDeadlineEnabled: boolean;
  paymentDeadlineDate: string;
  paymentDeadlineTime: string;
  savedAt: number;
}

@Component({
  selector: 'app-reservations-new',
  imports: [CommonModule, ReactiveFormsModule, PhoneDisplayPipe, TableMap],
  templateUrl: './reservations-new.html',
  styleUrl: './reservations-new.scss',
})
export class ReservationsNew implements OnInit, OnDestroy, DoCheck, AfterViewInit {
  private readonly filterStorageKey = 'ff_new_res_filters_v1';
  private readonly holdSessionStorageKey = 'ff_new_res_active_hold_v1';
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
  private pollSub: Subscription | null = null;
  showReservationModal = false;
  sections: string[] = [];
  allowCustomDeposit = false;
  paymentDeadlineEnabled = false;
  paymentDeadlineDate = new FormControl('', { nonNullable: true });
  paymentDeadlineTime = new FormControl('00:00', { nonNullable: true });
  paymentDeadlineTz = 'America/Chicago';
  businessDate = this.todayString();
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
  filterStatus = new FormControl<
    'ALL' | 'AVAILABLE' | 'HOLD' | 'PENDING_PAYMENT' | 'RESERVED' | 'DISABLED'
  >('ALL', {
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
    this.activeHoldSession = this.readActiveHoldSession();
    this.loadRuntimeContext();
    this.route.queryParamMap.subscribe((params) => {
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

    this.form.controls.amountDue.valueChanges.subscribe((value) => {
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

    this.form.controls.paymentMethod.valueChanges.subscribe(() => {
      this.onPaymentMethodChange();
    });
    this.form.controls.useCredit.valueChanges.subscribe(() => {
      this.onUseClientCreditChanged();
    });
    this.form.controls.creditId.valueChanges.subscribe(() => {
      this.onClientCreditChanged();
    });
    this.form.controls.remainingMethod.valueChanges.subscribe(() => {
      this.onClientCreditRemainingMethodChanged();
    });
    this.form.valueChanges.subscribe(() => {
      this.saveActiveHoldSessionIfNeeded();
    });

    this.form.controls.phone.valueChanges
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((value) => {
          const digits = this.normalizePhone(value);
          if (digits.length < 4) {
            this.clientMatches = [];
            this.noClientMatch = false;
            this.exactMatchPhone = null;
            this.clearClientCreditsState();
            return of([]);
          }
          this.clientLoading = true;
          return this.clientsApi.searchByPhone(digits);
        })
      )
      .subscribe({
        next: (items: CrmClient[]) => {
          const matches = items ?? [];
          const entered = this.normalizePhone(this.form.controls.phone.value);
          const exact = matches.find(
            (m) => this.phonesMatch(m.phone, entered) && entered.length >= 10
          );
          this.exactMatchPhone = exact ? this.normalizePhone(exact.phone) : null;
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
        this.tables = res.tables;
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

  private startPolling(): void {
    this.stopPolling();
    this.pollSub = interval(this.tablePollingSeconds * 1000).subscribe(() => {
      if (!this.eventDate) return;
      if (this.showReservationModal) return;
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
    this.holdId = null;
    this.holdExpiresAt = null;
    this.holdCountdown = 0;
    this.clearHoldTimer();
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

  todayString(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  selectTable(t: TableForEvent): void {
    if (t.status !== 'AVAILABLE') return;
    this.clearActiveHoldSession();
    this.selectedTable = t;
    this.selectedTableId = t.id;
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
    this.holdsApi
      .createHold({
        eventDate: this.eventDate,
        tableId: this.selectedTable.id,
        customerName: this.form.controls.customerName.value,
        phone: phone || undefined,
        phoneCountry: this.phoneCountry,
      })
      .subscribe({
        next: (item) => {
          this.holdId = item.holdId;
          this.holdExpiresAt = item.expiresAt ?? null;
          this.holdCreatedByMe = true;
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
    if (!this.eventDate || !this.selectedTable) return;
    this.loading = true;
    this.error = null;
    this.holdsApi.releaseHold(this.eventDate, this.selectedTable.id).subscribe({
      next: () => {
        this.holdId = null;
        this.holdExpiresAt = null;
        this.holdCountdown = 0;
        this.clearHoldTimer();
        this.holdCreatedByMe = false;
        this.showReleaseConfirm = false;
        this.showReservationModal = false;
        this.clearActiveHoldSession();
        this.loadTables(this.eventDate!);
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || err?.message || 'Failed to release hold';
        this.loading = false;
      },
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
      : this.toCreatePaymentMethod(paymentMethod);
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
      if (!this.isFutureDeadline(paymentDeadlineAt, this.paymentDeadlineTz)) {
        this.error = 'Payment deadline must be in the future.';
        this.loading = false;
        return;
      }
    }
    this.reservationsApi
      .create({
        eventDate: this.eventDate,
        tableId: this.selectedTable.id,
        holdId: this.holdId,
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
              tableId: this.selectedTable!.id,
              customerName: this.form.controls.customerName.value,
              phone,
              amount: creditRemainingAmount > 0 ? creditRemainingAmount : amountDue,
              linkMode: creditRemainingAmount > 0 ? this.toLinkMode(remainingMethod) : null,
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
              tableId: this.selectedTable!.id,
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
            this.createdReservation = {
              reservationId,
              eventDate: this.eventDate!,
              tableId: this.selectedTable!.id,
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
    const update = () => {
      const now = Math.floor(Date.now() / 1000);
      this.holdCountdown = Math.max(0, this.holdExpiresAt! - now);
      if (this.holdCountdown <= 0) {
        this.clearHoldTimer();
        this.clearActiveHoldSession();
      }
    };
    update();
    this.holdTimer = setInterval(update, 1000);
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
    this.exactMatchPhone = this.normalizePhone(client.phone);
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
    return Number(
      this.clientCredits.reduce((sum, credit) => sum + Number(credit.amountRemaining ?? 0), 0).toFixed(2)
    );
  }

  clientCreditLabel(credit: RescheduleCredit): string {
    const amount = Number(credit.amountRemaining ?? 0);
    const expires = this.formatCreditExpiry(credit.expiresAt);
    return expires ? `$${amount.toFixed(2)} · Expires ${expires}` : `$${amount.toFixed(2)} · No expiry`;
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
    const selectedId = String(this.form.controls.creditId.value ?? '').trim();
    if (!selectedId) return null;
    return this.clientCredits.find((credit) => credit.creditId === selectedId) ?? null;
  }

  clientCreditAppliedAmount(): number {
    if (!this.isUsingClientCredit()) return 0;
    const selected = this.selectedClientCredit();
    if (!selected) return 0;
    const amountDue = Number(this.form.controls.amountDue.value ?? 0);
    const available = Number(selected.amountRemaining ?? 0);
    return Number(Math.max(0, Math.min(amountDue, available)).toFixed(2));
  }

  clientCreditRemainingAmount(): number {
    if (!this.isUsingClientCredit()) return Number(Math.max(0, this.form.controls.amountDue.value).toFixed(2));
    const remaining = Number(this.form.controls.amountDue.value ?? 0) - this.clientCreditAppliedAmount();
    return Number(Math.max(0, remaining).toFixed(2));
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
    const phone = this.normalizePhone(client.phone);
    return !!this.exactMatchPhone && phone === this.exactMatchPhone;
  }

  private normalizePhone(value: string | null | undefined): string {
    return String(value ?? '').replace(/\D/g, '');
  }

  private formatCreditExpiry(value: string | null | undefined): string {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const date = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  private phonesMatch(storedPhone: string | null | undefined, enteredDigits: string): boolean {
    const stored = this.normalizePhone(storedPhone);
    if (!stored || !enteredDigits) return false;
    if (stored === enteredDigits) return true;
    if (enteredDigits.length === 10) {
      if (stored === `1${enteredDigits}`) return true;
      if (stored === `52${enteredDigits}`) return true;
      if (stored === `521${enteredDigits}`) return true;
    }
    return false;
  }

  private setDefaultPaymentDeadline(): void {
    if (!this.eventDate) return;
    this.paymentDeadlineDate.setValue(this.nextDate(this.eventDate));
    this.paymentDeadlineTime.setValue(
      this.formatHm(this.defaultPaymentDeadlineHour, this.defaultPaymentDeadlineMinute)
    );
  }

  private nextDate(date: string): string {
    const parts = date.split('-').map((part) => Number(part));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
      return date;
    }
    const [year, month, day] = parts;
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() + 1);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private normalizeDeadlineLocalIso(value: string): string | null {
    const raw = String(value ?? '').trim();
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const [, ymd, hh, mm, ss] = match;
    return `${ymd}T${hh}:${mm}:${ss ?? '00'}`;
  }

  private nowInTimeZoneLocalIso(tz: string): string | null {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date());
      const get = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((p) => p.type === type)?.value ?? '';
      const yyyy = get('year');
      const mm = get('month');
      const dd = get('day');
      const hh = get('hour');
      const min = get('minute');
      const sec = get('second');
      if (!yyyy || !mm || !dd || !hh || !min || !sec) return null;
      return `${yyyy}-${mm}-${dd}T${hh}:${min}:${sec}`;
    } catch {
      return null;
    }
  }

  private isFutureDeadline(deadlineAt: string, tz: string): boolean {
    const normalizedDeadline = this.normalizeDeadlineLocalIso(deadlineAt);
    if (!normalizedDeadline) return false;
    const nowIso = this.nowInTimeZoneLocalIso(tz || 'America/Chicago');
    if (!nowIso) return false;
    return normalizedDeadline > nowIso;
  }

  private normalizePollingSeconds(value: number | null | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(120, Math.max(5, Math.round(parsed)));
  }

  private normalizeHour(value: number | null | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(23, Math.max(0, Math.round(parsed)));
  }

  private normalizeMinute(value: number | null | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(59, Math.max(0, Math.round(parsed)));
  }

  private formatHm(hour: number, minute: number): string {
    return `${String(this.normalizeHour(hour, 0)).padStart(2, '0')}:${String(
      this.normalizeMinute(minute, 0)
    ).padStart(2, '0')}`;
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

  private toCreatePaymentMethod(
    method: 'cash' | 'square' | 'client'
  ): 'cash' | 'square' | null {
    if (method === 'cash') return 'cash';
    if (method === 'square') return 'square';
    return null;
  }

  private toLinkMode(
    method: 'cash' | 'square' | 'client'
  ): 'square' | 'client' | null {
    if (method === 'square' || method === 'client') return method;
    return null;
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
        .createPublicPayLink({
          reservationId: this.createdReservation.reservationId,
          eventDate: this.createdReservation.eventDate,
          amount: this.createdReservation.amount,
        })
        .subscribe({
          next: (res) => {
            const url = String(res?.publicPay?.url ?? '').trim();
            if (!url) {
              this.paymentLinkError =
                'Payment link generation succeeded but no URL was returned.';
              this.creatingPaymentLink = false;
              return;
            }
            this.paymentLinkUrl = url;
            const ttlMinutes = Number(res?.publicPay?.ttlMinutes ?? 0);
            this.paymentLinkNotice =
              Number.isFinite(ttlMinutes) && ttlMinutes > 0
                ? `Cash App link generated (expires in ${Math.round(ttlMinutes)} min).`
                : 'Cash App link generated. Share it with the customer.';
            this.creatingPaymentLink = false;
          },
          error: (err: any) => {
            this.paymentLinkError =
              err?.error?.message || err?.message || 'Failed to generate payment link';
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
        note: `Payment link for table ${this.createdReservation.tableId}`,
      })
      .subscribe({
        next: (res) => {
          const url = String(res?.square?.url ?? '').trim();
          if (!url) {
            this.paymentLinkError = 'Payment link generation succeeded but no URL was returned.';
            this.creatingPaymentLink = false;
            return;
          }
          this.paymentLinkUrl = url;
          this.paymentLinkNotice = 'Payment link generated. Share it with the customer.';
          this.creatingPaymentLink = false;
        },
        error: (err: any) => {
          this.paymentLinkError =
            err?.error?.message || err?.message || 'Failed to generate payment link';
          this.creatingPaymentLink = false;
        },
      });
  }

  copyGeneratedPaymentLink(): void {
    const url = String(this.paymentLinkUrl ?? '').trim();
    if (!url) return;
    this.writeClipboard(url).then((ok) => {
      this.paymentLinkNotice = ok
        ? 'Payment link copied.'
        : 'Copy failed. Please copy manually.';
    });
  }

  openSmsShareGenerated(): void {
    if (!this.createdReservation || !this.paymentLinkUrl) return;
    const body = this.buildShareMessage(this.createdReservation, this.paymentLinkUrl);
    const recipient = this.toSmsRecipient(this.createdReservation.phone);
    const target = recipient ? `sms:${recipient}?&body=${encodeURIComponent(body)}` : `sms:?&body=${encodeURIComponent(body)}`;
    window.open(target, '_blank');
  }

  openWhatsAppShareGenerated(): void {
    if (!this.createdReservation || !this.paymentLinkUrl) return;
    const body = this.buildShareMessage(this.createdReservation, this.paymentLinkUrl);
    const recipient = this.toWhatsAppRecipient(this.createdReservation.phone);
    const target = recipient
      ? `https://wa.me/${recipient}?text=${encodeURIComponent(body)}`
      : `https://wa.me/?text=${encodeURIComponent(body)}`;
    window.open(target, '_blank');
  }

  shareGeneratedPaymentLink(): void {
    if (!this.createdReservation || !this.paymentLinkUrl) return;
    const body = this.buildShareMessage(this.createdReservation, this.paymentLinkUrl);
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
    return this.buildShareMessage(this.createdReservation, this.paymentLinkUrl);
  }

  linkCollectionTitle(): string {
    const mode = this.currentLinkMode();
    return mode === 'client' ? 'Cash App Link' : 'Square Payment Link';
  }

  reservationActionLabel(): string {
    if (this.createdReservation) return 'Done';
    if (this.isLinkCollectionFlow()) {
      return this.currentLinkModeFromForm() === 'client'
        ? 'Confirm & Generate Cash App Link'
        : 'Confirm & Generate Link';
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
    const query = this.filterQuery.value.trim().toLowerCase();
    const status = this.filterStatus.value;
    const section = this.filterSection.value;
    return this.tables.filter((t) => {
      const matchQuery = query ? t.id.toLowerCase().includes(query) : true;
      const matchStatus = status === 'ALL' ? true : t.status === status;
      const matchSection = section === 'ALL' ? true : t.section === section;
      return matchQuery && matchStatus && matchSection;
    });
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

  setFilterStatus(
    status: 'ALL' | 'AVAILABLE' | 'HOLD' | 'PENDING_PAYMENT' | 'RESERVED' | 'DISABLED'
  ): void {
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
    const status = this.filterStatus.value;
    if (status === 'ALL') return 'All';
    if (status === 'AVAILABLE') return 'Available';
    if (status === 'HOLD') return 'Hold';
    if (status === 'PENDING_PAYMENT') return 'Pending Payment';
    if (status === 'RESERVED') return 'Reserved';
    return 'Disabled';
  }

  sectionFilterLabel(): string {
    return this.filterSection.value === 'ALL' ? 'All' : `Section ${this.filterSection.value}`;
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
    try {
      localStorage.setItem(
        this.filterStorageKey,
        JSON.stringify({
          status: this.filterStatus.value,
          section: this.filterSection.value,
        })
      );
    } catch {
      // Ignore local storage failures in restricted environments.
    }
  }

  private restoreSavedFilters(): void {
    try {
      const raw = localStorage.getItem(this.filterStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { status?: string; section?: string };
      const validStatuses = [
        'ALL',
        'AVAILABLE',
        'HOLD',
        'PENDING_PAYMENT',
        'RESERVED',
        'DISABLED',
      ];
      if (parsed.status && validStatuses.includes(parsed.status)) {
        this.filterStatus.setValue(
          parsed.status as
            | 'ALL'
            | 'AVAILABLE'
            | 'HOLD'
            | 'PENDING_PAYMENT'
            | 'RESERVED'
            | 'DISABLED'
        );
      }
      if (parsed.section) {
        this.filterSection.setValue(parsed.section);
      }
    } catch {
      // Ignore malformed saved filters.
    }
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

  private buildShareMessage(ctx: CreatedReservationContext, url: string): string {
    return `Hi ${ctx.customerName}, here is your table payment link for ${ctx.eventDate} table ${ctx.tableId}: ${url}`;
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
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
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
        this.businessDate = String(ctx?.businessDate ?? '').trim() || this.todayString();
        this.paymentDeadlineTz = String(ctx?.settings?.operatingTz ?? '').trim() || 'America/Chicago';
        this.defaultPaymentDeadlineHour = this.normalizeHour(
          ctx?.settings?.defaultPaymentDeadlineHour,
          0
        );
        this.defaultPaymentDeadlineMinute = this.normalizeMinute(
          ctx?.settings?.defaultPaymentDeadlineMinute,
          0
        );
        this.paymentDeadlineTime.setValue(this.formatHm(this.defaultPaymentDeadlineHour, this.defaultPaymentDeadlineMinute));
        this.tablePollingSeconds = this.normalizePollingSeconds(
          ctx?.settings?.tableAvailabilityPollingSeconds,
          10
        );
        this.tableSectionColors = this.normalizeSectionMapColors(ctx?.settings?.sectionMapColors);
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
        this.businessDate = this.todayString();
      },
    });
  }

  private normalizeSectionMapColors(raw: unknown): Record<string, string> {
    const fallback = {
      A: '#ec008c',
      B: '#2e3192',
      C: '#00aeef',
      D: '#f7941d',
      E: '#711411',
    };
    if (!raw || typeof raw !== 'object') return fallback;
    const isHexColor = (value: unknown): value is string =>
      /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/.test(String(value ?? '').trim());
    const value = raw as Record<string, unknown>;
    return {
      A: isHexColor(value['A']) ? String(value['A']).toLowerCase() : fallback.A,
      B: isHexColor(value['B']) ? String(value['B']).toLowerCase() : fallback.B,
      C: isHexColor(value['C']) ? String(value['C']).toLowerCase() : fallback.C,
      D: isHexColor(value['D']) ? String(value['D']).toLowerCase() : fallback.D,
      E: isHexColor(value['E']) ? String(value['E']).toLowerCase() : fallback.E,
    };
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
        const lock = this.findActiveHoldLock(items, session);
        if (!lock) {
          this.clearActiveHoldSession();
          return;
        }
        this.selectedTableId = session.tableId;
        this.selectedTable = this.tables.find((t) => t.id === session.tableId) ?? null;
        if (!this.selectedTable) return;
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
        this.holdId = session.holdId;
        this.holdExpiresAt = lock.expiresAt ?? session.holdExpiresAt ?? null;
        this.holdCreatedByMe = session.holdCreatedByMe !== false;
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

  private findActiveHoldLock(
    items: HoldLockItem[],
    session: ActiveHoldSession
  ): { expiresAt: number | null } | null {
    const now = Math.floor(Date.now() / 1000);
    for (const item of items ?? []) {
      const lockType = String(item.lockType ?? '').toUpperCase();
      if (lockType !== 'HOLD') continue;
      const holdId = String(item.holdId ?? '').trim();
      if (!holdId || holdId !== session.holdId) continue;
      const tableId = this.extractTableIdFromHoldLock(item);
      if (tableId && tableId !== session.tableId) continue;
      const expiresRaw = Number(item.expiresAt ?? 0);
      const expiresAt =
        Number.isFinite(expiresRaw) && expiresRaw > 0 ? Math.floor(expiresRaw) : null;
      if (expiresAt !== null && expiresAt <= now) continue;
      return { expiresAt };
    }
    return null;
  }

  private extractTableIdFromHoldLock(item: HoldLockItem): string | null {
    const sk = String(item?.SK ?? '').trim();
    if (!sk.startsWith('TABLE#')) return null;
    const tableId = sk.slice('TABLE#'.length).trim();
    return tableId || null;
  }

  private saveActiveHoldSessionIfNeeded(): void {
    if (!this.eventDate || !this.selectedTable?.id || !this.holdId) return;
    const session: ActiveHoldSession = {
      eventDate: this.eventDate,
      tableId: this.selectedTable.id,
      holdId: this.holdId,
      holdExpiresAt: this.holdExpiresAt ?? null,
      holdCreatedByMe: this.holdCreatedByMe,
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
    this.writeActiveHoldSession(session);
  }

  private clearActiveHoldSession(): void {
    this.activeHoldSession = null;
    try {
      localStorage.removeItem(this.holdSessionStorageKey);
    } catch {
      // Ignore local storage failures in restricted environments.
    }
  }

  private readActiveHoldSession(): ActiveHoldSession | null {
    try {
      const raw = localStorage.getItem(this.holdSessionStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<ActiveHoldSession>;
      const eventDate = String(parsed.eventDate ?? '').trim();
      const tableId = String(parsed.tableId ?? '').trim();
      const holdId = String(parsed.holdId ?? '').trim();
      if (!eventDate || !tableId || !holdId) return null;
      const phoneCountry = normalizePhoneCountry(parsed.phoneCountry);
      const paymentStatus = String(parsed.paymentStatus ?? '').trim().toUpperCase();
      const paymentMethod = String(parsed.paymentMethod ?? '').trim().toLowerCase();
      const validStatuses = ['PAID', 'PARTIAL', 'PENDING', 'COURTESY'];
      const validMethods = ['cash', 'square', 'client'];
      return {
        eventDate,
        tableId,
        holdId,
        holdExpiresAt: Number.isFinite(Number(parsed.holdExpiresAt))
          ? Number(parsed.holdExpiresAt)
          : null,
        holdCreatedByMe: parsed.holdCreatedByMe !== false,
        showReservationModal: parsed.showReservationModal !== false,
        customerName: String(parsed.customerName ?? ''),
        phone: String(parsed.phone ?? ''),
        phoneCountry,
        amountDue: Number.isFinite(Number(parsed.amountDue)) ? Number(parsed.amountDue) : 0,
        depositAmount: Number.isFinite(Number(parsed.depositAmount))
          ? Number(parsed.depositAmount)
          : 0,
        paymentStatus: (
          validStatuses.includes(paymentStatus) ? paymentStatus : 'PAID'
        ) as 'PAID' | 'PARTIAL' | 'PENDING' | 'COURTESY',
        paymentMethod: (
          validMethods.includes(paymentMethod) ? paymentMethod : 'square'
        ) as 'cash' | 'square' | 'client',
        allowCustomDeposit: parsed.allowCustomDeposit === true,
        paymentDeadlineEnabled: parsed.paymentDeadlineEnabled === true,
        paymentDeadlineDate: String(parsed.paymentDeadlineDate ?? ''),
        paymentDeadlineTime: String(parsed.paymentDeadlineTime ?? '00:00'),
        savedAt: Number.isFinite(Number(parsed.savedAt)) ? Number(parsed.savedAt) : Date.now(),
      };
    } catch {
      return null;
    }
  }

  private writeActiveHoldSession(session: ActiveHoldSession): void {
    try {
      localStorage.setItem(this.holdSessionStorageKey, JSON.stringify(session));
    } catch {
      // Ignore local storage failures in restricted environments.
    }
  }
}
