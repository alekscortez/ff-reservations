import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { TakePaymentModal } from './take-payment-modal';
import type { ReservationItem } from '../../models/reservation.model';
import type { RescheduleCredit } from '../../../core/http/clients.service';

function makeReservation(overrides: Partial<ReservationItem> = {}): ReservationItem {
  return {
    reservationId: 'r-1',
    eventDate: '2099-12-31',
    tableId: 't-1',
    customerName: 'Maria López',
    phone: '+15551234567',
    depositAmount: 50,
    amountDue: 200,
    paymentStatus: 'PARTIAL',
    paymentMethod: 'square',
    paymentDeadlineAt: '2099-12-30T18:00',
    status: 'CONFIRMED',
    createdBy: 'staff',
    ...overrides,
  } as ReservationItem;
}

function makeCredit(overrides: Partial<RescheduleCredit> = {}): RescheduleCredit {
  return {
    creditId: 'c-1',
    amountRemaining: 75,
    expiresAt: '2099-06-30',
    status: 'ACTIVE',
    ...overrides,
  } as RescheduleCredit;
}

@Component({
  standalone: true,
  imports: [CommonModule, TakePaymentModal],
  template: `
    <take-payment-modal
      [reservation]="reservation"
      [cashReceiptRequired]="cashReceiptRequired"
      [squareApplicationId]="squareApplicationId"
      [squareLocationId]="squareLocationId"
      [availableCredits]="availableCredits"
      [creditsLoading]="creditsLoading"
      [creditsError]="creditsError"
      [loading]="loading"
      [error]="error"
      (close)="onClose()"
      (recordPayment)="onRecord($event)"
      (requestSquareLink)="onSquareLink($event)"
      (cashAppTokenized)="onCashApp($event)"
      (cashAppError)="onCashAppError($event)"
    />
  `,
})
class Host {
  reservation: ReservationItem = makeReservation();
  cashReceiptRequired = true;
  squareApplicationId = '';
  squareLocationId = '';
  availableCredits: RescheduleCredit[] = [];
  creditsLoading = false;
  creditsError: string | null = null;
  loading = false;
  error: string | null = null;

  closeCount = 0;
  lastRecord: unknown = null;
  lastSquareLink: unknown = null;
  lastCashApp: unknown = null;
  lastCashAppError: string | null = null;

  onClose() { this.closeCount += 1; }
  onRecord(p: unknown) { this.lastRecord = p; }
  onSquareLink(p: unknown) { this.lastSquareLink = p; }
  onCashApp(p: unknown) { this.lastCashApp = p; }
  onCashAppError(msg: string) { this.lastCashAppError = msg; }
}

function createHost(initial?: Partial<Host>) {
  TestBed.configureTestingModule({ imports: [Host] });
  const f = TestBed.createComponent(Host);
  if (initial) Object.assign(f.componentInstance, initial);
  f.detectChanges();
  return f;
}

