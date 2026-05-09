import { useQuery } from '@tanstack/react-query';
import type { EventItem, ReservationItem } from '@ff/core';
import { useApiClient } from '@/lib/use-api-client';

export interface FinancialRow {
  eventId: string;
  eventName: string;
  eventDate: string;
  reservationId: string;
  status: 'CONFIRMED' | 'CANCELLED';
  paymentStatus: 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY' | 'REFUNDED' | null;
  tableId: string;
  customerName: string;
  phone: string;
  amountDue: number;
  paid: number;
  balance: number;
  tablePrice: number;
  paymentDeadlineAt: string | null;
  deadlineMs: number | null;
  isOverdue: boolean;
  isDueSoon: boolean;
  createdAt: number;
}

export interface EventSummary {
  eventId: string;
  eventName: string;
  eventDate: string;
  status: 'ACTIVE' | 'INACTIVE';
  reservations: number;
  confirmed: number;
  cancelled: number;
  expected: number;
  collected: number;
  outstanding: number;
  overdue: number;
  courtesyValue: number;
}

export interface OverviewKpis {
  eventsInRange: number;
  reservations: number;
  confirmed: number;
  collected: number;
  expected: number;
  outstanding: number;
  overdue: number;
  dueSoon: number;
  courtesyValue: number;
}

export interface MethodTotals {
  cash: number;
  square: number;
  cashapp: number;
  credit: number;
}

export interface FinancialsParams {
  fromDate: string | null;
  toDate: string | null;
  eventStatus: 'ALL' | 'ACTIVE' | 'INACTIVE';
}

export interface FinancialsData {
  filteredEvents: EventItem[];
  rows: FinancialRow[];
  receivables: FinancialRow[];
  eventSummaries: EventSummary[];
  overview: OverviewKpis;
  methodTotals: MethodTotals;
  warnings: string[];
}

const DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

function dueSoonTriage(deadline: string | null): { ms: number | null; overdue: boolean; due: boolean } {
  if (!deadline) return { ms: null, overdue: false, due: false };
  const parsed = Date.parse(deadline);
  if (!Number.isFinite(parsed)) return { ms: null, overdue: false, due: false };
  const now = Date.now();
  const diff = parsed - now;
  return {
    ms: parsed,
    overdue: diff <= 0,
    due: diff > 0 && diff <= DUE_SOON_WINDOW_MS,
  };
}

function buildRows(snapshots: { event: EventItem; reservations: ReservationItem[] }[]): FinancialRow[] {
  const rows: FinancialRow[] = [];
  for (const { event, reservations } of snapshots) {
    for (const res of reservations) {
      const amountDue = Number(res.amountDue ?? res.tablePrice ?? 0);
      const paid = Number(res.depositAmount ?? 0);
      const balance = Math.max(0, amountDue - paid);
      const triage = dueSoonTriage(res.paymentDeadlineAt ?? null);
      rows.push({
        eventId: event.eventId,
        eventName: event.eventName,
        eventDate: event.eventDate,
        reservationId: res.reservationId,
        status: res.status,
        paymentStatus: (res.paymentStatus ?? null) as FinancialRow['paymentStatus'],
        tableId: res.tableId,
        customerName: res.customerName,
        phone: res.phone,
        amountDue,
        paid,
        balance,
        tablePrice: Number(res.tablePrice ?? 0),
        paymentDeadlineAt: res.paymentDeadlineAt ?? null,
        deadlineMs: triage.ms,
        isOverdue:
          res.status === 'CONFIRMED' &&
          (res.paymentStatus === 'PENDING' || res.paymentStatus === 'PARTIAL') &&
          triage.overdue,
        isDueSoon:
          res.status === 'CONFIRMED' &&
          (res.paymentStatus === 'PENDING' || res.paymentStatus === 'PARTIAL') &&
          triage.due,
        createdAt: Number(res.createdAt ?? 0),
      });
    }
  }
  return rows;
}

function buildReceivables(rows: FinancialRow[]): FinancialRow[] {
  return rows
    .filter(
      (r) =>
        r.status === 'CONFIRMED' &&
        (r.paymentStatus === 'PENDING' || r.paymentStatus === 'PARTIAL') &&
        r.balance > 0
    )
    .sort((a, b) => {
      // overdue first, then due-soon, then by deadline asc
      if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
      if (a.isDueSoon !== b.isDueSoon) return a.isDueSoon ? -1 : 1;
      return (a.deadlineMs ?? Infinity) - (b.deadlineMs ?? Infinity);
    });
}

function sum(values: number[]): number {
  return values.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
}

