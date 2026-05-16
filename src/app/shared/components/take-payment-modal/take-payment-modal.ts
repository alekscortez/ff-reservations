import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  computed,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';

import { TableLabelPipe, formatTableLabel, formatTableLabelLower } from '../../table-label.pipe';
import { HlmAlert } from '../../ui/alert';
import { HlmButton } from '../../ui/button';
import { HlmDialog } from '../../ui/dialog';
import { HlmInput } from '../../ui/input';
import { HlmNativeSelect } from '../../ui/native-select';
import { PaymentMethod, ReservationItem } from '../../models/reservation.model';
import { CashAppQrPad } from '../cash-app-qr-pad/cash-app-qr-pad';
import { RescheduleCredit } from '../../../core/http/clients.service';

export interface RecordPaymentPayload {
  method: 'cash' | 'credit';
  amount: number;
  creditId: string;
  remainingMethod: 'cash' | 'square';
  receiptNumber: string;
  note: string;
}

export interface SquareLinkRequestPayload {
  amount: number;
  note: string;
}

export interface CashAppTokenizedPayload {
  sourceId: string;
  amount: number;
  note: string;
}

/**
 * Shared "Take Payment" modal used by the staff Dashboard and the
 * staff Reservations page. Owns the form state, the Cash App QR
 * pad lifecycle, and all UI logic; the parent owns the actual
 * service calls (addPayment, createSquarePaymentLink, etc.).
 *
 * Parents pass the target reservation + the credit availability
 * snapshot, then react to one of three outputs:
 *   - (recordPayment) — cash or credit (with optional remainder)
 *   - (requestSquareLink) — method=square, generate a Square link
 *   - (cashAppTokenized) — method=cashapp, Square Web Payments SDK
 *     produced a token; parent posts /reservations/{id}/payment/square
 *
 * Closing the modal is owned by the parent via *ngIf — this
 * component just emits (close) on the X button / dialog dismiss.
 */
