import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NEVER, of } from 'rxjs';
import { vi } from 'vitest';

import { HoldsService } from '../../../core/http/holds.service';
import { ReservationsService } from '../../../core/http/reservations.service';
import { TablesService } from '../../../core/http/tables.service';
import { ReservationsNew } from './reservations-new';

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

const SEED_TABLES = [
  { id: 'A1', price: 100, section: 'A', status: 'HOLD' },
  { id: 'B2', price: 150, section: 'B', status: 'HOLD' },
  { id: 'C3', price: 200, section: 'C', status: 'HOLD' },
];

function makeHoldsStub(): Partial<HoldsService> {
  return {
    releaseHold: () => of(undefined as unknown as void),
    listLocks: () => of([]),
  };
}

function makeTablesStub(): Partial<TablesService> {
  return {
    getForEvent: () =>
      of({
        tables: SEED_TABLES,
        lastUpdated: 0,
      } as any),
  };
}

describe('ReservationsNew', () => {
  let component: ReservationsNew;
  let fixture: ComponentFixture<ReservationsNew>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReservationsNew],
      providers: [
        provideRouter([]),
        { provide: HoldsService, useValue: makeHoldsStub() },
        { provide: TablesService, useValue: makeTablesStub() },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: of(convertToParamMap({})),
            paramMap: of(convertToParamMap({})),
            snapshot: {
              queryParamMap: convertToParamMap({}),
              paramMap: convertToParamMap({}),
            },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ReservationsNew);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('removeSelectedTable', () => {
    function seedMultiTableState() {
      component.eventDate = '2026-05-09';
      const tableA = { id: 'A1', price: 100, section: 'A', status: 'HOLD' } as any;
      const tableB = { id: 'B2', price: 150, section: 'B', status: 'HOLD' } as any;
      const tableC = { id: 'C3', price: 200, section: 'C', status: 'HOLD' } as any;
      component.tables = [tableA, tableB, tableC];
      component.selectedTables = [tableA, tableB, tableC];
      component.holdEntries = [
        { tableId: 'A1', holdId: 'h-a1', holdExpiresAt: 1700000600, holdCreatedByMe: true },
        { tableId: 'B2', holdId: 'h-b2', holdExpiresAt: 1700000700, holdCreatedByMe: true },
        { tableId: 'C3', holdId: 'h-c3', holdExpiresAt: 1700000800, holdCreatedByMe: true },
      ];
      // Scalars mirror the primary (first entry).
      component.selectedTable = tableA;
      component.selectedTableId = 'A1';
      component.holdId = 'h-a1';
      component.holdExpiresAt = 1700000600;
      component.holdCreatedByMe = true;
      component.form.controls.amountDue.setValue(450);
    }

    it('promotes the next hold to primary when the primary table is removed', () => {
      seedMultiTableState();

      component.removeSelectedTable('A1');

      expect(component.selectedTables.map((t) => t.id)).toEqual(['B2', 'C3']);
      expect(component.holdEntries.map((h) => h.tableId)).toEqual(['B2', 'C3']);
      // Scalars must point at the new primary, not the deleted A1.
      expect(component.selectedTableId).toBe('B2');
      expect(component.selectedTable?.id).toBe('B2');
      expect(component.holdId).toBe('h-b2');
      expect(component.holdExpiresAt).toBe(1700000700);
      expect(component.holdCreatedByMe).toBe(true);
    });

    it('leaves the primary alone when removing a non-primary table', () => {
      seedMultiTableState();

      component.removeSelectedTable('B2');

      expect(component.selectedTables.map((t) => t.id)).toEqual(['A1', 'C3']);
      expect(component.holdEntries.map((h) => h.tableId)).toEqual(['A1', 'C3']);
      // Primary scalars untouched.
      expect(component.selectedTableId).toBe('A1');
      expect(component.selectedTable?.id).toBe('A1');
      expect(component.holdId).toBe('h-a1');
      expect(component.holdExpiresAt).toBe(1700000600);
    });

    it('refuses to remove the last remaining table', () => {
      component.eventDate = '2026-05-09';
      const tableA = { id: 'A1', price: 100, section: 'A', status: 'HOLD' } as any;
      component.selectedTables = [tableA];
      component.holdEntries = [
        { tableId: 'A1', holdId: 'h-a1', holdExpiresAt: 1700000600, holdCreatedByMe: true },
      ];
      component.selectedTable = tableA;
      component.selectedTableId = 'A1';
      component.holdId = 'h-a1';

      component.removeSelectedTable('A1');

      // No-op: still one table, still primary.
      expect(component.selectedTables).toHaveLength(1);
      expect(component.selectedTableId).toBe('A1');
      expect(component.holdId).toBe('h-a1');
    });
  });

  describe('isCashReceiptRequired (credit + cash-remainder)', () => {
    function seedCreditCashRemainder() {
      // Force credit-on state with a remainder > 0 collected as cash.
      // The form's amountDue is 200; we apply a credit that covers $50,
      // leaving a $150 remainder to be paid in cash.
      component.form.controls.amountDue.setValue(200);
      component.form.controls.useCredit.setValue(true);
      component.form.controls.creditId.setValue('credit-1');
      component.form.controls.remainingMethod.setValue('cash');
      component.clientCredits = [
        { creditId: 'credit-1', remainingAmount: 50 } as any,
      ];
    }

    it('returns true when credit is applied with cash remainder', () => {
      component.cashReceiptNumberRequired = true;
      seedCreditCashRemainder();
      expect(component.isCashReceiptRequired()).toBe(true);
    });

    it('returns false when the settings flag disables receipt requirement', () => {
      component.cashReceiptNumberRequired = false;
      seedCreditCashRemainder();
      expect(component.isCashReceiptRequired()).toBe(false);
    });

    it('returns false when the remainder is paid by Square', () => {
      component.cashReceiptNumberRequired = true;
      seedCreditCashRemainder();
      component.form.controls.remainingMethod.setValue('square');
      expect(component.isCashReceiptRequired()).toBe(false);
    });

    it('returns false when credit is not in use', () => {
      component.cashReceiptNumberRequired = true;
      component.form.controls.useCredit.setValue(false);
      component.form.controls.remainingMethod.setValue('cash');
      expect(component.isCashReceiptRequired()).toBe(false);
    });

    it('shouldShowCashReceiptError is gated on submit attempt', () => {
      component.cashReceiptNumberRequired = true;
      seedCreditCashRemainder();
      component.form.controls.receiptNumber.setValue('');

      expect(component.shouldShowCashReceiptError()).toBe(false);
      component.confirmSubmitAttempted = true;
      expect(component.shouldShowCashReceiptError()).toBe(true);

      component.form.controls.receiptNumber.setValue('42');
      expect(component.shouldShowCashReceiptError()).toBe(false);
    });
  });

  describe('+ Add another table flow — dead-end + orphan-hold guards', () => {
    function seedHeldBooking() {
      const tableA = { id: 'A1', price: 100, section: 'A', status: 'AVAILABLE' } as any;
      component.eventDate = '2026-05-09';
      component.tables = [tableA];
      component.selectedTables = [tableA];
      component.holdEntries = [
        { tableId: 'A1', holdId: 'h-a1', holdExpiresAt: 1700000600, holdCreatedByMe: true },
      ];
      component.selectedTable = tableA;
      component.selectedTableId = 'A1';
      component.holdId = 'h-a1';
      component.holdExpiresAt = 1700000600;
      component.holdCreatedByMe = true;
    }

    it('cancelAddAnotherTable reopens the modal when a hold is still alive', () => {
      seedHeldBooking();
      component.addAnotherTablePending = true;
      component.showReservationModal = false;

      component.cancelAddAnotherTable();

      // Hold state untouched, modal restored so staff isn't stranded.
      expect(component.addAnotherTablePending).toBe(false);
      expect(component.showReservationModal).toBe(true);
      expect(component.holdId).toBe('h-a1');
      expect(component.selectedTables).toHaveLength(1);
    });

    it('cancelAddAnotherTable does NOT reopen the modal when no hold exists', () => {
      component.eventDate = '2026-05-09';
      component.selectedTables = [];
      component.holdEntries = [];
      component.holdId = null;
      component.addAnotherTablePending = true;
      component.showReservationModal = false;

      component.cancelAddAnotherTable();

      expect(component.addAnotherTablePending).toBe(false);
      expect(component.showReservationModal).toBe(false);
    });

    it('selectTable on a table we already hold reopens the modal without clearing state (no orphan)', () => {
      // Reproduce the pre-fix bug: staff cancels + Add another table, then
      // taps the table they're already holding. The old code path fell
      // through and cleared local hold state while leaving the server
      // hold alive — orphan until the cron sweep.
      seedHeldBooking();
      component.showReservationModal = false;

      const tableA = component.selectedTables[0];
      component.selectTable(tableA);

      // Hold + booking state must be untouched.
      expect(component.holdId).toBe('h-a1');
      expect(component.selectedTables.map((t) => t.id)).toEqual(['A1']);
      expect(component.selectedTable?.id).toBe('A1');
      // Modal reopens so staff can continue.
      expect(component.showReservationModal).toBe(true);
      // No error surfaced — the tapped table is the one they're already
      // booking, not a confused different-table tap.
      expect(component.addAnotherTableError).toBeNull();
    });

    it('selectTable on a DIFFERENT table while holding reopens modal WITH the soft error', () => {
      seedHeldBooking();
      component.showReservationModal = false;
      const tableB = { id: 'B2', price: 150, section: 'B', status: 'AVAILABLE' } as any;

      component.selectTable(tableB);

      // Hold state preserved; the staff is steered back to the modal.
      expect(component.holdId).toBe('h-a1');
      expect(component.selectedTables.map((t) => t.id)).toEqual(['A1']);
      expect(component.showReservationModal).toBe(true);
      // Soft copy — no self-referential "+ Add another table" pointer.
      expect(component.addAnotherTableError).toContain('hold');
      expect(component.addAnotherTableError).not.toContain('Add another table');
    });

    it('Phase 2: beginAddAnotherTable keeps the modal open (in-modal picker)', () => {
      // Pre-Phase 2 the modal closed to expose the map underneath. Phase 2
      // renders the picker inside the modal's form column instead — modal
      // stays open and Cancel returns to the form without restart.
      seedHeldBooking();
      component.showReservationModal = true;

      component.beginAddAnotherTable();

      expect(component.addAnotherTablePending).toBe(true);
      expect(component.showReservationModal).toBe(true);
    });

    it('Phase 2: pickerAvailableTables filters AVAILABLE and excludes already-selected', () => {
      const tableA = { id: 'A1', price: 100, section: 'A', status: 'AVAILABLE' } as any;
      const tableB = { id: 'B2', price: 150, section: 'B', status: 'AVAILABLE' } as any;
      const tableC = { id: 'C3', price: 200, section: 'C', status: 'HOLD' } as any;
      const tableD = { id: 'D4', price: 250, section: 'D', status: 'RESERVED' } as any;
      const tableE = { id: 'E5', price: 300, section: 'E', status: 'AVAILABLE' } as any;
      component.tables = [tableA, tableB, tableC, tableD, tableE];
      // Staff is already holding A1, so A1 must NOT appear in the picker
      // (would just no-op on tap).
      component.selectedTables = [tableA];

      const picker = component.pickerAvailableTables();

      // Only B2 + E5: A1 excluded by selectedTables, C3 + D4 by status.
      expect(picker.map((t) => t.id)).toEqual(['B2', 'E5']);
    });
  });

  describe('releaseHold empty-entries cleanup (B3)', () => {
    it('clears local hold flags + closes modal when no entries to release', () => {
      component.eventDate = '2026-05-09';
      component.selectedTables = [];
      component.holdEntries = [];
      component.selectedTable = null;
      component.holdId = 'stale-id';
      component.holdExpiresAt = 1700000000;
      component.holdCountdown = 42;
      component.holdExpired = true;
      component.holdCreatedByMe = true;
      component.showReleaseConfirm = true;
      component.showReservationModal = true;

      component.releaseHold();

      // Empty-entries branch must STILL clear local state — otherwise the
      // user clicks Release and sees no UI feedback (silent no-op bug).
      expect(component.holdId).toBeNull();
      expect(component.holdExpiresAt).toBeNull();
      expect(component.holdExpired).toBe(false);
      expect(component.holdCreatedByMe).toBe(false);
      expect(component.holdCountdown).toBe(0);
      expect(component.showReleaseConfirm).toBe(false);
      expect(component.showReservationModal).toBe(false);
    });
  });
});

