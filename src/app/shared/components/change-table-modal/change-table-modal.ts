import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';

import { TableLabelPipe, formatTableLabel } from '../../table-label.pipe';
import { HlmAlert } from '../../ui/alert';
import { HlmButton } from '../../ui/button';
import { HlmDialog } from '../../ui/dialog';
import { HlmInput } from '../../ui/input';
import { HlmToggle } from '../../ui/toggle';
import { RescheduleCredit } from '../../../core/http/clients.service';
import { HoldsService } from '../../../core/http/holds.service';
import type { ReservationItem } from '../../models/reservation.model';
import type { TableForEvent } from '../../models/table.model';
import { TableMap } from '../table-map/table-map';

/**
 * Bundled-payment methods (delta > 0): instant settlement, ride along
 * in the same atomic transaction as the swap.
 */
export type ChangeTablePaymentMethod = 'cash' | 'credit';

/**
 * Async-settlement methods (delta > 0): the swap commits without a
 * bundled payment (reservation drops to PARTIAL); the parent chains
 * into the take-payment modal pre-loaded for this method + amount =
 * delta. Phase 2 only adds Card on Stand; the other two are wired
 * through the backend but the modal doesn't surface them yet.
 */
export type DeferredPaymentMethod = 'square_stand' | 'square' | 'cashapp';

export type OverpaymentResolution = 'CREDIT' | 'REFUND' | 'LEAVE';

export interface ChangeTableConfirmPayload {
  newTableIds: string[];
  newHoldsByTableId: Record<string, string>;
  expectedTablePriceTotal: number;
  reason: string;
  payment?: {
    method: ChangeTablePaymentMethod;
    amount: number;
    creditId?: string;
    receiptNumber?: string;
    note?: string;
  };
  deferredPaymentMethod?: DeferredPaymentMethod;
  overpaymentResolution?: OverpaymentResolution;
}

/**
 * Staff-only "Change Tables" modal. Two internal steps:
 *
 *   1. Pick: TableMap + selection summary + price delta. For delta < 0
 *      also shows the overpayment resolution radios. Confirm advances
 *      to step 2 when delta > 0; otherwise emits (confirm) directly.
 *   2. Pay: only when delta > 0. Cash or credit subset of the take-
 *      payment form, amount locked to the delta. Submit emits (confirm)
 *      with the bundled payment field set.
 *
 * Owns the hold lifecycle: createHold on each new tile click, release
 * it on toggle-off OR modal cancel. After a successful (confirm) the
 * parent dismisses the modal via *ngIf; we don't release in that path
 * because those holds were just upgraded to RESERVED server-side.
 */
