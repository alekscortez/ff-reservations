import { Component, OnInit, OnDestroy, DoCheck, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TablesService } from '../../../core/http/tables.service';
import { HoldsService } from '../../../core/http/holds.service';
import { ReservationsService } from '../../../core/http/reservations.service';
import { TableForEvent } from '../../../shared/models/table.model';
import { EventItem } from '../../../shared/models/event.model';
import { ClientsService } from '../../../core/http/clients.service';
import { CrmClient } from '../../../shared/models/client.model';
import { debounceTime, distinctUntilChanged, interval, of, Subscription, switchMap } from 'rxjs';
import { EventsService } from '../../../core/http/events.service';
import {
  inferPhoneCountryFromE164,
  normalizePhoneCountry,
  normalizePhoneToE164,
} from '../../../shared/phone';
import { PhoneDisplayPipe } from '../../../shared/phone-display.pipe';

interface CreatedReservationContext {
  reservationId: string;
  eventDate: string;
  tableId: string;
  customerName: string;
  phone: string;
  amount: number;
}

@Component({
  selector: 'app-reservations-new',
  imports: [CommonModule, ReactiveFormsModule, PhoneDisplayPipe],
  templateUrl: './reservations-new.html',
  styleUrl: './reservations-new.scss',
})
export class ReservationsNew implements OnInit, OnDestroy, DoCheck {
  private readonly filterStorageKey = 'ff_new_res_filters_v1';
  private readonly sidebarModalLockClass = 'reservations-new-modal-open';
  private sidebarModalLockActive = false;
  private route = inject(ActivatedRoute);
  private eventsApi = inject(EventsService);
  private tablesApi = inject(TablesService);
  private holdsApi = inject(HoldsService);
  private reservationsApi = inject(ReservationsService);
  private clientsApi = inject(ClientsService);

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

