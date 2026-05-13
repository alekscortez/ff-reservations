import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { EventsService } from '../../../core/http/events.service';
import { ReservationsService } from '../../../core/http/reservations.service';
import { EventItem } from '../../../shared/models/event.model';
import {
  ReservationItem,
  ReservationPayment,
  ReservationRefundResult,
} from '../../../shared/models/reservation.model';

import { Financials } from './financials';

// Fixture builders -----------------------------------------------------------

function makeEvent(overrides: Partial<EventItem> = {}): EventItem {
  return {
    eventId: 'evt-1',
    eventDate: '2026-05-09',
    eventName: 'Test Event',
    status: 'ACTIVE',
    minDeposit: 50,
    ...overrides,
  } as EventItem;
}

function makePayment(overrides: Partial<ReservationPayment> = {}): ReservationPayment {
  return {
    paymentId: 'pmt-' + Math.random().toString(36).slice(2, 8),
    amount: 50,
    method: 'square',
    source: 'square-direct',
    createdAt: 1700000000,
    createdBy: 'staff@example.com',
    ...overrides,
  };
}

function makeRefund(overrides: Partial<ReservationRefundResult> = {}): ReservationRefundResult {
  return {
    paymentLocalId: 'pmt-1',
    providerPaymentId: 'sq-pmt-1',
    amount: 50,
    method: 'square',
    refundId: 'sq-refund-1',
    refundStatus: 'COMPLETED',
    success: true,
    ...overrides,
  };
}

function makeReservation(overrides: Partial<ReservationItem> = {}): ReservationItem {
  return {
    reservationId: 'r-' + Math.random().toString(36).slice(2, 8),
    eventDate: '2026-05-09',
    tableId: 'A1',
    customerName: 'Alice',
    phone: '+15551234567',
    depositAmount: 0,
    tablePrice: 100,
    amountDue: 100,
    paymentStatus: 'PENDING',
    paymentDeadlineAt: '2026-05-09T18:00',
    paymentDeadlineTz: 'America/Chicago',
    status: 'CONFIRMED',
    createdAt: 1700000000,
    ...overrides,
  };
}

// Tests ----------------------------------------------------------------------

