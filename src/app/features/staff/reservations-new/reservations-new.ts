import { Component, OnInit, OnDestroy, inject } from '@angular/core';
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

@Component({
  selector: 'app-reservations-new',
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './reservations-new.html',
  styleUrl: './reservations-new.scss',
})
export class ReservationsNew implements OnInit, OnDestroy {
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
  filterStatus = new FormControl<'ALL' | 'AVAILABLE' | 'HOLD' | 'RESERVED' | 'DISABLED'>('ALL', {
    nonNullable: true,
  });
  filterSection = new FormControl<string>('ALL', { nonNullable: true });
  pastFilterDate = new FormControl('', { nonNullable: true });
  pastFilterName = new FormControl('', { nonNullable: true });
  onlyAvailable = false;
  clientMatches: CrmClient[] = [];
  clientLoading = false;
  noClientMatch = false;
  exactMatchPhone: string | null = null;

  ngOnInit(): void {
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
      if (status === 'PAID') {
        this.form.controls.depositAmount.setValue(value, { emitEvent: false });
      }
      if (status === 'COURTESY') {
        this.form.controls.amountDue.setValue(0, { emitEvent: false });
        this.form.controls.depositAmount.setValue(0, { emitEvent: false });
      }
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
            (m) => this.normalizePhone(m.phone) === entered && entered.length >= 10
          );
          this.exactMatchPhone = exact ? this.normalizePhone(exact.phone) : null;
          this.clientMatches = matches;
          this.noClientMatch = entered.length >= 10 && matches.length === 0;
          this.clientLoading = false;
          if (exact) {
            this.form.controls.customerName.setValue(exact.name || '');
            this.form.controls.phone.setValue(exact.phone || entered);
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
    this.stopPolling();
    this.clearHoldTimer();
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
    this.pollSub = interval(15000).subscribe(() => {
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
  }

  clearEventSelection(): void {
    this.eventDate = null;
    this.event = null;
    this.tables = [];
    this.selectedTable = null;
    this.holdId = null;
    this.showPastModal = false;
    this.showReservationModal = false;
    this.filterSection.setValue('ALL', { emitEvent: false });
    this.filterStatus.setValue('ALL', { emitEvent: false });
    this.onlyAvailable = false;
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
    this.holdId = null;
    this.holdExpiresAt = null;
    this.holdCountdown = 0;
    this.clearHoldTimer();
    this.allowCustomDeposit = false;
    const price = t.price ?? 0;
    this.form.controls.amountDue.setValue(price);
    this.form.controls.depositAmount.setValue(price);
    this.form.controls.paymentStatus.setValue('PAID');
    this.paymentDeadlineEnabled = false;
    if (this.eventDate) this.paymentDeadlineDate.setValue(this.eventDate);
  }

  startHoldFlow(): void {
    if (!this.eventDate || !this.selectedTable) return;
    this.createHold(true);
  }

  createHold(openModal = false): void {
    if (!this.eventDate || !this.selectedTable) return;
    this.loading = true;
    this.error = null;
    this.holdsApi
      .createHold({
        eventDate: this.eventDate,
        tableId: this.selectedTable.id,
        customerName: this.form.controls.customerName.value,
        phone: this.form.controls.phone.value,
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
    if (!this.eventDate || !this.selectedTable || !this.holdId) return;
    if (this.form.invalid) return;
    this.loading = true;
    this.error = null;
    const depositAmount = this.form.controls.depositAmount.value;
    const amountDue = this.form.controls.amountDue.value;
    const paymentStatus = this.form.controls.paymentStatus.value;
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
    }
    this.reservationsApi
      .create({
        eventDate: this.eventDate,
        tableId: this.selectedTable.id,
        holdId: this.holdId,
        customerName: this.form.controls.customerName.value,
        phone: this.form.controls.phone.value,
        depositAmount,
        amountDue,
        paymentStatus,
        paymentMethod: this.form.controls.paymentMethod.value,
        paymentDeadlineAt,
        paymentDeadlineTz: needsDeadline ? this.paymentDeadlineTz : null,
      })
      .subscribe({
        next: () => {
          this.holdId = null;
          this.holdExpiresAt = null;
          this.holdCountdown = 0;
          this.clearHoldTimer();
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
          this.loadTables(this.eventDate!);
          this.loading = false;
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
    this.showReservationModal = true;
  }

  closeReservationModal(): void {
    this.showReservationModal = false;
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
      if (this.eventDate) this.paymentDeadlineDate.setValue(this.eventDate);
      return;
    }
    // PARTIAL: leave deposit editable
    this.allowCustomDeposit = true;
    this.paymentDeadlineEnabled = true;
    if (this.eventDate) this.paymentDeadlineDate.setValue(this.eventDate);
  }

  isExactMatch(client: CrmClient): boolean {
    if (!client) return false;
    const phone = this.normalizePhone(client.phone);
    return !!this.exactMatchPhone && phone === this.exactMatchPhone;
  }

  private normalizePhone(value: string | null | undefined): string {
    return String(value ?? '').replace(/\D/g, '');
  }

  filteredTables(): TableForEvent[] {
    const query = this.filterQuery.value.trim().toLowerCase();
    const status = this.onlyAvailable ? 'AVAILABLE' : this.filterStatus.value;
    const section = this.filterSection.value;
    return this.tables.filter((t) => {
      const matchQuery = query ? t.id.toLowerCase().includes(query) : true;
      const matchStatus = status === 'ALL' ? true : t.status === status;
      const matchSection = section === 'ALL' ? true : t.section === section;
      return matchQuery && matchStatus && matchSection;
    });
  }

  toggleOnlyAvailable(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.onlyAvailable = checked;
    if (checked && this.filterStatus.value !== 'AVAILABLE') {
      this.filterStatus.setValue('AVAILABLE');
    }
  }

  tableCounts(): { total: number; available: number; hold: number; reserved: number; disabled: number } {
    const counts = { total: this.tables.length, available: 0, hold: 0, reserved: 0, disabled: 0 };
    for (const t of this.tables) {
      if (t.status === 'AVAILABLE') counts.available += 1;
      if (t.status === 'HOLD') counts.hold += 1;
      if (t.status === 'RESERVED') counts.reserved += 1;
      if (t.status === 'DISABLED') counts.disabled += 1;
    }
    return counts;
  }
}
