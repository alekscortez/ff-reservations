import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PaymentStatus, ReservationItem } from '@ff/core';
import { useEventsList } from '@/lib/api/events';
import { useReservationsList } from '@/lib/api/reservations';
import { useEventContext } from '@/lib/api/settings';
import { ApiError } from '@/lib/api-client';

const PAYMENT_STATUS_CLASS: Record<PaymentStatus, string> = {
  PAID: 'border-success-200 bg-success-100 text-success-700',
  PARTIAL: 'border-amber-300 bg-amber-50 text-amber-900',
  PENDING: 'border-border bg-muted text-muted-foreground',
  COURTESY: 'border-border bg-muted/40 text-brand-700',
  REFUNDED: 'border-rose-200 bg-rose-50 text-rose-700',
};

const RESERVATION_STATUS_CANCELLED = 'CANCELLED' as const;

function formatDeadline(value: string | null | undefined, eventDate: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '—';
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return raw;
  const [, ymd, hh, mm] = m;
  const date = new Date(`${ymd}T${hh}:${mm}:00`);
  if (Number.isNaN(date.getTime())) return raw;
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  // If the deadline is the day after the event, show "+1 day" badge inline
  // (matches Angular's "12:00 AM (+1 DAY)" rendering).
  const eventDay = String(eventDate ?? '').trim();
  let dayOffsetLabel = '';
  if (eventDay && /^\d{4}-\d{2}-\d{2}$/.test(eventDay)) {
    const evt = new Date(`${eventDay}T00:00:00`);
    const diffMs = date.getTime() - evt.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays > 0) dayOffsetLabel = ` (+${diffDays} DAY${diffDays === 1 ? '' : 'S'})`;
  }
  return `${time}${dayOffsetLabel}`;
}

