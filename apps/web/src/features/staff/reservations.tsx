import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PaymentStatus, ReservationStatus } from '@ff/core';
import { useEventsList } from '@/lib/api/events';
import { useReservationsList } from '@/lib/api/reservations';
import { ApiError } from '@/lib/api-client';

const PAYMENT_STATUS_CLASS: Record<PaymentStatus, string> = {
  PAID: 'bg-success-100 text-success-700',
  PARTIAL: 'bg-accent text-accent-foreground',
  PENDING: 'bg-muted text-muted-foreground',
  COURTESY: 'bg-secondary text-secondary-foreground',
  REFUNDED: 'bg-danger-100 text-danger-700',
};

const STATUS_CLASS: Record<ReservationStatus, string> = {
  CONFIRMED: 'text-brand-900',
  CANCELLED: 'text-muted-foreground line-through',
};

export function StaffReservations() {
  const { t, i18n } = useTranslation();
  const { data: events, isLoading: eventsLoading } = useEventsList();
  const [selectedDate, setSelectedDate] = useState<string>('');

  const sortedEvents = useMemo(() => {
    if (!events) return [];
    return [...events]
      .filter((e) => e.status === 'ACTIVE')
      .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  }, [events]);

  useEffect(() => {
    if (!selectedDate && sortedEvents.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const nextUpcoming = sortedEvents.find((e) => e.eventDate >= today) ?? sortedEvents[0];
      setSelectedDate(nextUpcoming.eventDate);
    }
  }, [selectedDate, sortedEvents]);

  const {
    data: reservations,
    isLoading: reservationsLoading,
    error,
  } = useReservationsList(selectedDate);

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {t('reservations.listTitle')}
          </h1>
          <Link to="/staff/dashboard" className="text-sm text-muted-foreground hover:text-brand-900">
            ← {t('staff.dashboardTitle')}
          </Link>
        </header>

        <section className="mt-6 rounded-lg border border-border bg-background p-4">
          <label className="block text-sm font-medium text-brand-700" htmlFor="event-date-select">
            {t('reservations.filterByEvent')}
          </label>
          <select
            id="event-date-select"
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            disabled={eventsLoading || sortedEvents.length === 0}
          >
            {sortedEvents.length === 0 ? (
              <option value="">{eventsLoading ? t('common.loading') : t('events.empty')}</option>
            ) : (
              sortedEvents.map((evt) => (
                <option key={evt.eventId} value={evt.eventDate}>
                  {dateFormatter.format(new Date(evt.eventDate + 'T00:00:00'))} — {evt.eventName}
                </option>
              ))
            )}
          </select>
        </section>

        <section className="mt-6">
          {!selectedDate ? null : reservationsLoading ? (
            <p className="text-muted-foreground">{t('common.loading')}</p>
          ) : error ? (
            <p className="text-destructive" role="alert">
              {error instanceof ApiError ? `${error.status}: ${error.message}` : t('common.error')}
            </p>
          ) : !reservations || reservations.length === 0 ? (
            <p className="text-muted-foreground">{t('reservations.empty')}</p>
          ) : (
            <ul className="space-y-3">
              {reservations.map((r) => {
                const paymentStatus = r.paymentStatus ?? 'PENDING';
                return (
                  <li key={r.reservationId} className="rounded-lg border border-border bg-background p-4">
                    <div className="flex items-baseline justify-between gap-4">
                      <div>
                        <h2 className={`font-semibold ${STATUS_CLASS[r.status]}`}>
                          {r.customerName}
                          <span className="ml-2 font-normal text-muted-foreground">
                            · {t('reservations.tableShort')} {r.tableId}
                          </span>
                        </h2>
                        <p className="text-sm text-muted-foreground">{r.phone}</p>
                      </div>
                      <div className="text-right text-sm">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${PAYMENT_STATUS_CLASS[paymentStatus]}`}
                        >
                          {paymentStatus}
                        </span>
                        <p className="mt-1 text-muted-foreground">
                          {moneyFormatter.format(r.amountDue ?? r.depositAmount)}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