@Component({
  selector: 'take-payment-modal',
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
    HlmNativeSelect,
    CashAppQrPad,
  ],
  providers: [provideIcons({ lucideX })],
  templateUrl: './take-payment-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TakePaymentModal implements OnChanges, OnDestroy {
  @Input({ required: true }) reservation!: ReservationItem;
  @Input() cashReceiptRequired = true;
  @Input() squareEnvMode: 'sandbox' | 'production' = 'sandbox';
  @Input() squareApplicationId = '';
  @Input() squareLocationId = '';
  @Input() availableCredits: RescheduleCredit[] = [];
  @Input() creditsLoading = false;
  @Input() creditsError: string | null = null;
  @Input() loading = false;
  @Input() error: string | null = null;
  @Input() squareLinkLoading = false;
  @Input() cashAppSuccess = false;
  @Input() defaultMethod: PaymentMethod = 'cash';

  @Output() close = new EventEmitter<void>();
  @Output() recordPayment = new EventEmitter<RecordPaymentPayload>();
  @Output() requestSquareLink = new EventEmitter<SquareLinkRequestPayload>();
  @Output() cashAppTokenized = new EventEmitter<CashAppTokenizedPayload>();
  @Output() cashAppError = new EventEmitter<string>();

  @ViewChild('cashAppQrPad') cashAppQrPad?: CashAppQrPad;

  readonly form = new FormGroup({
    amount: new FormControl(0, { nonNullable: true, validators: [Validators.min(0.01)] }),
    method: new FormControl<PaymentMethod>('cash', { nonNullable: true }),
    creditId: new FormControl('', { nonNullable: true }),
    remainingMethod: new FormControl<'cash' | 'square'>('cash', { nonNullable: true }),
    receiptNumber: new FormControl('', { nonNullable: true }),
    note: new FormControl('', { nonNullable: true }),
  });

  readonly submitAttempted = signal(false);
  readonly methodSignal = signal<PaymentMethod>('cash');
  readonly creditIdSignal = signal<string>('');
  readonly remainingMethodSignal = signal<'cash' | 'square'>('cash');

  readonly isCash = computed(() => this.methodSignal() === 'cash');
  readonly isSquare = computed(() => this.methodSignal() === 'square');
  readonly isCashApp = computed(() => this.methodSignal() === 'cashapp');
  readonly isCredit = computed(() => this.methodSignal() === 'credit');

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['reservation'] && this.reservation) {
      const balance = this.remainingFor(this.reservation);
      this.form.setValue({
        amount: balance > 0 ? balance : 0,
        method: this.defaultMethod,
        creditId: '',
        remainingMethod: 'cash',
        receiptNumber: '',
        note: '',
      });
      this.submitAttempted.set(false);
      this.methodSignal.set(this.defaultMethod);
      this.creditIdSignal.set('');
      this.remainingMethodSignal.set('cash');
    }
    // Auto-select the only credit when the parent finishes loading
    // and there is exactly one available.
    if (
      changes['availableCredits'] &&
      this.isCredit() &&
      !this.creditIdSignal() &&
      this.availableCredits.length === 1
    ) {
      const id = this.availableCredits[0].creditId;
      this.form.controls.creditId.setValue(id);
      this.creditIdSignal.set(id);
    }
  }

  ngOnDestroy(): void {
    void this.cashAppQrPad?.destroy();
  }

  onMethodChange(next: string): void {
    const method = next as PaymentMethod;
    this.methodSignal.set(method);
    if (method !== 'cashapp') {
      void this.cashAppQrPad?.destroy();
    }
    if (method !== 'credit') {
      this.form.controls.creditId.setValue('');
      this.creditIdSignal.set('');
      this.form.controls.remainingMethod.setValue('cash');
      this.remainingMethodSignal.set('cash');
      if (method !== 'cash') {
        this.form.controls.receiptNumber.setValue('');
      }
      const balance = this.remainingFor(this.reservation);
      this.form.controls.amount.setValue(balance > 0 ? balance : 0);
      return;
    }
    if (!this.form.controls.creditId.value && this.availableCredits.length === 1) {
      const id = this.availableCredits[0].creditId;
      this.form.controls.creditId.setValue(id);
      this.creditIdSignal.set(id);
    } else if (!this.form.controls.creditId.value) {
      this.form.controls.amount.setValue(0);
    }
    if (!this.isCashReceiptRequired()) {
      this.form.controls.receiptNumber.setValue('');
    }
    this.onCreditChange(this.form.controls.creditId.value);
  }

  onCreditChange(next: string): void {
    this.creditIdSignal.set(next);
    if (!this.isCredit()) return;
    const selected = this.selectedCredit();
    if (!selected || !this.reservation) return;
    const target = Math.min(this.remainingFor(this.reservation), Number(selected.amountRemaining ?? 0));
    if (target > 0) {
      this.form.controls.amount.setValue(Number(target.toFixed(2)));
    }
  }

  onRemainingMethodChange(next: string): void {
    const method = next as 'cash' | 'square';
    this.remainingMethodSignal.set(method);
    if (!this.isCashReceiptRequired()) {
      this.form.controls.receiptNumber.setValue('');
    }
  }

  onReceiptInput(): void {
    const raw = String(this.form.controls.receiptNumber.value ?? '');
    const digitsOnly = raw.replace(/\D+/g, '').slice(0, 64);
    if (digitsOnly !== this.form.controls.receiptNumber.value) {
      this.form.controls.receiptNumber.setValue(digitsOnly, { emitEvent: false });
    }
  }

  selectedCredit(): RescheduleCredit | null {
    const id = String(this.form.controls.creditId.value ?? '').trim();
    if (!id) return null;
    return this.availableCredits.find((c) => c.creditId === id) ?? null;
  }

  creditAppliedAmount(): number {
    if (!this.isCredit()) return 0;
    const selected = this.selectedCredit();
    if (!selected || !this.reservation) return 0;
    const amount = Math.min(
      this.remainingFor(this.reservation),
      Number(selected.amountRemaining ?? 0),
    );
    return Number(Math.max(0, amount).toFixed(2));
  }

  creditRemainingAmount(): number {
    if (!this.isCredit() || !this.reservation) return 0;
    const remaining = this.remainingFor(this.reservation) - this.creditAppliedAmount();
    return Number(Math.max(0, remaining).toFixed(2));
  }

  shouldShowRemainingMethodSelector(): boolean {
    return this.isCredit() && this.creditRemainingAmount() > 0;
  }

  isCashReceiptRequired(): boolean {
    if (!this.cashReceiptRequired) return false;
    if (this.isCash()) return true;
    return (
      this.isCredit() &&
      this.creditRemainingAmount() > 0 &&
      this.remainingMethodSignal() === 'cash'
    );
  }

  shouldShowCashReceiptError(): boolean {
    return (
      this.submitAttempted() &&
      this.isCashReceiptRequired() &&
      !this.normalizedReceiptNumber()
    );
  }

  cashReceiptLabel(): string {
    if (
      this.isCredit() &&
      this.creditRemainingAmount() > 0 &&
      this.remainingMethodSignal() === 'cash'
    ) {
      return 'Remaining Cash Receipt Number';
    }
    return 'Receipt Number';
  }

  canUseCashAppPay(): boolean {
    return this.isCashApp() && Boolean(this.squareApplicationId) && Boolean(this.squareLocationId);
  }

  cashAppLabel(): string {
    return this.reservation ? `${formatTableLabel(this.reservation)} payment` : 'Reservation payment';
  }

  creditOptionLabel(credit: RescheduleCredit): string {
    const remaining = Number(credit.amountRemaining ?? 0).toFixed(2);
    const expires = String(credit.expiresAt ?? '').trim();
    return expires
      ? `$${remaining} remaining · Expires ${expires}`
      : `$${remaining} remaining`;
  }

  paymentSubmitLabel(): string {
    if (this.isSquare()) {
      return this.squareLinkLoading ? 'Generating…' : 'Generate Link';
    }
    if (this.isCashApp()) {
      if (this.cashAppQrPad?.preparing()) return 'Preparing…';
      if (this.loading) return 'Processing…';
      return this.cashAppQrPad?.ready() ? 'Refresh Cash App QR' : 'Show Cash App QR';
    }
    if (this.loading) return 'Saving…';
    if (!this.isCredit()) return 'Submit Payment';
    if (this.creditRemainingAmount() <= 0) return 'Apply Credit';
    return this.remainingMethodSignal() === 'square'
      ? 'Apply Credit + Generate Link'
      : 'Apply Credit + Submit Payment';
  }

  submitDisabled(): boolean {
    if (this.isSquare()) {
      return this.squareLinkLoading;
    }
    if (this.loading) return true;
    if (this.cashAppQrPad?.preparing()) return true;
    if (this.form.invalid) return true;
    if (this.isCashApp() && !this.canUseCashAppPay()) return true;
    if (this.isCredit()) {
      if (this.creditsLoading) return true;
      if (!this.form.controls.creditId.value) return true;
      if (this.shouldShowRemainingMethodSelector() && !this.remainingMethodSignal()) return true;
    }
    return false;
  }

  async onSubmit(): Promise<void> {
    if (!this.reservation) return;
    const method = this.methodSignal();
    const amount = Number(this.form.controls.amount.value);
    const note = String(this.form.controls.note.value ?? '').trim();
    const receiptNumber = this.normalizedReceiptNumber();
    this.submitAttempted.set(true);

    if (method === 'square') {
      if (this.squareLinkLoading) return;
      const remaining = this.remainingFor(this.reservation);
      if (remaining <= 0) return;
      this.requestSquareLink.emit({ amount: remaining, note });
      return;
    }

    if (method === 'cashapp') {
      if (this.loading || this.cashAppQrPad?.preparing()) return;
      if (!this.canUseCashAppPay()) {
        this.cashAppError.emit('Cash App Pay is not configured in Square settings.');
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        this.form.controls.amount.markAsTouched();
        return;
      }
      const remaining = this.remainingFor(this.reservation);
      if (amount > remaining) {
        this.cashAppError.emit('Amount cannot exceed remaining balance.');
        return;
      }
      await this.cashAppQrPad?.prepare();
      return;
    }

    if (this.form.invalid) return;
    if (method === 'credit' && !this.selectedCredit()) return;
    if (this.isCashReceiptRequired() && !receiptNumber) return;

    this.recordPayment.emit({
      method,
      amount,
      creditId: String(this.form.controls.creditId.value ?? ''),
      remainingMethod: this.remainingMethodSignal(),
      receiptNumber,
      note,
    });
  }

  onCashAppTokenizedInternal(sourceId: string): void {
    const amount = Number(this.form.controls.amount.value);
    const note = String(this.form.controls.note.value ?? '').trim();
    this.cashAppTokenized.emit({
      sourceId,
      amount,
      note: note || `Cash App Pay for ${formatTableLabelLower(this.reservation)}`,
    });
  }

  onCashAppErroredInternal(message: string): void {
    this.cashAppError.emit(message || 'Cash App payment was not completed.');
  }

  private normalizedReceiptNumber(): string {
    return String(this.form.controls.receiptNumber.value ?? '').replace(/\D+/g, '').trim();
  }

  private remainingFor(item: ReservationItem | null | undefined): number {
    if (!item) return 0;
    const due = Number(item.amountDue ?? 0);
    const paid = Number(item.depositAmount ?? 0);
    return Math.max(0, Number((due - paid).toFixed(2)));
  }
}
