import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { vi } from 'vitest';

import { ChangeTableConfirmPayload, ChangeTableModal } from './change-table-modal';
import { HoldsService } from '../../../core/http/holds.service';
import type { RescheduleCredit } from '../../../core/http/clients.service';
import type { ReservationItem } from '../../models/reservation.model';
import type { TableForEvent } from '../../models/table.model';

function makeReservation(overrides: Partial<ReservationItem> = {}): ReservationItem {
  return {
    reservationId: 'r-1',
    eventDate: '2099-12-31',
    tableId: 'T1',
    tableIds: ['T1'],
    customerName: 'Maria López',
    phone: '+15551234567',
    phoneCountry: 'US',
    depositAmount: 100,
    amountDue: 100,
    tablePrice: 100,
    tablePrices: [100],
    paymentStatus: 'PAID',
    paymentMethod: 'cash',
    status: 'CONFIRMED',
    payments: [
      {
        paymentId: 'p1',
        amount: 100,
        method: 'cash',
        source: 'manual',
        receiptNumber: '1',
        createdAt: 1000,
      } as any,
    ],
    ...overrides,
  } as ReservationItem;
}

function tablesFixture(): TableForEvent[] {
  return [
    { id: 'T1', section: 'A', number: 1, price: 100, status: 'AVAILABLE', disabled: false } as any,
    { id: 'T2', section: 'A', number: 2, price: 200, status: 'AVAILABLE', disabled: false } as any,
    { id: 'T3', section: 'B', number: 3, price: 50, status: 'AVAILABLE', disabled: false } as any,
    { id: 'T4', section: 'C', number: 4, price: 50, status: 'AVAILABLE', disabled: false } as any,
  ];
}

function makeHoldsStub(overrides: Partial<HoldsService> = {}): Partial<HoldsService> {
  return {
    createHold: vi.fn((p: { tableId: string }) => of({ holdId: `h-${p.tableId}` } as any)),
    releaseHold: vi.fn(() => of(undefined as unknown as void)),
    listLocks: vi.fn(() => of([])),
    ...overrides,
  };
}

@Component({
  standalone: true,
  imports: [CommonModule, ChangeTableModal],
  template: `
    <change-table-modal
      [reservation]="reservation"
      [tables]="tables"
      [availableCredits]="credits"
      [submitError]="submitError"
      [submitLoading]="submitLoading"
      [cashReceiptRequired]="cashReceiptRequired"
      (confirm)="onConfirm($event)"
      (close)="onClose()"
    />
  `,
})
class Host {
  reservation: ReservationItem = makeReservation();
  tables: TableForEvent[] = tablesFixture();
  credits: RescheduleCredit[] = [];
  submitError: string | null = null;
  submitLoading = false;
  cashReceiptRequired = true;

  lastConfirm: ChangeTableConfirmPayload | null = null;
  closeCount = 0;

  onConfirm(p: ChangeTableConfirmPayload) { this.lastConfirm = p; }
  onClose() { this.closeCount += 1; }
}

function createHost(
  initial?: Partial<Host>,
  holdsOverrides: Partial<HoldsService> = {},
) {
  TestBed.configureTestingModule({
    imports: [Host],
    providers: [{ provide: HoldsService, useValue: makeHoldsStub(holdsOverrides) }],
  });
  const f = TestBed.createComponent(Host);
  if (initial) Object.assign(f.componentInstance, initial);
  f.detectChanges();
  return f;
}

function getModal(f: ReturnType<typeof createHost>): ChangeTableModal {
  return f.debugElement.children[0].componentInstance as ChangeTableModal;
}

describe('ChangeTableModal — initial state', () => {
  it('renders the customer name + current table label in the header', () => {
    const f = createHost();
    const text = f.nativeElement.textContent ?? '';
    expect(text).toContain('Maria López');
    expect(text).toContain('Table T1');
  });

  it('seeds selectedIds with the current reservation tableIds', () => {
    const f = createHost();
    expect(getModal(f).selectedIds()).toEqual(['T1']);
  });

  it('starts on the pick step with delta=0 when nothing is changed', () => {
    const f = createHost();
    const m = getModal(f);
    expect(m.step()).toBe('pick');
    expect(m.delta()).toBe(0);
  });

  it('disables the primary button when the selection is unchanged (isNoChange)', () => {
    const f = createHost();
    expect(getModal(f).primaryButtonDisabled()).toBe(true);
  });

  it('recomputes prices when [tables] arrives AFTER the modal opens (parent async-loads)', () => {
    // Regression for the 2026-05-17 bug: selecting a tile that arrived
    // in a later [tables] update was pricing it at $0 because the
    // tableById computed was reading a plain @Input field, not a signal.
    // Mount the modal directly so we can drive setInput() like Angular
    // does on a real Input change (mirrors the parent async-fetch path).
    TestBed.configureTestingModule({
      imports: [ChangeTableModal],
      providers: [{ provide: HoldsService, useValue: makeHoldsStub() }],
    });
    const f = TestBed.createComponent(ChangeTableModal);
    f.componentRef.setInput('reservation', makeReservation());
    f.componentRef.setInput('tables', []);
    f.detectChanges();
    // Tables now load.
    f.componentRef.setInput('tables', tablesFixture());
    f.detectChanges();
    const m = f.componentInstance;
    m.onTableSelect(tablesFixture()[1]); // +T2 ($200)
    m.onTableSelect(tablesFixture()[0]); // -T1 ($100)
    expect(m.newTablePriceTotal()).toBe(200);
    expect(m.delta()).toBe(100);
  });
});

