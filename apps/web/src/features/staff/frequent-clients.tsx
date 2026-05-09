import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFrequentClientsList } from '@/lib/api/frequent-clients';
import { ApiError } from '@/lib/api-client';

export function StaffFrequentClients() {
  const { t } = useTranslation();
  const { data: clients, isLoading, error } = useFrequentClientsList();

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {t('frequentClients.listTitle')}
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
          ) : !clients || clients.length === 0 ? (
            <p className="text-muted-foreground">{t('frequentClients.empty')}</p>
          ) : (
            <ul className="space-y-3">
              {clients.map((client) => (
                <li
                  key={client.clientId}
                  className="rounded-lg border border-border bg-background p-4"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <div>
                      <h2 className="font-semibold text-brand-900">{client.name}</h2>
                      <p className="text-sm text-muted-foreground">{client.phone}</p>
                      {client.notes ? (
                        <p className="mt-1 text-sm text-brand-700">{client.notes}</p>
                      ) : null}
                    </div>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                        client.status === 'ACTIVE'
                          ? 'bg-success-100 text-success-700'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {client.status}
                    </span>
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