@Component({
  selector: 'change-table-modal',
  standalone: true,
  imports: [
    CommonModule,
    NgIcon,
    ReactiveFormsModule,
    TableLabelPipe,
    HlmAlert,
    HlmButton,
    HlmDialog,
    HlmInput,
    HlmToggle,
    TableMap,
  ],
  providers: [provideIcons({ lucideX })],
  templateUrl: './change-table-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangeTableModal implements OnChanges, OnDestroy {
  @Input({ required: true }) reservation!: ReservationItem;
  @Input() tables: TableForEvent[] = [];
  @Input() tablesLoading = false;
  @Input() tablesError: string | null = null;
  @Input() availableCredits: RescheduleCredit[] = [];
  @Input() creditsLoading = false;
  @Input() creditsError: string | null = null;
  @Input() cashReceiptRequired = true;
  /** Surface backend 409s / 502s here. Parent flips back to null when the user clears the error. */
  @Input() submitError: string | null = null;
  @Input() submitLoading = false;
  /** Section color map; mirrors reservations-new. Optional. */
  @Input() sectionColors: Partial<Record<string, string>> = {
    A: '#ec008c',
    B: '#2e3192',
    C: '#00aeef',
    D: '#f7941d',
    E: '#711411',
  };

  @Output() confirm = new EventEmitter<ChangeTableConfirmPayload>();
  @Output() close = new EventEmitter<void>();

  private holdsApi = inject(HoldsService);
  private destroyRef = inject(DestroyRef);

  readonly step = signal<'pick' | 'pay'>('pick');
  readonly selectedIds = signal<string[]>([]);
  // tableId -> holdId for tiles we acquired in this session.
  // Tables already in the reservation (kept) never enter this map.
  readonly newHoldsByTableId = signal<Record<string, string>>({});
  // Mid-flight hold create/release on a specific tile. Used to disable
  // re-clicks and show a subtle loading state.
  readonly tilesBusy = signal<Set<string>>(new Set());
  readonly holdError = signal<string | null>(null);

  readonly overpayResolution = signal<OverpaymentResolution>('CREDIT');
  readonly currentTableIds = signal<string[]>([]);
  readonly currentTablePrice = signal<number>(0);
  readonly currentAmountDue = signal<number>(0);
  readonly currentDeposit = signal<number>(0);

  // Inputs that change after init must be mirrored into signals so the
  // computed graph re-runs on update. Reading `this.tables` (a plain
  // @Input field) inside a computed only captures its value at first
  // run, then sticks — selecting a tile that arrived in a later
  // `[tables]` update would see an empty map and price as $0. ngOnChanges
  // keeps these in sync.
  private readonly tablesSignal = signal<TableForEvent[]>([]);
  private readonly availableCreditsSignal = signal<RescheduleCredit[]>([]);
  private readonly reservationSignal = signal<ReservationItem | null>(null);

  // Payment form for the bundled delta payment (Step 2). Mirrors the
  // cash/credit subset of <take-payment-modal>'s form, plus 'square_stand'
  // for the deferred-payment path (commits the swap, then the parent
  // opens the take-payment modal with Card on Stand pre-selected).
  readonly form = new FormGroup({
    method: new FormControl<ChangeTablePaymentMethod | DeferredPaymentMethod>(
      'cash',
      { nonNullable: true },
    ),
    creditId: new FormControl('', { nonNullable: true }),
    receiptNumber: new FormControl('', { nonNullable: true }),
    note: new FormControl('', { nonNullable: true }),
    reason: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(3)],
    }),
  });

  readonly submitAttempted = signal(false);
  readonly methodSignal = signal<ChangeTablePaymentMethod | DeferredPaymentMethod>('cash');
  readonly creditIdSignal = signal<string>('');

  private readonly tableById = computed<Map<string, TableForEvent>>(() => {
    const map = new Map<string, TableForEvent>();
    for (const t of this.tablesSignal() ?? []) {
      map.set(t.id, t);
    }
    return map;
  });

  readonly newTablesSorted = computed<TableForEvent[]>(() => {
    const map = this.tableById();
    const ids = this.selectedIds();
    return ids
      .map((id) => map.get(id))
      .filter((t): t is TableForEvent => Boolean(t))
      .sort((a, b) => a.id.localeCompare(b.id));
  });

  readonly currentTablesSorted = computed<TableForEvent[]>(() => {
    const map = this.tableById();
    return this.currentTableIds()
      .map((id) => map.get(id))
      .filter((t): t is TableForEvent => Boolean(t))
      .sort((a, b) => a.id.localeCompare(b.id));
  });

  readonly newTablePriceTotal = computed<number>(() => {
    let sum = 0;
    for (const t of this.newTablesSorted()) sum += Number(t.price ?? 0);
    return Number(sum.toFixed(2));
  });

  readonly delta = computed<number>(() =>
    Number((this.newTablePriceTotal() - this.currentTablePrice()).toFixed(2)),
  );

  readonly newAmountDue = computed<number>(() =>
    Number((this.currentAmountDue() + this.delta()).toFixed(2)),
  );

  // Surplus only matters when delta < 0 AND the customer is already
  // overpaid against the new amount. Otherwise no overpayment action
  // is needed even though delta is negative.
  readonly surplus = computed<number>(() => {
    if (this.delta() >= 0) return 0;
    return Number(Math.max(0, this.currentDeposit() - this.newAmountDue()).toFixed(2));
  });

  // The selection is identical to the current set: confirm is disabled.
  readonly isNoChange = computed<boolean>(() => {
    const current = new Set(this.currentTableIds());
    const next = this.selectedIds();
    if (current.size !== next.length) return false;
    for (const id of next) if (!current.has(id)) return false;
    return true;
  });

  readonly addedTableIds = computed<string[]>(() => {
    const current = new Set(this.currentTableIds());
    return this.selectedIds().filter((id) => !current.has(id));
  });

  readonly removedTableIds = computed<string[]>(() => {
    const next = new Set(this.selectedIds());
    return this.currentTableIds().filter((id) => !next.has(id));
  });

  // For map rendering: tiles already in reservation render as "kept"
  // (selection ring, can be toggled off). Tiles freshly added also
  // get the selection ring. Pass both sets via the existing
  // selectedTableIds input.
  readonly mapSelectedIds = computed<string[]>(() => [...this.selectedIds()]);

  // Eligibility flag for refund-vs-credit. Refund is only an option
  // when there's a Square payment with a providerPaymentId on the
  // reservation; otherwise we hide the option.
  readonly canPartialRefund = computed<boolean>(() => {
    const r = this.reservationSignal();
    const payments = Array.isArray(r?.payments) ? r.payments : [];
    return payments.some((p: any) => {
      const method = String(p?.method ?? '').trim().toLowerCase();
      const providerPaymentId = String(p?.provider?.providerPaymentId ?? '').trim();
      return method === 'square' && Boolean(providerPaymentId);
    });
  });

  readonly selectedCredit = computed<RescheduleCredit | null>(() => {
    const id = this.creditIdSignal();
    if (!id) return null;
    return this.availableCreditsSignal().find((c) => c.creditId === id) ?? null;
  });

  readonly isCreditMethod = computed(() => this.methodSignal() === 'credit');
  readonly isCashMethod = computed(() => this.methodSignal() === 'cash');
  // 'square_stand' (and future 'square' / 'cashapp') don't bundle into
  // the swap transaction — the parent handles the chained payment via
  // <take-payment-modal>. The button label + payload shape change.
  readonly isDeferredMethod = computed(() => {
    const m = this.methodSignal();
    return m === 'square_stand' || m === 'square' || m === 'cashapp';
  });

  readonly creditAffordsDelta = computed<boolean>(() => {
    if (!this.isCreditMethod()) return true;
    const credit = this.selectedCredit();
    if (!credit) return false;
    return Number(credit.amountRemaining ?? 0) >= this.delta();
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['reservation'] && this.reservation) {
      this.reservationSignal.set(this.reservation);
      this.resetFromReservation();
    }
    if (changes['tables']) {
      this.tablesSignal.set(this.tables ?? []);
    }
    if (changes['availableCredits']) {
      this.availableCreditsSignal.set(this.availableCredits ?? []);
    }
  }

  ngOnDestroy(): void {
    // Component teardown: release every hold we acquired. This covers
    // the "user closed the tab" or "navigated away" path. The
    // explicit (close) path goes through onClose() and also releases.
    this.releaseAllPendingHoldsBestEffort();
  }

  onClose(): void {
    this.releaseAllPendingHoldsBestEffort();
    this.close.emit();
  }

  back(): void {
    this.step.set('pick');
  }

  onTableSelect(table: TableForEvent): void {
    const id = String(table?.id ?? '').trim();
    if (!id) return;
    const isSelected = this.selectedIds().includes(id);
    const wasOriginallyOnReservation = this.currentTableIds().includes(id);
    if (this.tilesBusy().has(id)) return;

    if (isSelected) {
      // Toggling off
      if (wasOriginallyOnReservation) {
        // Just remove from selection (no hold to release; it's RESERVED).
        this.selectedIds.update((ids) => ids.filter((x) => x !== id));
        return;
      }
      const holdId = this.newHoldsByTableId()[id];
      if (!holdId) {
        // Defensive: no hold tracked; just drop the selection.
        this.selectedIds.update((ids) => ids.filter((x) => x !== id));
        return;
      }
      this.markTileBusy(id, true);
      this.holdsApi
        .releaseHold(this.reservation.eventDate, id)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            this.markTileBusy(id, false);
            this.newHoldsByTableId.update((map) => {
              const copy = { ...map };
              delete copy[id];
              return copy;
            });
            this.selectedIds.update((ids) => ids.filter((x) => x !== id));
          },
          error: (err) => {
            this.markTileBusy(id, false);
            this.holdError.set(
              err?.error?.message ||
                err?.message ||
                `Could not release hold on table ${id}.`,
            );
          },
        });
      return;
    }

    // Toggling on
    if (wasOriginallyOnReservation) {
      // Re-add a kept table that was just removed. No hold needed.
      this.selectedIds.update((ids) => [...ids, id]);
      return;
    }
    // New addition: acquire a hold first.
    if (this.selectedIds().length >= 10) {
      this.holdError.set('Cannot reserve more than 10 tables in one booking.');
      return;
    }
    this.markTileBusy(id, true);
    this.holdsApi
      .createHold({
        eventDate: this.reservation.eventDate,
        tableId: id,
        customerName: this.reservation.customerName,
        phone: this.reservation.phone,
        phoneCountry: this.resolvePhoneCountry(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (item: any) => {
          this.markTileBusy(id, false);
          const holdId = String(item?.holdId ?? '').trim();
          if (!holdId) {
            this.holdError.set(`Hold succeeded but no holdId returned for ${id}.`);
            return;
          }
          this.newHoldsByTableId.update((map) => ({ ...map, [id]: holdId }));
          this.selectedIds.update((ids) => [...ids, id]);
          this.holdError.set(null);
        },
        error: (err) => {
          this.markTileBusy(id, false);
          const msg =
            err?.error?.message ||
            err?.message ||
            `Could not hold table ${id}. It may have just been claimed.`;
          this.holdError.set(msg);
        },
      });
  }

  setOverpayResolution(value: OverpaymentResolution): void {
    this.overpayResolution.set(value);
  }

  onMethodChange(next: ChangeTablePaymentMethod | DeferredPaymentMethod): void {
    this.methodSignal.set(next);
    this.form.controls.method.setValue(next);
    if (next !== 'credit') {
      this.form.controls.creditId.setValue('');
      this.creditIdSignal.set('');
    }
    if (next !== 'cash') {
      this.form.controls.receiptNumber.setValue('');
    }
    // Auto-select the only credit when switching to credit
    if (next === 'credit' && !this.creditIdSignal() && this.availableCredits.length === 1) {
      const id = this.availableCredits[0].creditId;
      this.form.controls.creditId.setValue(id);
      this.creditIdSignal.set(id);
    }
  }

  onCreditChange(next: string | Event): void {
    const raw =
      typeof next === 'string'
        ? next
        : String(((next as Event).target as HTMLSelectElement | null)?.value ?? '');
    this.creditIdSignal.set(raw);
    this.form.controls.creditId.setValue(raw);
  }

  onReceiptInput(): void {
    const raw = String(this.form.controls.receiptNumber.value ?? '');
    const digitsOnly = raw.replace(/\D+/g, '').slice(0, 64);
    if (digitsOnly !== this.form.controls.receiptNumber.value) {
      this.form.controls.receiptNumber.setValue(digitsOnly, { emitEvent: false });
    }
  }

  primaryButtonDisabled(): boolean {
    if (this.submitLoading) return true;
    if (this.tilesBusy().size > 0) return true;
    if (this.selectedIds().length === 0) return true;
    if (this.isNoChange()) return true;
    if (this.step() === 'pick') {
      if (!this.form.controls.reason.valid) return true;
      return false;
    }
    // Step 2: collecting payment
    if (this.delta() <= 0) return true;
    if (this.isCashMethod() && this.cashReceiptRequired) {
      if (!this.normalizedReceipt()) return true;
    }
    if (this.isCreditMethod()) {
      if (!this.creditIdSignal()) return true;
      if (!this.creditAffordsDelta()) return true;
    }
    // Deferred methods (Card on Stand etc.) need no extra input —
    // confirming kicks off the swap, then the parent opens the take-
    // payment modal for the actual settlement step.
    return false;
  }

  primaryButtonLabel(): string {
    if (this.submitLoading) return 'Saving…';
    const delta = this.delta();
    if (this.step() === 'pick') {
      if (delta > 0) return `Continue to payment ($${delta.toFixed(2)}) →`;
      if (delta < 0) {
        const surplus = this.surplus();
        if (surplus <= 0) return 'Confirm change';
        if (this.overpayResolution() === 'CREDIT') {
          return `Confirm + issue $${surplus.toFixed(2)} credit`;
        }
        if (this.overpayResolution() === 'REFUND') {
          return `Confirm + refund $${surplus.toFixed(2)}`;
        }
        return `Confirm change (overpay $${surplus.toFixed(2)} logged)`;
      }
      return 'Confirm change';
    }
    // Step 2
    if (this.isCreditMethod()) {
      return `Apply credit + change tables`;
    }
    if (this.methodSignal() === 'square_stand') {
      return `Confirm swap → Card on Stand ($${delta.toFixed(2)})`;
    }
    if (this.methodSignal() === 'square') {
      return `Confirm swap → Square link ($${delta.toFixed(2)})`;
    }
    if (this.methodSignal() === 'cashapp') {
      return `Confirm swap → Cash App QR ($${delta.toFixed(2)})`;
    }
    return `Collect $${delta.toFixed(2)} + change tables`;
  }

  onPrimary(): void {
    this.submitAttempted.set(true);
    if (this.primaryButtonDisabled()) return;
    const delta = this.delta();
    if (this.step() === 'pick' && delta > 0) {
      // Move to the payment step. Pre-fill amount visual = delta.
      this.step.set('pay');
      return;
    }
    this.emitConfirm();
  }

  private emitConfirm(): void {
    const reason = String(this.form.controls.reason.value ?? '').trim();
    const payload: ChangeTableConfirmPayload = {
      newTableIds: [...this.selectedIds()].sort((a, b) => a.localeCompare(b)),
      newHoldsByTableId: { ...this.newHoldsByTableId() },
      expectedTablePriceTotal: this.newTablePriceTotal(),
      reason,
    };
    const delta = this.delta();
    if (delta > 0) {
      const method = this.methodSignal();
      if (method === 'square_stand' || method === 'square' || method === 'cashapp') {
        // Deferred-settlement: swap commits without bundled payment.
        // Parent chains into the take-payment modal pre-loaded for
        // this method + amount = delta.
        payload.deferredPaymentMethod = method;
      } else {
        payload.payment = {
          method: method as ChangeTablePaymentMethod,
          amount: delta,
          creditId: method === 'credit' ? this.creditIdSignal() : undefined,
          receiptNumber:
            method === 'cash' && this.normalizedReceipt()
              ? this.normalizedReceipt()
              : undefined,
          note: String(this.form.controls.note.value ?? '').trim() || undefined,
        };
      }
    } else if (delta < 0) {
      payload.overpaymentResolution = this.overpayResolution();
    }
    // IMPORTANT: caller's success path closes the modal via *ngIf;
    // we do NOT release holds here because they've been upgraded
    // to RESERVED by the backend transaction. On failure the parent
    // re-shows the modal and the holdsByTableId map is preserved.
    this.confirm.emit(payload);
  }

  formatNewSummary(): string {
    return formatTableLabel({ tableIds: this.selectedIds() });
  }

  formatCurrentSummary(): string {
    return formatTableLabel({ tableIds: this.currentTableIds() });
  }

  isTileBusy(id: string): boolean {
    return this.tilesBusy().has(id);
  }

  creditOptionLabel(credit: RescheduleCredit): string {
    const remaining = Number(credit.amountRemaining ?? 0).toFixed(2);
    const expires = String(credit.expiresAt ?? '').trim();
    return expires ? `$${remaining} remaining · Expires ${expires}` : `$${remaining} remaining`;
  }

  private normalizedReceipt(): string {
    return String(this.form.controls.receiptNumber.value ?? '')
      .replace(/\D+/g, '')
      .trim();
  }

  private markTileBusy(id: string, busy: boolean): void {
    this.tilesBusy.update((s) => {
      const next = new Set(s);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private releaseAllPendingHoldsBestEffort(): void {
    const map = this.newHoldsByTableId();
    const ids = Object.keys(map);
    if (ids.length === 0) return;
    const eventDate = this.reservation?.eventDate;
    if (!eventDate) return;
    // Fire-and-forget cleanup. Do NOT pipe takeUntilDestroyed here —
    // onClose() / ngOnDestroy() trigger component teardown almost
    // immediately, which would cancel the in-flight XHR before the
    // request even left the browser. HttpClient subscriptions complete
    // on their own when the response lands; there's no leak risk.
    for (const id of ids) {
      this.holdsApi
        .releaseHold(eventDate, id)
        .subscribe({ next: () => {}, error: () => {} });
    }
    this.newHoldsByTableId.set({});
  }

  private resetFromReservation(): void {
    const r = this.reservation;
    const tableIds: string[] = Array.isArray(r?.tableIds) && r.tableIds.length > 0
      ? r.tableIds.map((x) => String(x ?? '').trim()).filter(Boolean)
      : r?.tableId
        ? [String(r.tableId).trim()]
        : [];
    const tablePrice = Number(r?.tablePrice ?? 0);
    const amountDue = Number(r?.amountDue ?? 0);
    const deposit = Number(r?.depositAmount ?? 0);
    this.currentTableIds.set(tableIds);
    this.currentTablePrice.set(Number(tablePrice.toFixed(2)));
    this.currentAmountDue.set(Number(amountDue.toFixed(2)));
    this.currentDeposit.set(Number(deposit.toFixed(2)));
    this.selectedIds.set([...tableIds]);
    this.newHoldsByTableId.set({});
    this.tilesBusy.set(new Set());
    this.holdError.set(null);
    this.overpayResolution.set('CREDIT');
    this.step.set('pick');
    this.submitAttempted.set(false);
    this.methodSignal.set('cash');
    this.creditIdSignal.set('');
    this.form.reset({
      method: 'cash',
      creditId: '',
      receiptNumber: '',
      note: '',
      reason: '',
    });
  }

  private resolvePhoneCountry(): 'US' | 'MX' {
    const value = String(this.reservation?.phoneCountry ?? 'US').trim().toUpperCase();
    return value === 'MX' ? 'MX' : 'US';
  }
}
