import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEventsList } from '@/lib/api/events';
import { ApiError } from '@/lib/api-client';

export function StaffEvents() {
  const { t, i18n } = useTranslation();
  const { data: events, isLoading, error } = useEventsList();

  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {t('events.listTitle')}
          </h1>
          <Link to="/staff/dashboard" className="text-sm text-muted-foreground hover:text-brand-900">
            ← {t('staff.dashboardTitle')}
          </Link>
        </header>

        <section className="mt-6">
          {isLoading ? (
            <p className="text-muted-foreground">{t('common.loading')}</p>
          ) : error ? (
            <p className="text-destructive" role="alert">
              {error instanceof ApiError ? `${error.status}: ${error.message}` : t('common.error')}
            </p>
          ) : !events || events.length === 0 ? (
            <p className="text-muted-foreground">{t('events.empty')}</p>
          ) : (
            <ul className="space-y-3">
              {events.map((evt) => (
                <li
                  key={evt.eventId}
                  className="rounded-lg border border-border bg-background p-4"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <div>
                      <h2 className="font-semibold text-brand-900">{evt.eventName}</h2>
                      <p className="text-sm text-muted-foreground">
                        {dateFormatter.format(new Date(evt.eventDate + 'T00:00:00'))}
                      </p>
                    </div>
                    <div className="text-right text-sm">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                          evt.status === 'ACTIVE'
                            ? 'bg-success-100 text-success-700'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {evt.status}
                      </span>
                      <p className="mt-1 text-muted-foreground">
                        {t('events.minDeposit')}: {moneyFormatter.format(evt.minDeposit)}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
