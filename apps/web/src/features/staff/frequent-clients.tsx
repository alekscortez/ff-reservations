import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  useDeleteFrequentClient,
  useFrequentClientsList,
} from '@/lib/api/frequent-clients';
import { ApiError } from '@/lib/api-client';

export function StaffFrequentClients() {
  const { t } = useTranslation();
  const { data: clients, isLoading, error } = useFrequentClientsList();
  const deleteMutation = useDeleteFrequentClient();

  function handleDelete(clientId: string, name: string) {
    if (!window.confirm(t('frequentClients.confirmDelete', { name }))) return;
    deleteMutation.mutate(clientId);
  }

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold text-brand-900">
          {t('frequentClients.listTitle')}
        </h1>

        <div className="mt-4 flex justify-end">
          <Link
            to="/staff/frequent-clients/new"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            + {t('frequentClients.newCta')}
          </Link>
        </div>

        <section className="mt-4">
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
                    <div className="flex flex-col items-end gap-2 text-right text-sm">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                          client.status === 'ACTIVE'
                            ? 'bg-success-100 text-success-700'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {client.status}
                      </span>
                      <div className="flex gap-3">
                        <Link
                          to={`/staff/frequent-clients/${client.clientId}/edit`}
                          className="text-xs text-primary hover:underline"
                        >
                          {t('common.edit')}
                        </Link>
                        <button
                          type="button"
                          onClick={() => handleDelete(client.clientId, client.name)}
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
