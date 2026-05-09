import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDeleteEvent, useEventsList, useUpdateEvent } from '@/lib/api/events';
import { ApiError } from '@/lib/api-client';

function ToggleStatusButton({
  eventId,
  currentStatus,
}: {
  eventId: string;
  currentStatus: 'ACTIVE' | 'INACTIVE';
}) {
  const { t } = useTranslation();
  const update = useUpdateEvent(eventId);
  const next = currentStatus === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
  return (
    <button
      type="button"
      onClick={() => update.mutate({ status: next })}
      disabled={update.isPending}
      className="text-xs text-primary hover:underline disabled:opacity-50"
    >
      {next === 'INACTIVE' ? t('common.deactivate') : t('events.activate')}
    </button>
  );
}

export function StaffEvents() {
  const { t, i18n } = useTranslation();
  const { data: events, isLoading, error } = useEventsList();
  const deleteMutation = useDeleteEvent();

  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  function handleDelete(eventId: string, eventName: string) {
    if (!window.confirm(t('events.confirmDelete', { name: eventName }))) return;
    deleteMutation.mutate(eventId);
  }

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold text-brand-900">
          {t('events.listTitle')}
        </h1>

        <div className="mt-4 flex justify-end">
          <Link
            to="/staff/events/new"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            + {t('events.newCta')}
          </Link>
        </div>

        <section className="mt-4">
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
                    <div className="flex flex-col items-end gap-2 text-right text-sm">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                            evt.status === 'ACTIVE'
                              ? 'bg-success-100 text-success-700'
                              : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {evt.status}
                        </span>
                        <span className="text-muted-foreground">
                          {t('events.minDeposit')}: {moneyFormatter.format(evt.minDeposit)}
                        </span>
                      </div>
                      <div className="flex gap-3">
                        <Link
                          to={`/staff/events/${evt.eventId}/edit`}
                          className="text-xs text-primary hover:underline"
                        >
                          {t('common.edit')}
                        </Link>
                        <ToggleStatusButton
                          eventId={evt.eventId}
                          currentStatus={evt.status}
                        />
                        <button
                          type="button"
                          onClick={() => handleDelete(evt.eventId, evt.eventName)}
                          disabled={deleteMutation.isPending}
                          className="text-xs text-destructive hover:underline disabled:opacity-50"
                        >
                          {t('common.delete')}
                        </button>
                      </div>
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