function formatRowEpoch(epoch: number | null | undefined): string {
  if (!epoch || !Number.isFinite(epoch)) return '—';
  const date = new Date(epoch * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function paidTotalFromReservation(r: ReservationItem): number {
  const payments = Array.isArray(r.payments) ? r.payments : [];
  if (payments.length === 0) return Number(r.depositAmount ?? 0);
  return payments.reduce((sum, p) => sum + (Number(p?.amount) || 0), 0);
}

function remainingAmount(r: ReservationItem): number {
  const due = Number(r.amountDue ?? 0);
  const paid = paidTotalFromReservation(r);
  return Math.max(0, Number((due - paid).toFixed(2)));
}

function isThisWeek(eventDate: string | null | undefined): boolean {
  if (!eventDate) return false;
  const d = new Date(`${eventDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  // Monday-anchored ISO week.
  const dayIdx = (today.getDay() + 6) % 7;
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - dayIdx);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return d >= start && d <= end;
}

function canTakePayment(r: ReservationItem): boolean {
  if (r.status === RESERVATION_STATUS_CANCELLED) return false;
  const ps = r.paymentStatus ?? 'PENDING';
  return ps === 'PENDING' || ps === 'PARTIAL';
}

export function StaffReservations() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { data: events, isLoading: eventsLoading, refetch: refetchEvents } =
    useEventsList();
  const { data: ctx } = useEventContext();
  const businessDate = ctx?.businessDate || new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [manualDate, setManualDate] = useState<string>('');
  const [activeDate, setActiveDate] = useState<string>('');

  const sortedEvents = useMemo(() => {
    if (!events) return [];
    return [...events]
      .filter((e) => e.status === 'ACTIVE')
      .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  }, [events]);

  const upcomingEvents = useMemo(() => {
    return sortedEvents
      .filter((e) => e.eventDate >= businessDate)
      .slice(0, 3);
  }, [sortedEvents, businessDate]);

  // Default selection: ctx.event > ctx.nextEvent > next upcoming.
  useEffect(() => {
    if (selectedDate || activeDate) return;
    const ctxPick = ctx?.event?.eventDate || ctx?.nextEvent?.eventDate;
    if (ctxPick) {
      setSelectedDate(ctxPick);
      setActiveDate(ctxPick);
      return;
    }
    if (sortedEvents.length === 0) return;
    const nextUpcoming =
      sortedEvents.find((e) => e.eventDate >= businessDate) ?? sortedEvents[0];
    setSelectedDate(nextUpcoming.eventDate);
    setActiveDate(nextUpcoming.eventDate);
  }, [selectedDate, activeDate, ctx, sortedEvents, businessDate]);

  const {
    data: reservations,
    isLoading: reservationsLoading,
    error,
  } = useReservationsList(activeDate || undefined);

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    day: 'numeric',
  });
  const fullDateFormatter = new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  function selectEvent(eventDate: string) {
    setSelectedDate(eventDate);
    setActiveDate(eventDate);
    setManualDate('');
  }

  function loadManualDate() {
    if (!manualDate) return;
    setSelectedDate('');
    setActiveDate(manualDate);
  }

  function clearManualDate() {
    setManualDate('');
    if (!selectedDate) setActiveDate('');
  }

  return (
    <main className="min-h-screen bg-brand-50 p-6 sm:p-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <header>
          <h1 className="text-2xl font-semibold text-brand-900">
            {t('reservations.listTitle')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('reservations.subtitle')}
          </p>
        </header>

        <section className="rounded-2xl border border-border bg-background p-4 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-brand-900">
              {t('reservations.selectEvent')}
            </h2>
            <button
              type="button"
              onClick={() => refetchEvents()}
              disabled={eventsLoading}
              aria-label={t('reservations.refresh')}
              title={t('reservations.refresh')}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border text-brand-900 hover:bg-muted disabled:opacity-50"
            >
              ↻
            </button>
          </div>

          {eventsLoading && (
            <p className="mt-3 text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          )}

          {!eventsLoading && upcomingEvents.length > 0 && (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {upcomingEvents.map((e) => {
                const selected = activeDate === e.eventDate;
                const thisWeek = !selected && isThisWeek(e.eventDate);
                return (
                  <button
                    key={e.eventId}
                    type="button"
                    onClick={() => selectEvent(e.eventDate)}
                    className={`rounded-2xl border p-4 text-left shadow-sm transition ${
                      selected
                        ? 'border-2 border-brand-900 bg-brand-50'
                        : thisWeek
                          ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
                          : 'border-border bg-background hover:border-primary/60'
                    }`}
                  >
                    <p className="text-xl font-semibold text-brand-900">
                      {dateFormatter.format(new Date(e.eventDate + 'T00:00:00'))}
                    </p>
                    <p className="text-xs text-muted-foreground">{e.eventDate}</p>
                    <p className="mt-2 text-sm font-semibold text-brand-900">
                      {e.eventName}
                    </p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                      {e.status || 'ACTIVE'}
                    </p>
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-4 h-px w-full bg-border" />

          <p className="mt-3 text-xs uppercase tracking-[0.16em] text-muted-foreground">
            {t('reservations.manualLookup')}
          </p>
          <div className="mt-2 grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('reservations.eventDate')}
              <input
                type="date"
                value={manualDate}
                onChange={(e) => setManualDate(e.target.value)}
                className="h-11 rounded-lg border border-border bg-background px-3 text-sm text-brand-900"
              />
            </label>
            <button
              type="button"
              disabled={!manualDate}
              onClick={loadManualDate}
              className="h-11 rounded-lg bg-brand-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {t('reservations.load')}
            </button>
            <button
              type="button"
              onClick={clearManualDate}
              className="h-11 rounded-lg border border-border px-4 text-sm text-brand-900 hover:bg-muted"
            >
              {t('reservations.clear')}
            </button>
          </div>

          {error && (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {error instanceof ApiError ? `${error.status}: ${error.message}` : t('common.error')}
            </p>
          )}

          {!activeDate ? null : reservationsLoading ? (
            <p className="mt-4 text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : !reservations || reservations.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {t('reservations.empty')}
            </p>
          ) : (
            <>
              {/* Desktop: table layout. Mobile: card layout below lg. */}
              <div className="mt-4 hidden overflow-x-auto lg:block">
                <table className="w-full border-collapse text-left text-sm text-brand-900">
                  <thead className="border-b border-border text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    <tr>
                      <th className="py-3 pr-3">{t('reservations.col.reservation')}</th>
                      <th className="py-3 pr-3">{t('reservations.col.payment')}</th>
                      <th className="py-3 pr-3">{t('reservations.col.remaining')}</th>
                      <th className="py-3 pr-3">{t('reservations.col.deadline')}</th>
                      <th className="py-3 pr-3">{t('reservations.col.updated')}</th>
                      <th className="py-3 pr-3">{t('reservations.col.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reservations.map((r) => {
                      const cancelled = r.status === RESERVATION_STATUS_CANCELLED;
                      const ps = (r.paymentStatus ?? 'PENDING') as PaymentStatus;
                      return (
                        <tr
                          key={r.reservationId}
                          tabIndex={0}
                          role="button"
                          onClick={() =>
                            navigate(
                              `/staff/reservations/${r.eventDate}/${r.reservationId}`
                            )
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              navigate(
                                `/staff/reservations/${r.eventDate}/${r.reservationId}`
                              );
                            }
                          }}
                          className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/30 focus-within:bg-muted/30"
                        >
                          <td className="py-3 pr-3">
                            <p
                              className={`font-semibold ${cancelled ? 'text-muted-foreground line-through' : 'text-brand-900'}`}
                            >
                              {t('reservations.tableShort')} {r.tableId} · {r.customerName}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {cancelled
                                ? t('reservations.cancelledLine')
                                : ps === 'COURTESY'
                                  ? t('reservations.courtesyLine')
                                  : t('reservations.metaLine', {
                                      status: t(`reservations.paymentStatus.${ps}`),
                                      amount: moneyFormatter.format(Number(r.amountDue ?? 0)),
                                    })}
                            </p>
                          </td>
                          <td className="py-3 pr-3">
                            <span
                              className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PAYMENT_STATUS_CLASS[ps]}`}
                            >
                              {cancelled
                                ? t('reservations.paymentStatus.CANCELLED')
                                : t(`reservations.paymentStatus.${ps}`)}
                            </span>
                          </td>
                          <td className="py-3 pr-3 font-semibold text-brand-900">
                            {moneyFormatter.format(remainingAmount(r))}
                          </td>
                          <td className="py-3 pr-3">
                            {formatDeadline(r.paymentDeadlineAt, r.eventDate)}
                          </td>
                          <td className="py-3 pr-3 text-xs text-muted-foreground">
                            {formatRowEpoch(r.updatedAt ?? r.createdAt)}
                          </td>
                          <td
                            className="py-3 pr-3"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              disabled={!canTakePayment(r)}
                              onClick={() =>
                                navigate(
                                  `/staff/reservations/${r.eventDate}/${r.reservationId}#payment`
                                )
                              }
                              className="rounded-lg bg-brand-900 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {t('reservations.takePayment')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards (below lg) */}
              <div className="mt-4 grid gap-3 lg:hidden">
                {reservations.map((r) => {
                  const cancelled = r.status === RESERVATION_STATUS_CANCELLED;
                  const ps = (r.paymentStatus ?? 'PENDING') as PaymentStatus;
                  return (
                    <Link
                      key={r.reservationId}
                      to={`/staff/reservations/${r.eventDate}/${r.reservationId}`}
                      className="rounded-xl border border-border bg-background p-4 shadow-sm transition-colors hover:bg-muted/30"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <p
                          className={`text-base font-semibold ${cancelled ? 'text-muted-foreground line-through' : 'text-brand-900'}`}
                        >
                          {t('reservations.tableShort')} {r.tableId} · {r.customerName}
                        </p>
                        <span
                          className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PAYMENT_STATUS_CLASS[ps]}`}
                        >
                          {cancelled
                            ? t('reservations.paymentStatus.CANCELLED')
                            : t(`reservations.paymentStatus.${ps}`)}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-1 text-sm text-brand-700">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            {t('reservations.col.remaining')}
                          </span>
                          <span className="font-semibold">
                            {moneyFormatter.format(remainingAmount(r))}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            {t('reservations.col.deadline')}
                          </span>
                          <span>
                            {formatDeadline(r.paymentDeadlineAt, r.eventDate)}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {fullDateFormatter.format(
                            new Date((r.updatedAt ?? r.createdAt ?? 0) * 1000)
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={!canTakePayment(r)}
                        onClick={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          navigate(
                            `/staff/reservations/${r.eventDate}/${r.reservationId}#payment`
                          );
                        }}
                        className="mt-3 h-10 rounded-lg bg-brand-900 px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t('reservations.takePayment')}
                      </button>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