describe('ReservationsNew confirmReservation double-fire guard (C1)', () => {
  let component: ReservationsNew;
  let fixture: ComponentFixture<ReservationsNew>;
  let createSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    createSpy = vi.fn(() => NEVER);
    const reservationsStub: Partial<ReservationsService> = {
      create: createSpy as any,
    };

    await TestBed.configureTestingModule({
      imports: [ReservationsNew],
      providers: [
        provideRouter([]),
        { provide: HoldsService, useValue: makeHoldsStub() },
        { provide: TablesService, useValue: makeTablesStub() },
        { provide: ReservationsService, useValue: reservationsStub },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: of(convertToParamMap({})),
            paramMap: of(convertToParamMap({})),
            snapshot: {
              queryParamMap: convertToParamMap({}),
              paramMap: convertToParamMap({}),
            },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ReservationsNew);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('credit + cash remainder sends receiptNumber to the addPayment cash leg', async () => {
    // Build a stubbed ReservationsService that emits a synthetic create
    // response then captures both addPayment calls. The credit leg has no
    // receipt number; the cash remainder leg MUST carry the staff-entered
    // one — backend resolveCashReceiptNumberRequired() defaults to true,
    // so omitting it would 4xx after the credit was already applied.
    const addPaymentSpy = vi.fn((_payload: any) => of(undefined));
    const createSpy2 = vi.fn((_payload: any) =>
      of({
        item: { reservationId: 'r-99', eventDate: '2026-05-09', tableId: 'A1' },
        autoSquareLinkSms: null,
      } as any)
    );
    const reservationsStub: Partial<ReservationsService> = {
      create: createSpy2 as any,
      addPayment: addPaymentSpy as any,
    };
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ReservationsNew],
      providers: [
        provideRouter([]),
        { provide: HoldsService, useValue: makeHoldsStub() },
        { provide: TablesService, useValue: makeTablesStub() },
        { provide: ReservationsService, useValue: reservationsStub },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: of(convertToParamMap({})),
            paramMap: of(convertToParamMap({})),
            snapshot: { queryParamMap: convertToParamMap({}), paramMap: convertToParamMap({}) },
          },
        },
      ],
    }).compileComponents();
    const f = TestBed.createComponent(ReservationsNew);
    const c = f.componentInstance;
    await f.whenStable();

    const tableA = { id: 'A1', price: 200, section: 'A', status: 'HOLD' } as any;
    c.eventDate = '2026-05-09';
    c.selectedTable = tableA;
    c.selectedTableId = 'A1';
    c.selectedTables = [tableA];
    c.holdId = 'h-a1';
    c.holdExpiresAt = Math.floor(Date.now() / 1000) + 300;
    c.holdEntries = [
      { tableId: 'A1', holdId: 'h-a1', holdExpiresAt: c.holdExpiresAt, holdCreatedByMe: true },
    ];
    c.holdCreatedByMe = true;
    c.cashReceiptNumberRequired = true;
    c.form.controls.customerName.setValue('Test');
    c.form.controls.phone.setValue('5125551212');
    c.form.controls.amountDue.setValue(200);
    c.form.controls.useCredit.setValue(true);
    c.form.controls.creditId.setValue('credit-1');
    c.form.controls.remainingMethod.setValue('cash');
    c.form.controls.receiptNumber.setValue('R-123');
    c.clientCredits = [
      { creditId: 'credit-1', remainingAmount: 50, status: 'ACTIVE', amountRemaining: 50 } as any,
    ];

    c.confirmReservation();

    expect(createSpy2).toHaveBeenCalledTimes(1);
    expect(addPaymentSpy).toHaveBeenCalledTimes(2);
    // First call applies the credit; second collects the cash remainder.
    const creditCall = addPaymentSpy.mock.calls[0]![0]! as any;
    const cashCall = addPaymentSpy.mock.calls[1]![0]! as any;
    expect(creditCall.method).toBe('credit');
    expect(creditCall.creditId).toBe('credit-1');
    expect(cashCall.method).toBe('cash');
    expect(cashCall.amount).toBe(150);
    // normalizedReceiptNumber strips non-digits.
    expect(cashCall.receiptNumber).toBe('123');
  });

  it('fires ReservationsService.create exactly once on rapid double-click', () => {
    // Seed enough state to bypass all the synchronous validation gates
    // in confirmReservation so we reach the actual POST.
    const tableA = { id: 'A1', price: 100, section: 'A', status: 'HOLD' } as any;
    component.eventDate = '2026-05-09';
    component.selectedTable = tableA;
    component.selectedTableId = 'A1';
    component.selectedTables = [tableA];
    component.holdId = 'h-a1';
    component.holdExpiresAt = Math.floor(Date.now() / 1000) + 300;
    component.holdEntries = [
      { tableId: 'A1', holdId: 'h-a1', holdExpiresAt: component.holdExpiresAt, holdCreatedByMe: true },
    ];
    component.holdCreatedByMe = true;
    component.form.controls.customerName.setValue('Test');
    component.form.controls.phone.setValue('5125551212');
    component.form.controls.amountDue.setValue(100);
    component.form.controls.depositAmount.setValue(100);
    component.form.controls.paymentStatus.setValue('PAID');
    component.form.controls.paymentMethod.setValue('cash');

    // Two rapid invocations — the second must be a no-op because the
    // backend's idempotency replay still triggers FE state churn through
    // the next: callback (the bug C1 addresses).
    component.confirmReservation();
    component.confirmReservation();

    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