function buildEventSummaries(
  events: EventItem[],
  rows: FinancialRow[]
): EventSummary[] {
  return events
    .map((event) => {
      const eventRows = rows.filter((r) => r.eventId === event.eventId);
      const confirmed = eventRows.filter((r) => r.status === 'CONFIRMED');
      const eventReceivables = confirmed.filter(
        (r) => (r.paymentStatus === 'PENDING' || r.paymentStatus === 'PARTIAL') && r.balance > 0
      );
      const expected = sum(confirmed.map((r) => r.amountDue));
      const collected = sum(confirmed.map((r) => r.paid));
      const outstanding = sum(eventReceivables.map((r) => r.balance));
      const overdue = sum(eventReceivables.filter((r) => r.isOverdue).map((r) => r.balance));
      const courtesyValue = sum(
        confirmed.filter((r) => r.paymentStatus === 'COURTESY').map((r) => r.tablePrice)
      );
      return {
        eventId: event.eventId,
        eventName: event.eventName,
        eventDate: event.eventDate,
        status: event.status,
        reservations: eventRows.length,
        confirmed: confirmed.length,
        cancelled: eventRows.length - confirmed.length,
        expected,
        collected,
        outstanding,
        overdue,
        courtesyValue,
      };
    })
    .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
}

function buildOverview(
  events: EventItem[],
  rows: FinancialRow[],
  receivables: FinancialRow[]
): OverviewKpis {
  const confirmed = rows.filter((r) => r.status === 'CONFIRMED');
  return {
    eventsInRange: events.length,
    reservations: rows.length,
    confirmed: confirmed.length,
    collected: sum(confirmed.map((r) => r.paid)),
    expected: sum(confirmed.map((r) => r.amountDue)),
    outstanding: sum(receivables.map((r) => r.balance)),
    overdue: sum(receivables.filter((r) => r.isOverdue).map((r) => r.balance)),
    dueSoon: sum(receivables.filter((r) => r.isDueSoon).map((r) => r.balance)),
    courtesyValue: sum(
      confirmed.filter((r) => r.paymentStatus === 'COURTESY').map((r) => r.tablePrice)
    ),
  };
}

function buildMethodTotals(
  snapshots: { event: EventItem; reservations: ReservationItem[] }[]
): MethodTotals {
  const totals: MethodTotals = { cash: 0, square: 0, cashapp: 0, credit: 0 };
  for (const { reservations } of snapshots) {
    for (const res of reservations) {
      for (const p of res.payments ?? []) {
        const amount = Number((p as { amount?: number }).amount ?? 0);
        if (!Number.isFinite(amount)) continue;
        const m = String((p as { method?: string }).method ?? '').toLowerCase();
        if (m === 'cash') totals.cash += amount;
        else if (m === 'square') totals.square += amount;
        else if (m === 'cashapp') totals.cashapp += amount;
        else if (m === 'credit') totals.credit += amount;
      }
    }
  }
  return totals;
}

export function useFinancials(params: FinancialsParams) {
  const api = useApiClient();
  return useQuery({
    queryKey: ['financials', params.fromDate, params.toDate, params.eventStatus],
    queryFn: async (): Promise<FinancialsData> => {
      const eventsRes = await api.get<{ items: EventItem[] }>('/events');
      const all = eventsRes.items ?? [];
      const filteredEvents = all
        .filter((e) => {
          if (params.eventStatus !== 'ALL' && e.status !== params.eventStatus) return false;
          if (params.fromDate && e.eventDate < params.fromDate) return false;
          if (params.toDate && e.eventDate > params.toDate) return false;
          return true;
        })
        .sort((a, b) => b.eventDate.localeCompare(a.eventDate));

      const warnings: string[] = [];
      const snapshots = await Promise.all(
        filteredEvents.map(async (event) => {
          try {
            const r = await api.get<{ items: ReservationItem[] }>('/reservations', {
              eventDate: event.eventDate,
            });
            return { event, reservations: r.items ?? [] };
          } catch (err) {
            warnings.push(
              `${event.eventDate} ${event.eventName}: ${(err as Error)?.message ?? 'fetch failed'}`
            );
            return { event, reservations: [] as ReservationItem[] };
          }
        })
      );

      const rows = buildRows(snapshots);
      const receivables = buildReceivables(rows);
      const eventSummaries = buildEventSummaries(filteredEvents, rows);
      const overview = buildOverview(filteredEvents, rows, receivables);
      const methodTotals = buildMethodTotals(snapshots);
      return {
        filteredEvents,
        rows,
        receivables,
        eventSummaries,
        overview,
        methodTotals,
        warnings,
      };
    },
  });
}