describe('ChangeTableModal — delta > 0 (swap to more expensive)', () => {
  it('toggling T2 (added) creates a hold then enables continue with delta=100', async () => {
    const f = createHost();
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]); // T2
    f.detectChanges();
    await Promise.resolve();
    expect(m.selectedIds().sort()).toEqual(['T1', 'T2']);
    expect(m.newHoldsByTableId()).toEqual({ T2: 'h-T2' });
    expect(m.delta()).toBe(200); // T1+T2=300, current=100, delta=200
    expect(m.newAmountDue()).toBe(300);
    // Toggling off T1 makes net add T2, remove T1 -> delta = 200 - 100 = 100
    m.onTableSelect(tablesFixture()[0]);
    expect(m.selectedIds()).toEqual(['T2']);
    expect(m.delta()).toBe(100);
  });

  it('reason required: button stays disabled until reason is filled', () => {
    const f = createHost();
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]); // swap-in T2
    m.onTableSelect(tablesFixture()[0]); // remove T1
    f.detectChanges();
    expect(m.primaryButtonDisabled()).toBe(true); // no reason
    m.form.controls.reason.setValue('Customer upgrade');
    expect(m.primaryButtonDisabled()).toBe(false);
  });

  it('Continue advances to pay step without emitting confirm', () => {
    const f = createHost();
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]);
    m.onTableSelect(tablesFixture()[0]);
    m.form.controls.reason.setValue('Upgrade');
    m.onPrimary();
    expect(m.step()).toBe('pay');
    expect(f.componentInstance.lastConfirm).toBeNull();
  });

  it('Step 2 cash + receipt emits payment payload on confirm', () => {
    const f = createHost();
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]);
    m.onTableSelect(tablesFixture()[0]);
    m.form.controls.reason.setValue('Upgrade');
    m.onPrimary(); // advance to pay
    m.onMethodChange('cash');
    m.form.controls.receiptNumber.setValue('1247');
    m.onPrimary();
    const out = f.componentInstance.lastConfirm;
    expect(out).toBeTruthy();
    expect(out!.newTableIds).toEqual(['T2']);
    expect(out!.newHoldsByTableId).toEqual({ T2: 'h-T2' });
    expect(out!.expectedTablePriceTotal).toBe(200);
    expect(out!.payment).toEqual({
      method: 'cash',
      amount: 100,
      receiptNumber: '1247',
      creditId: undefined,
      note: undefined,
    });
    expect(out!.overpaymentResolution).toBeUndefined();
  });

  it('Step 2 credit with available credit emits credit payload', () => {
    const f = createHost({
      credits: [{ creditId: 'c-1', amountRemaining: 500, expiresAt: '2099-12-31', status: 'ACTIVE' } as any],
    });
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]);
    m.onTableSelect(tablesFixture()[0]);
    m.form.controls.reason.setValue('Upgrade');
    m.onPrimary();
    m.onMethodChange('credit');
    m.onCreditChange('c-1');
    m.onPrimary();
    const out = f.componentInstance.lastConfirm;
    expect(out).toBeTruthy();
    expect(out!.payment?.method).toBe('credit');
    expect(out!.payment?.creditId).toBe('c-1');
  });

  it('Step 2 credit with insufficient balance disables submit', () => {
    const f = createHost({
      credits: [{ creditId: 'c-1', amountRemaining: 50, expiresAt: '2099-12-31', status: 'ACTIVE' } as any],
    });
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]); // delta becomes 200 after the next remove
    m.onTableSelect(tablesFixture()[0]); // remove T1 -> delta=100
    m.form.controls.reason.setValue('Upgrade');
    m.onPrimary();
    m.onMethodChange('credit');
    m.onCreditChange('c-1');
    expect(m.primaryButtonDisabled()).toBe(true);
  });

  it('Step 2 cash without receipt disables submit when receipt is required', () => {
    const f = createHost();
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]);
    m.onTableSelect(tablesFixture()[0]);
    m.form.controls.reason.setValue('Upgrade');
    m.onPrimary();
    expect(m.primaryButtonDisabled()).toBe(true); // cash + no receipt
    m.form.controls.receiptNumber.setValue('5');
    expect(m.primaryButtonDisabled()).toBe(false);
  });
});