describe('Financials', () => {
  let component: Financials;
  let fixture: ComponentFixture<Financials>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Financials],
      providers: [
        provideRouter([]),
        {
          provide: EventsService,
          useValue: {
            listEvents: () => of([]),
          },
        },
        {
          provide: ReservationsService,
          useValue: {
            list: () => of([]),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Financials);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  // buildRows --------------------------------------------------------------

  describe('buildRows', () => {
    it('carries refundedAmount and REFUNDED paymentStatus through', () => {
      const event = makeEvent();
      const reservation = makeReservation({
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
        depositAmount: 100,
        refundedAmount: 100,
        payments: [makePayment({ amount: 100 })],
        refunds: [makeRefund({ amount: 100 })],
      });
      const rows = (component as any).buildRows([{ event, reservations: [reservation] }]);
      expect(rows[0].paymentStatus).toBe('REFUNDED');
      expect(rows[0].refundedAmount).toBe(100);
      expect(rows[0].status).toBe('CANCELLED');
    });

    it('multi-table amountDue falls back to tablePrice sum when missing', () => {
      const event = makeEvent();
      const reservation = makeReservation({
        tableId: 'A1',
        tableIds: ['A1', 'A2'],
        tablePrice: 200,
        amountDue: undefined as unknown as number,
      });
      const rows = (component as any).buildRows([{ event, reservations: [reservation] }]);
      expect(rows[0].amountDue).toBe(200);
      expect(rows[0].tableIds).toEqual(['A1', 'A2']);
    });

    it('classifies isDueSoon within 24h and isOverdue past deadline', () => {
      const now = Date.now();
      const inOneHour = new Date(now + 60 * 60 * 1000);
      const oneHourAgo = new Date(now - 60 * 60 * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const event = makeEvent();
      const dueSoon = makeReservation({
        reservationId: 'soon',
        paymentDeadlineAt: fmt(inOneHour),
      });
      const overdue = makeReservation({
        reservationId: 'late',
        paymentDeadlineAt: fmt(oneHourAgo),
      });
      const rows = (component as any).buildRows([
        { event, reservations: [dueSoon, overdue] },
      ]);
      const soonRow = rows.find((r: any) => r.reservationId === 'soon');
      const lateRow = rows.find((r: any) => r.reservationId === 'late');
      expect(soonRow.isDueSoon).toBe(true);
      expect(soonRow.isOverdue).toBe(false);
      expect(lateRow.isOverdue).toBe(true);
      expect(lateRow.isDueSoon).toBe(false);
    });
  });

  // buildReceivables -------------------------------------------------------

  describe('buildReceivables', () => {
    it('excludes COURTESY, PAID, REFUNDED, and CANCELLED rows', () => {
      const rows = [
        { status: 'CONFIRMED', paymentStatus: 'PENDING', balance: 50, deadlineMs: 1 },
        { status: 'CONFIRMED', paymentStatus: 'PARTIAL', balance: 25, deadlineMs: 2 },
        { status: 'CONFIRMED', paymentStatus: 'PAID', balance: 0, deadlineMs: 3 },
        { status: 'CONFIRMED', paymentStatus: 'COURTESY', balance: 0, deadlineMs: 4 },
        { status: 'CANCELLED', paymentStatus: 'REFUNDED', balance: 0, deadlineMs: 5 },
      ];
      const receivables = (component as any).buildReceivables(rows);
      expect(receivables.length).toBe(2);
      expect(receivables.map((r: any) => r.paymentStatus)).toEqual(['PENDING', 'PARTIAL']);
    });
  });

  // buildMethodTotals ------------------------------------------------------

  describe('buildMethodTotals', () => {
    it('splits cash / square / cashapp / credit and excludes refunded reservations from charge buckets', () => {
      const event = makeEvent();
      const reservations: ReservationItem[] = [
        makeReservation({
          reservationId: 'r1',
          depositAmount: 100,
          payments: [
            makePayment({ method: 'cash', amount: 40 }),
            makePayment({ method: 'square', amount: 30 }),
            makePayment({ method: 'cashapp', amount: 20 }),
            makePayment({ method: 'credit', amount: 10, source: 'reschedule-credit' }),
          ],
        }),
        makeReservation({
          reservationId: 'r2',
          status: 'CANCELLED',
          paymentStatus: 'REFUNDED',
          depositAmount: 75,
          refundedAmount: 75,
          payments: [makePayment({ method: 'square', amount: 75 })],
          refunds: [makeRefund({ amount: 75 })],
        }),
      ];
      const totals = (component as any).buildMethodTotals([{ event, reservations }]);
      expect(totals).toEqual({
        cash: 40,
        square: 30,
        cashapp: 20,
        credit: 10,
        refunds: 75,
      });
    });

    it('uses legacy paymentMethod + depositAmount when payments[] is missing', () => {
      const event = makeEvent();
      const reservations = [
        makeReservation({
          reservationId: 'legacy-cash',
          depositAmount: 50,
          paymentMethod: 'cash',
        }),
        makeReservation({
          reservationId: 'legacy-cashapp',
          depositAmount: 25,
          paymentMethod: 'cashapp',
        }),
        makeReservation({
          reservationId: 'legacy-credit',
          depositAmount: 15,
          paymentMethod: 'credit',
        }),
      ];
      const totals = (component as any).buildMethodTotals([{ event, reservations }]);
      expect(totals.cash).toBe(50);
      expect(totals.cashapp).toBe(25);
      expect(totals.credit).toBe(15);
      expect(totals.square).toBe(0);
    });

    it('ignores failed refunds when summing the refunds bucket', () => {
      const event = makeEvent();
      const reservation = makeReservation({
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
        depositAmount: 100,
        refundedAmount: 60,
        payments: [makePayment({ amount: 100 })],
        refunds: [
          makeRefund({ amount: 60, success: true }),
          makeRefund({ amount: 40, success: false }),
        ],
      });
      const totals = (component as any).buildMethodTotals([
        { event, reservations: [reservation] },
      ]);
      expect(totals.refunds).toBe(60);
    });
  });

  // buildPaymentLedger -----------------------------------------------------

  describe('buildPaymentLedger', () => {
    it('preserves cashapp method instead of collapsing to square', () => {
      const event = makeEvent();
      const reservation = makeReservation({
        depositAmount: 25,
        payments: [makePayment({ method: 'cashapp', amount: 25, source: 'square-direct' })],
      });
      const ledger = (component as any).buildPaymentLedger([
        { event, reservations: [reservation] },
      ]);
      expect(ledger.length).toBe(1);
      expect(ledger[0].method).toBe('cashapp');
    });

    it('emits credit-method payments with source=reschedule-credit', () => {
      const event = makeEvent();
      const reservation = makeReservation({
        depositAmount: 30,
        payments: [makePayment({ method: 'credit', amount: 30, source: 'reschedule-credit' })],
      });
      const ledger = (component as any).buildPaymentLedger([
        { event, reservations: [reservation] },
      ]);
      expect(ledger.length).toBe(1);
      expect(ledger[0].method).toBe('credit');
      expect(ledger[0].source).toBe('reschedule-credit');
      expect(ledger[0].isRefund).toBe(false);
    });

    it('appends one negative-amount refund row per successful refund', () => {
      const event = makeEvent();
      const reservation = makeReservation({
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
        depositAmount: 100,
        refundedAmount: 100,
        refundedAt: 1700001000,
        refundedBy: 'admin@example.com',
        payments: [makePayment({ method: 'square', amount: 100 })],
        refunds: [
          makeRefund({ amount: 60, success: true, refundId: 'rf1' }),
          makeRefund({ amount: 40, success: true, refundId: 'rf2' }),
          makeRefund({ amount: 999, success: false }),
        ],
      });
      const ledger = (component as any).buildPaymentLedger([
        { event, reservations: [reservation] },
      ]);
      const charges = ledger.filter((r: any) => !r.isRefund);
      const refunds = ledger.filter((r: any) => r.isRefund);
      expect(charges.length).toBe(1);
      expect(charges[0].amount).toBe(100);
      expect(refunds.length).toBe(2);
      expect(refunds.map((r: any) => r.amount).sort((a: number, b: number) => a - b)).toEqual([
        -60,
        -40,
      ]);
      expect(refunds.every((r: any) => r.source === 'square-refund')).toBe(true);
      expect(refunds.every((r: any) => r.createdAt === 1700001000)).toBe(true);
      expect(refunds.every((r: any) => r.createdBy === 'admin@example.com')).toBe(true);
    });

    it('preserves cashapp on refund rows when the refunded payment was Cash App', () => {
      const event = makeEvent();
      const reservation = makeReservation({
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
        depositAmount: 50,
        refundedAmount: 50,
        payments: [makePayment({ method: 'cashapp', amount: 50 })],
        refunds: [makeRefund({ amount: 50, method: 'cashapp' })],
      });
      const ledger = (component as any).buildPaymentLedger([
        { event, reservations: [reservation] },
      ]);
      const refund = ledger.find((r: any) => r.isRefund);
      expect(refund.method).toBe('cashapp');
    });

    it('renders legacy depositAmount fallback when payments[] is missing', () => {
      const event = makeEvent();
      const reservation = makeReservation({
        reservationId: 'legacy',
        depositAmount: 40,
        paymentMethod: 'cash',
      });
      const ledger = (component as any).buildPaymentLedger([
        { event, reservations: [reservation] },
      ]);
      expect(ledger.length).toBe(1);
      expect(ledger[0].isFallback).toBe(true);
      expect(ledger[0].method).toBe('cash');
      expect(ledger[0].source).toBe('manual');
    });
  });

  // buildOverview ----------------------------------------------------------

  describe('buildOverview', () => {
    it('netCollected = collected − refunded; refunded reservations exit confirmed counts', () => {
      const event = makeEvent();
      const confirmed = makeReservation({
        reservationId: 'r1',
        depositAmount: 80,
        amountDue: 100,
        paymentStatus: 'PARTIAL',
        payments: [makePayment({ amount: 80 })],
      });
      const refunded = makeReservation({
        reservationId: 'r2',
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
        depositAmount: 100,
        amountDue: 100,
        refundedAmount: 100,
        payments: [makePayment({ amount: 100 })],
        refunds: [makeRefund({ amount: 100 })],
      });
      const rows = (component as any).buildRows([
        { event, reservations: [confirmed, refunded] },
      ]);
      const receivables = (component as any).buildReceivables(rows);
      const overview = (component as any).buildOverview([event], rows, receivables);
      expect(overview.collected).toBe(80);
      expect(overview.refunded).toBe(100);
      expect(overview.netCollected).toBe(-20);
      expect(overview.confirmed).toBe(1);
      expect(overview.reservations).toBe(2);
    });
  });

  // buildEventSummaries ----------------------------------------------------

  describe('buildEventSummaries', () => {
    it('rolls up expected/collected/outstanding/overdue per event', () => {
      const event = makeEvent({ status: 'ACTIVE' });
      const overdue = makeReservation({
        reservationId: 'r-overdue',
        depositAmount: 50,
        amountDue: 100,
        paymentStatus: 'PARTIAL',
        paymentDeadlineAt: '2020-01-01T00:00',
      });
      const paid = makeReservation({
        reservationId: 'r-paid',
        depositAmount: 100,
        amountDue: 100,
        paymentStatus: 'PAID',
      });
      const rows = (component as any).buildRows([
        { event, reservations: [overdue, paid] },
      ]);
      const receivables = (component as any).buildReceivables(rows);
      const summaries = (component as any).buildEventSummaries([event], rows, receivables);
      expect(summaries.length).toBe(1);
      const s = summaries[0];
      expect(s.confirmed).toBe(2);
      expect(s.expected).toBe(200);
      expect(s.collected).toBe(150);
      expect(s.outstanding).toBe(50);
      expect(s.overdue).toBe(50);
    });
  });

  // Source label normalization -------------------------------------------

  describe('source labels', () => {
    it('formats square-refund as "Square Refund" with danger badge', () => {
      expect(component.formatSourceLabel('square-refund')).toBe('Square Refund');
      expect(component.sourceBadgeClass('square-refund')).toContain('danger');
    });
  });
});