  form = new FormGroup({
    customerName: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    depositAmount: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    amountDue: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] }),
    paymentStatus: new FormControl<'PAID' | 'PARTIAL' | 'PENDING' | 'COURTESY'>('PAID', {
      nonNullable: true,
    }),
    paymentMethod: new FormControl<'cash' | 'cashapp' | 'square'>('cash', {
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
  showFiltersPanel = false;
  phoneCountry: 'US' | 'MX' = 'US';
  pastFilterDate = new FormControl('', { nonNullable: true });
  pastFilterName = new FormControl('', { nonNullable: true });
  clientMatches: CrmClient[] = [];
  clientLoading = false;
  noClientMatch = false;
  exactMatchPhone: string | null = null;
  creatingPaymentLink = false;
  paymentLinkError: string | null = null;
  paymentLinkNotice: string | null = null;
  paymentLinkUrl: string | null = null;
  createdReservation: CreatedReservationContext | null = null;

  ngOnInit(): void {
    this.restoreSavedFilters();
    this.route.queryParamMap.subscribe((params) => {
      this.eventDate = params.get('date');
      if (this.eventDate) {
        this.loadTables(this.eventDate);
        this.startPolling();
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
        },
        error: () => {
          this.clientMatches = [];
          this.noClientMatch = false;
          this.exactMatchPhone = null;
          this.clientLoading = false;
        },
      });
  }

  ngOnDestroy(): void {
    this.syncSidebarModalLock(true);
    this.stopPolling();
    this.clearHoldTimer();
  }

  ngDoCheck(): void {
    this.syncSidebarModalLock();
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
        if (!silent) this.loading = false;
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
    if (this.pollSub) return;
    this.pollSub = interval(10000).subscribe(() => {
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
    this.eventDate = null;
    this.event = null;
    this.tables = [];
    this.selectedTable = null;
    this.holdId = null;
    this.showPastModal = false;
    this.showReservationModal = false;
    this.showFiltersPanel = false;
    this.stopPolling();
  }

  upcomingEvents(): EventItem[] {
    const today = this.todayString();
    return this.events
      .filter((e) => (e.eventDate || '') >= today)
      .slice(0, 4);
  }

  pastEvents(): EventItem[] {
    const today = this.todayString();
    const dateFilter = this.pastFilterDate.value.trim();
    const nameFilter = this.pastFilterName.value.trim().toLowerCase();
    return this.events
      .filter((e) => (e.eventDate || '') < today)
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
    this.selectedTable = t;
    this.selectedTableId = t.id;
    this.resetCreatedReservationState();
    this.holdId = null;
    this.holdExpiresAt = null;
    this.holdCountdown = 0;
    this.clearHoldTimer();
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
          this.startHoldTimer();
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
    const phone = normalizePhoneToE164(
      this.form.controls.phone.value,
      normalizePhoneCountry(this.phoneCountry)
    );
    if (!phone) {
      this.error = 'Phone must be a valid US or MX number.';
      this.loading = false;
      return;
    }
    const needsDeadline = paymentStatus === 'PENDING' || paymentStatus === 'PARTIAL';
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
        depositAmount,
        amountDue,
        paymentStatus,
        paymentMethod,
        paymentDeadlineAt,
        paymentDeadlineTz: needsDeadline ? this.paymentDeadlineTz : null,
      })
      .subscribe({
        next: (created) => {
          const createdItem = created?.item;
          const autoSquareLinkSms = created?.autoSquareLinkSms;
          this.holdId = null;
          this.holdExpiresAt = null;
          this.holdCountdown = 0;
          this.clearHoldTimer();
          this.holdCreatedByMe = false;
          this.showReleaseConfirm = false;
          this.loadTables(this.eventDate!);

          if (paymentMethod === 'square') {
            if (autoSquareLinkSms?.sent) {
              this.loading = false;
              this.finishReservationFlow();
              return;
            }
            this.createdReservation = {
              reservationId: String(createdItem?.reservationId ?? ''),
              eventDate: this.eventDate!,
              tableId: this.selectedTable!.id,
              customerName: this.form.controls.customerName.value,
              phone,
              amount: amountDue,
            };
            if (!this.createdReservation.reservationId) {
              this.error = 'Reservation created but reservation id was missing.';
              this.loading = false;
              return;
            }
            this.loading = false;
            this.generateSquarePaymentLink();
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
  }

  closeReservationModal(): void {
    if (this.createdReservation) {
      this.finishReservationFlow();
      return;
    }
    if (this.holdId && this.holdCreatedByMe) {
      this.showReleaseConfirm = true;
      return;
    }
    this.showReservationModal = false;
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
    this.paymentDeadlineTime.setValue('00:00');
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

  paymentMethodButtons(): Array<{ value: 'cash' | 'cashapp' | 'square'; label: string }> {
    return [
      { value: 'cash', label: 'Cash' },
      { value: 'cashapp', label: 'Cash App' },
      { value: 'square', label: 'Square' },
    ];
  }

  isPaymentMethod(value: 'cash' | 'cashapp' | 'square'): boolean {
    return this.form.controls.paymentMethod.value === value;
  }

  setPaymentMethod(value: 'cash' | 'cashapp' | 'square'): void {
    this.form.controls.paymentMethod.setValue(value);
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

  generateSquarePaymentLink(): void {
    if (!this.createdReservation) return;
    if (!this.isSquareMethod()) return;
    if (this.creatingPaymentLink) return;

    this.creatingPaymentLink = true;
    this.paymentLinkError = null;
    this.paymentLinkNotice = null;

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
        error: (err) => {
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

  reservationActionLabel(): string {
    if (this.createdReservation) return 'Done';
    if (this.isSquareMethod()) return 'Confirm & Generate Link';
    return 'Confirm Reservation';
  }

  reservationActionDisabled(): boolean {
    if (this.createdReservation) return this.loading || this.creatingPaymentLink;
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
      paymentMethod: 'cash',
    });
    this.phoneCountry = 'US';
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
}