describe('ChangeTableModal — delta > 0 deferred (Card on Stand)', () => {
  it('square_stand swap commits no bundled payment, emits deferredPaymentMethod', () => {
    const f = createHost();
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]); // +T2
    m.onTableSelect(tablesFixture()[0]); // -T1
    m.form.controls.reason.setValue('Upgrade via Stand');
    m.onPrimary(); // advance to pay step
    expect(m.step()).toBe('pay');
    m.onMethodChange('square_stand');
    // No receipt / no creditId needed: button should be enabled.
    expect(m.primaryButtonDisabled()).toBe(false);
    m.onPrimary();
    const out = f.componentInstance.lastConfirm;
    expect(out).toBeTruthy();
    expect(out!.payment).toBeUndefined();
    expect(out!.deferredPaymentMethod).toBe('square_stand');
    expect(out!.newTableIds).toEqual(['T2']);
    expect(out!.expectedTablePriceTotal).toBe(200);
  });

  it('primary button label changes to "Confirm swap → Card on Stand" for square_stand', () => {
    const f = createHost();
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]);
    m.onTableSelect(tablesFixture()[0]);
    m.form.controls.reason.setValue('Upgrade');
    m.onPrimary();
    m.onMethodChange('square_stand');
    expect(m.primaryButtonLabel()).toContain('Card on Stand');
    expect(m.primaryButtonLabel()).toContain('$100.00');
  });
});

describe('ChangeTableModal — delta = 0', () => {
  it('emits confirm directly without going to pay step', () => {
    const f = createHost();
    const m = getModal(f);
    // Swap T1 -> T3+T4 (same total $100)
    m.onTableSelect(tablesFixture()[2]); // +T3
    m.onTableSelect(tablesFixture()[3]); // +T4
    m.onTableSelect(tablesFixture()[0]); // -T1
    expect(m.delta()).toBe(0);
    m.form.controls.reason.setValue('Move closer to stage');
    m.onPrimary();
    expect(m.step()).toBe('pick');
    const out = f.componentInstance.lastConfirm;
    expect(out).toBeTruthy();
    expect(out!.newTableIds.sort()).toEqual(['T3', 'T4']);
    expect(out!.payment).toBeUndefined();
    expect(out!.overpaymentResolution).toBeUndefined();
  });
});

describe('ChangeTableModal — delta < 0 (overpayment)', () => {
  function setupDowngradeFixture() {
    const reservation = makeReservation({
      tableId: 'T2',
      tableIds: ['T2'],
      tablePrice: 200,
      tablePrices: [200],
      amountDue: 200,
      depositAmount: 200,
    });
    return reservation;
  }

  it('default resolution is CREDIT; emits CREDIT payload', () => {
    const f = createHost({ reservation: setupDowngradeFixture() });
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[0]); // +T1
    m.onTableSelect(tablesFixture()[1]); // -T2 (currently selected because reservation has T2)
    expect(m.delta()).toBe(-100);
    expect(m.surplus()).toBe(100);
    expect(m.overpayResolution()).toBe('CREDIT');
    m.form.controls.reason.setValue('Customer downgrade');
    m.onPrimary();
    const out = f.componentInstance.lastConfirm;
    expect(out!.overpaymentResolution).toBe('CREDIT');
    expect(out!.payment).toBeUndefined();
  });

  it('switching to LEAVE updates the emit payload', () => {
    const f = createHost({ reservation: setupDowngradeFixture() });
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[0]);
    m.onTableSelect(tablesFixture()[1]);
    m.setOverpayResolution('LEAVE');
    m.form.controls.reason.setValue('Comp the diff');
    m.onPrimary();
    expect(f.componentInstance.lastConfirm!.overpaymentResolution).toBe('LEAVE');
  });

  it('REFUND is eligible when reservation has a Square payment with providerPaymentId', () => {
    const reservation = setupDowngradeFixture();
    reservation.payments = [
      {
        paymentId: 'p1',
        amount: 200,
        method: 'square',
        source: 'square-direct',
        provider: { providerPaymentId: 'sq_pay_abc' },
        createdAt: 1000,
      } as any,
    ];
    const f = createHost({ reservation });
    const m = getModal(f);
    expect(m.canPartialRefund()).toBe(true);
  });

  it('REFUND is ineligible when no Square payment exists', () => {
    const f = createHost({ reservation: setupDowngradeFixture() });
    const m = getModal(f);
    expect(m.canPartialRefund()).toBe(false);
  });

  it('PARTIAL reservation downgrade with no surplus does not require resolution-action UX', () => {
    const reservation = makeReservation({
      tableId: 'T2',
      tableIds: ['T2'],
      tablePrice: 200,
      tablePrices: [200],
      amountDue: 200,
      depositAmount: 50,
      paymentStatus: 'PARTIAL',
    });
    const f = createHost({ reservation });
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[0]); // +T1
    m.onTableSelect(tablesFixture()[1]); // -T2
    expect(m.delta()).toBe(-100);
    expect(m.surplus()).toBe(0); // 50 paid < new $100 due -> no surplus
  });
});