describe('TakePaymentModal', () => {
  it('prefills amount with the remaining balance on open', () => {
    const f = createHost();
    const input = f.nativeElement.querySelector(
      'take-payment-modal input[formControlName="amount"]',
    ) as HTMLInputElement;
    // Reservation: amountDue 200 - depositAmount 50 = 150 remaining.
    expect(Number(input.value)).toBe(150);
  });

  it('renders the four payment methods via hlm-native-select', () => {
    const f = createHost();
    const text = f.nativeElement.textContent ?? '';
    expect(text).toContain('Cash');
    expect(text).toContain('Square');
    expect(text).toContain('Cash App Pay');
    expect(text).toContain('Reservation Credit');
    // Confirms we use Spartan's native-select wrapper (chevron overlay).
    const wrapper = f.nativeElement.querySelector(
      'take-payment-modal hlm-native-select[formControlName="method"]',
    );
    expect(wrapper).not.toBeNull();
  });

  it('emits close when the X button is clicked', () => {
    const f = createHost();
    const btn = f.nativeElement.querySelector(
      'take-payment-modal button[aria-label="Close payment modal"]',
    ) as HTMLButtonElement;
    btn.click();
    expect(f.componentInstance.closeCount).toBe(1);
  });

  it('emits recordPayment with method=cash and the receipt number', async () => {
    const f = createHost();
    const modal = f.debugElement.query(
      (de) => de.componentInstance instanceof TakePaymentModal,
    ).componentInstance as TakePaymentModal;
    modal.form.controls.method.setValue('cash');
    modal.methodSignal.set('cash');
    modal.form.controls.amount.setValue(40);
    modal.form.controls.receiptNumber.setValue('12345');
    modal.form.controls.note.setValue('paid in cash');
    await modal.onSubmit();
    const payload = f.componentInstance.lastRecord as
      | { method: string; amount: number; receiptNumber: string; note: string }
      | null;
    expect(payload?.method).toBe('cash');
    expect(payload?.amount).toBe(40);
    expect(payload?.receiptNumber).toBe('12345');
    expect(payload?.note).toBe('paid in cash');
  });

  it('blocks cash submit when receipt is required + empty', async () => {
    const f = createHost();
    const modal = f.debugElement.query(
      (de) => de.componentInstance instanceof TakePaymentModal,
    ).componentInstance as TakePaymentModal;
    modal.form.controls.amount.setValue(20);
    modal.form.controls.receiptNumber.setValue('');
    await modal.onSubmit();
    expect(f.componentInstance.lastRecord).toBeNull();
    f.detectChanges();
    expect((f.nativeElement.textContent ?? '')).toContain('Receipt number is required');
  });

  it('emits requestSquareLink with the remaining balance on method=square', async () => {
    const f = createHost();
    const modal = f.debugElement.query(
      (de) => de.componentInstance instanceof TakePaymentModal,
    ).componentInstance as TakePaymentModal;
    modal.methodSignal.set('square');
    modal.form.controls.method.setValue('square');
    await modal.onSubmit();
    const payload = f.componentInstance.lastSquareLink as { amount: number } | null;
    expect(payload?.amount).toBe(150); // 200 due - 50 paid
  });

  it('shows the Cash App config error when method=cashapp + missing Square ids', async () => {
    const f = createHost({ squareApplicationId: '', squareLocationId: '' });
    const modal = f.debugElement.query(
      (de) => de.componentInstance instanceof TakePaymentModal,
    ).componentInstance as TakePaymentModal;
    modal.methodSignal.set('cashapp');
    modal.form.controls.method.setValue('cashapp');
    await modal.onSubmit();
    expect(f.componentInstance.lastCashAppError).toContain('Cash App Pay is not configured');
  });

  it('reservation credit: auto-selects the only available credit + computes applied amount', () => {
    const f = createHost({ availableCredits: [makeCredit({ amountRemaining: 60 })] });
    const modal = f.debugElement.query(
      (de) => de.componentInstance instanceof TakePaymentModal,
    ).componentInstance as TakePaymentModal;
    modal.methodSignal.set('credit');
    modal.form.controls.method.setValue('credit');
    modal.onMethodChange('credit');
    expect(modal.form.controls.creditId.value).toBe('c-1');
    // Credit 60 < remaining 150 → applied=60, remaining-after=90.
    expect(modal.creditAppliedAmount()).toBe(60);
    expect(modal.creditRemainingAmount()).toBe(90);
  });

  it('locks the amount field when method=credit (readonly + bg cue)', () => {
    const f = createHost({ availableCredits: [makeCredit()] });
    const modal = f.debugElement.query(
      (de) => de.componentInstance instanceof TakePaymentModal,
    ).componentInstance as TakePaymentModal;
    modal.methodSignal.set('credit');
    modal.form.controls.method.setValue('credit');
    f.detectChanges();
    const input = f.nativeElement.querySelector(
      'take-payment-modal input[formControlName="amount"]',
    ) as HTMLInputElement;
    expect(input.hasAttribute('readonly')).toBe(true);
    expect(input.classList.contains('bg-brand-50')).toBe(true);
  });

  it('renders Note as a textarea (multi-line)', () => {
    const f = createHost();
    const ta = f.nativeElement.querySelector(
      'take-payment-modal textarea[formControlName="note"]',
    );
    expect(ta).not.toBeNull();
  });

  it('disables submit for Card on Stand when amount is 0 (form invalid)', () => {
    // Host needs squareApplicationId set for canUseSquareStand() to be
    // true — otherwise the pre-check shortcuts to "disabled" and we
    // can't observe the amount-validation gate.
    const f = createHost({ squareApplicationId: 'app_1' });
    const modal = f.debugElement.query(
      (de) => de.componentInstance instanceof TakePaymentModal,
    ).componentInstance as TakePaymentModal;
    modal.methodSignal.set('square_stand');
    modal.form.controls.method.setValue('square_stand');
    modal.form.controls.amount.setValue(0);
    expect(modal.submitDisabled()).toBe(true);
    modal.form.controls.amount.setValue(50);
    expect(modal.submitDisabled()).toBe(false);
  });
});
