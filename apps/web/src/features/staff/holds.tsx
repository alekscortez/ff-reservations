import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEventsList } from '@/lib/api/events';
import { useHoldsList, useReleaseHold } from '@/lib/api/holds';
import { ApiError } from '@/lib/api-client';

function formatRemaining(expiresAt: number | undefined, nowSec: number, expiredLabel: string) {
  if (!expiresAt) return '—';
  const remaining = expiresAt - nowSec;
  if (remaining <= 0) return expiredLabel;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function StaffHolds() {
  const { t, i18n } = useTranslation();
  const { data: events, isLoading: eventsLoading } = useEventsList();
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

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
    data: locks,
    isLoading: holdsLoading,
    error,
  } = useHoldsList(selectedDate || null);

  const release = useReleaseHold(selectedDate);

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const holdsOnly = useMemo(
    () => (locks ?? []).filter((lock) => lock.lockType === 'HOLD'),
    [locks]
  );

  function handleRelease(tableId: string) {
    if (!window.confirm(t('holds.confirmRelease', { tableId }))) return;
    release.mutate(tableId);
  }

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold text-brand-900">{t('holds.listTitle')}</h1>

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
              <option value="">
                {eventsLoading ? t('common.loading') : t('events.empty')}
              </option>
            ) : (
              sortedEvents.map((evt) => (
                <option key={evt.eventId} value={evt.eventDate}>
                  {dateFormatter.format(new Date(evt.eventDate + 'T00:00:00'))} —{' '}
                  {evt.eventName}
                </option>
              ))
            )}
          </select>
        </section>

        <section className="mt-6">
          {!selectedDate ? null : holdsLoading ? (
            <p className="text-muted-foreground">{t('common.loading')}</p>
          ) : error ? (
            <p className="text-destructive" role="alert">
              {error instanceof ApiError ? `${error.status}: ${error.message}` : t('common.error')}
            </p>
          ) : holdsOnly.length === 0 ? (
            <p className="text-muted-foreground">{t('holds.empty')}</p>
          ) : (
            <ul className="space-y-3">
              {holdsOnly.map((hold) => {
                const expired = hold.expiresAt ? hold.expiresAt - nowSec <= 0 : false;
                return (
                  <li
                    key={hold.tableId}
                    className={`rounded-lg border p-4 ${
                      expired ? 'border-destructive bg-danger-100/40' : 'border-border bg-background'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-4">
                      <div>
                        <h2 className="font-semibold text-brand-900">
                          {t('reservations.tableShort')} {hold.tableId}
                          {hold.contactName ? (
                            <span className="ml-2 font-normal text-muted-foreground">
                              · {hold.contactName}
                            </span>
                          ) : null}
                        </h2>
                        {hold.contactPhone ? (
                          <p className="text-sm text-muted-foreground">{hold.contactPhone}</p>
                        ) : null}
                        {hold.ownerLabel ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t('holds.placedBy')}: {hold.ownerLabel}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-col items-end gap-2 text-right text-sm">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                            expired
                              ? 'bg-danger-100 text-danger-700'
                              : 'bg-accent text-accent-foreground'
                          }`}
                        >
                          {expired
                            ? t('holds.expiredBadge')
                            : formatRemaining(hold.expiresAt, nowSec, t('holds.expiredBadge'))}
                        </span>
                        {hold.chargeAmount !== undefined ? (
                          <span className="text-muted-foreground">
                            {moneyFormatter.format(hold.chargeAmount)}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => handleRelease(hold.tableId)}
                          disabled={release.isPending}
                          className="text-xs text-destructive hover:underline disabled:opacity-50"
                        >
                          {t('holds.release')}
                        </button>
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