describe('ChangeTableModal — hold lifecycle', () => {
  it('toggling off a freshly-added tile calls releaseHold', () => {
    const release = vi.fn(() => of(undefined as unknown as void));
    const f = createHost({}, {
      createHold: vi.fn((p: { tableId: string }) => of({ holdId: `h-${p.tableId}` } as any)),
      releaseHold: release as any,
    });
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]); // +T2 (hold)
    expect(m.newHoldsByTableId()).toEqual({ T2: 'h-T2' });
    m.onTableSelect(tablesFixture()[1]); // -T2 (release)
    expect(release).toHaveBeenCalledWith('2099-12-31', 'T2');
    expect(m.newHoldsByTableId()).toEqual({});
  });

  it('does NOT call releaseHold when toggling off a table that was on the reservation', () => {
    const release = vi.fn(() => of(undefined as unknown as void));
    const f = createHost({}, { releaseHold: release as any });
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[0]); // toggle off T1 (originally on reservation)
    expect(release).not.toHaveBeenCalled();
    expect(m.selectedIds()).toEqual([]);
  });

  it('createHold failure surfaces holdError and leaves selection unchanged', () => {
    const f = createHost({}, {
      createHold: vi.fn(() =>
        throwError(() => ({ error: { message: 'Table is already held or reserved' } })),
      ) as any,
    });
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]); // T2
    expect(m.holdError()).toContain('already held');
    expect(m.selectedIds()).toEqual(['T1']); // unchanged
  });

  it('closing the modal releases pending holds best-effort', () => {
    const release = vi.fn(() => of(undefined as unknown as void));
    const f = createHost({}, { releaseHold: release as any });
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]); // +T2 (hold)
    m.onTableSelect(tablesFixture()[2]); // +T3 (hold)
    expect(Object.keys(m.newHoldsByTableId()).length).toBe(2);
    m.onClose();
    expect(release).toHaveBeenCalledTimes(2);
    expect(f.componentInstance.closeCount).toBe(1);
  });

  it('cleanup-release subscription is NOT torn down immediately (XHR must reach the server)', () => {
    // Regression for the 2026-05-17 bug: cleanup releases were piped
    // through takeUntilDestroyed, which fired synchronously when
    // close.emit() triggered the parent's *ngIf to unmount the modal.
    // Result: HttpClient.subscribe() was invoked but the underlying
    // XHR was aborted before the request left the browser, leaving
    // the hold stuck until its 5-min TTL.
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const release = vi.fn(
      () =>
        new Observable<void>(() => {
          subscribeCount += 1;
          return () => {
            unsubscribeCount += 1;
          };
        }),
    );
    const f = createHost({}, { releaseHold: release as any });
    const m = getModal(f);
    m.onTableSelect(tablesFixture()[1]); // +T2 (hold)
    m.onClose();
    // subscribe must have happened (== XHR sent in real life)
    expect(subscribeCount).toBe(1);
    // and the subscription must NOT have been torn down synchronously,
    // because that would cancel the XHR.
    expect(unsubscribeCount).toBe(0);
  });
});

describe('ChangeTableModal — guards', () => {
  it('emits close and does not emit confirm when primaryButtonDisabled', () => {
    const f = createHost();
    const m = getModal(f);
    // no selection change → button disabled → onPrimary is a no-op
    m.onPrimary();
    expect(f.componentInstance.lastConfirm).toBeNull();
  });

  it('rejects > 10 added tiles with a helpful error', () => {
    // Generate 12 selectable tables
    const many: TableForEvent[] = Array.from({ length: 12 }, (_, i) => ({
      id: `X${i + 1}`,
      section: 'A',
      number: i + 1,
      price: 10,
      status: 'AVAILABLE',
      disabled: false,
    } as any));
    const f = createHost({ tables: [...many] });
    const m = getModal(f);
    // T1 from the reservation is in selectedIds but not in the new
    // `tables` list — that's fine, this test only cares about the cap.
    for (let i = 0; i < 9; i += 1) m.onTableSelect(many[i]); // 9 added
    expect(m.selectedIds().length).toBe(10); // T1 (kept) + 9 added
    m.onTableSelect(many[9]); // attempt the 11th
    expect(m.holdError()).toContain('Cannot reserve more than 10');
    expect(m.selectedIds().length).toBe(10);
  });
});
