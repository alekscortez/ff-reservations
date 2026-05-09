import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconRefresh } from '@tabler/icons-react';
import type { PaymentStatus, ReservationItem } from '@ff/core';
import { useEventsList } from '@/lib/api/events';
import { useReservationsList } from '@/lib/api/reservations';
import { useEventContext } from '@/lib/api/settings';
import { ApiError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PAYMENT_STATUS_BADGE: Record<PaymentStatus, string> = {
  PAID: 'border-success-200 bg-success-100/60 text-success-700',
  PARTIAL: 'border-amber-300 bg-amber-50 text-amber-900',
  PENDING: 'border-border bg-muted text-muted-foreground',
  COURTESY: 'border-border bg-muted/40 text-foreground',
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
  let dayOffsetLabel = '';
  if (eventDate && /^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    const evt = new Date(`${eventDate}T00:00:00`);
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
  const { data: events, isLoading: eventsLoading, refetch: refetchEvents } = useEventsList();
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
    return sortedEvents.filter((e) => e.eventDate >= businessDate).slice(0, 3);
  }, [sortedEvents, businessDate]);

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
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">
          {t('reservations.listTitle')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('reservations.subtitle')}
        </p>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('reservations.selectEvent')}</CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => refetchEvents()}
            disabled={eventsLoading}
            aria-label={t('reservations.refresh')}
            title={t('reservations.refresh')}
          >
            <IconRefresh className="size-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {eventsLoading && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}

          {!eventsLoading && upcomingEvents.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                        ? 'border-2 border-foreground bg-muted/40'
                        : thisWeek
                          ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
                          : 'border-border bg-background hover:border-foreground/40'
                    }`}
                  >
                    <p className="text-xl font-semibold text-foreground">
                      {dateFormatter.format(new Date(e.eventDate + 'T00:00:00'))}
                    </p>
                    <p className="text-xs text-muted-foreground">{e.eventDate}</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">
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

          <Separator />

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t('reservations.manualLookup')}
            </p>
            <div className="mt-2 grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
              <div className="grid gap-1.5">
                <Label className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  {t('reservations.eventDate')}
                </Label>
                <Input
                  type="date"
                  value={manualDate}
                  onChange={(e) => setManualDate(e.target.value)}
                  className="h-11"
                />
              </div>
              <Button
                type="button"
                disabled={!manualDate}
                onClick={loadManualDate}
                className="h-11"
              >
                {t('reservations.load')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={clearManualDate}
                className="h-11"
              >
                {t('reservations.clear')}
              </Button>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error instanceof ApiError ? `${error.status}: ${error.message}` : t('common.error')}
            </p>
          )}

          {!activeDate ? null : reservationsLoading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : !reservations || reservations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('reservations.empty')}</p>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto rounded-md border lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('reservations.col.reservation')}</TableHead>
                      <TableHead>{t('reservations.col.payment')}</TableHead>
                      <TableHead>{t('reservations.col.remaining')}</TableHead>
                      <TableHead>{t('reservations.col.deadline')}</TableHead>
                      <TableHead>{t('reservations.col.updated')}</TableHead>
                      <TableHead className="text-right">
                        {t('reservations.col.actions')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reservations.map((r) => {
                      const cancelled = r.status === RESERVATION_STATUS_CANCELLED;
                      const ps = (r.paymentStatus ?? 'PENDING') as PaymentStatus;
                      const badgeStatus = cancelled
                        ? 'CANCELLED'
                        : (t(`reservations.paymentStatus.${ps}`) as string);
                      const badgeClass = cancelled
                        ? 'border-rose-200 bg-rose-50 text-rose-700'
                        : PAYMENT_STATUS_BADGE[ps];
                      return (
                        <TableRow
                          key={r.reservationId}
                          tabIndex={0}
                          role="button"
                          onClick={() =>
                            navigate(`/staff/reservations/${r.eventDate}/${r.reservationId}`)
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              navigate(
                                `/staff/reservations/${r.eventDate}/${r.reservationId}`
                              );
                            }
                          }}
                          className="cursor-pointer"
                        >
                          <TableCell>
                            <p
                              className={`font-semibold ${cancelled ? 'text-muted-foreground line-through' : 'text-foreground'}`}
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
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={badgeClass}>
                              {cancelled
                                ? t('reservations.paymentStatus.CANCELLED')
                                : badgeStatus}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-semibold">
                            {moneyFormatter.format(remainingAmount(r))}
                          </TableCell>
                          <TableCell>
                            {formatDeadline(r.paymentDeadlineAt, r.eventDate)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatRowEpoch(r.updatedAt ?? r.createdAt)}
                          </TableCell>
                          <TableCell
                            className="text-right"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button
                              type="button"
                              size="sm"
                              disabled={!canTakePayment(r)}
                              onClick={() =>
                                navigate(
                                  `/staff/reservations/${r.eventDate}/${r.reservationId}#payment`
                                )
                              }
                            >
                              {t('reservations.takePayment')}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile cards */}
              <div className="grid gap-3 lg:hidden">
                {reservations.map((r) => {
                  const cancelled = r.status === RESERVATION_STATUS_CANCELLED;
                  const ps = (r.paymentStatus ?? 'PENDING') as PaymentStatus;
                  const badgeClass = cancelled
                    ? 'border-rose-200 bg-rose-50 text-rose-700'
                    : PAYMENT_STATUS_BADGE[ps];
                  return (
                    <Link
                      key={r.reservationId}
                      to={`/staff/reservations/${r.eventDate}/${r.reservationId}`}
                      className="block rounded-xl border bg-background p-4 shadow-sm transition-colors hover:bg-muted/30"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <p
                          className={`text-base font-semibold ${cancelled ? 'text-muted-foreground line-through' : 'text-foreground'}`}
                        >
                          {t('reservations.tableShort')} {r.tableId} · {r.customerName}
                        </p>
                        <Badge variant="outline" className={badgeClass}>
                          {cancelled
                            ? t('reservations.paymentStatus.CANCELLED')
                            : t(`reservations.paymentStatus.${ps}`)}
                        </Badge>
                      </div>
                      <div className="mt-2 grid gap-1 text-sm">
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
                          {formatRowEpoch(r.updatedAt ?? r.createdAt)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        disabled={!canTakePayment(r)}
                        onClick={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          navigate(
                            `/staff/reservations/${r.eventDate}/${r.reservationId}#payment`
                          );
                        }}
                        className="mt-3 w-full"
                      >
                        {t('reservations.takePayment')}
                      </Button>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
