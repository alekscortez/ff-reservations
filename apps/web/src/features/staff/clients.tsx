import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from 'react-oidc-context';
import { ApiError } from '@/lib/api-client';
import {
  useCrmSearch,
  useRescheduleCredits,
  useUpdateCrmClient,
  type CrmClient,
  type RescheduleCredit,
} from '@/lib/api/clients';
import { getGroups, isAdmin } from '@/lib/auth';

function formatEpoch(epoch: number | undefined, locale: string) {
  if (!epoch) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(epoch * 1000));
}

function ClientDetail({
  client,
  canEdit,
}: {
  client: CrmClient;
  canEdit: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(client.name ?? '');
  const updateMutation = useUpdateCrmClient();
  const credits = useRescheduleCredits(client.phone, client.phoneCountry ?? 'MX');

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  async function handleSave() {
    if (!client.phone) return;
    await updateMutation.mutateAsync({
      phoneKey: client.phone,
      patch: { name: name.trim() },
    });
    setEditing(false);
  }

  const updateError =
    updateMutation.error instanceof ApiError
      ? `${updateMutation.error.status}: ${updateMutation.error.message}`
      : null;

  return (
    <article className="space-y-4 rounded-lg border border-border bg-background p-5">
      <header>
        <div className="flex items-baseline justify-between gap-3">
          {editing ? (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-lg font-semibold text-brand-900"
            />
          ) : (
            <h2 className="text-lg font-semibold text-brand-900">
              {client.name ?? '—'}
            </h2>
          )}
          {canEdit ? (
            editing ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setName(client.name ?? '');
                  }}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={updateMutation.isPending || !name.trim()}
                  className="inline-flex items-center rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {updateMutation.isPending ? t('common.saving') : t('common.save')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-xs text-primary hover:underline"
              >
                {t('common.edit')}
              </button>
            )
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{client.phone}</p>
      </header>

      {updateError && (
        <p className="text-sm text-destructive" role="alert">
          {updateError}
        </p>
      )}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('clientsCrm.field.totalReservations')}</dt>
        <dd>{client.totalReservations ?? 0}</dd>
        <dt className="text-muted-foreground">{t('clientsCrm.field.totalSpend')}</dt>
        <dd>{moneyFormatter.format(client.totalSpend ?? 0)}</dd>
        <dt className="text-muted-foreground">{t('clientsCrm.field.lastReservation')}</dt>
        <dd>
          {client.lastReservationAt
            ? formatEpoch(client.lastReservationAt, i18n.language)
            : '—'}
          {client.lastEventDate ? ` · ${client.lastEventDate}` : ''}
          {client.lastTableId ? ` · T${client.lastTableId}` : ''}
        </dd>
        <dt className="text-muted-foreground">{t('clientsCrm.field.country')}</dt>
        <dd>{client.phoneCountry ?? '—'}</dd>
      </dl>

      <div>
        <h3 className="text-sm font-semibold text-brand-900">
          {t('clientsCrm.credits.heading')}
        </h3>
        {credits.isLoading ? (
          <p className="mt-2 text-xs text-muted-foreground">{t('common.loading')}</p>
        ) : credits.error ? (
          <p className="mt-2 text-xs text-destructive">{t('common.error')}</p>
        ) : !credits.data || credits.data.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('clientsCrm.credits.empty')}
          </p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {credits.data.map((credit: RescheduleCredit) => (
              <li
                key={credit.creditId}
                className="flex items-baseline justify-between rounded-md bg-muted/40 px-3 py-2"
              >
                <div>
                  <span className="font-medium">{moneyFormatter.format(credit.amount)}</span>
                  {(credit.amountUsed ?? 0) > 0 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({t('clientsCrm.credits.used', {
                        used: moneyFormatter.format(credit.amountUsed ?? 0),
                      })})
                    </span>
                  )}
                  {credit.sourceEventDate && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('clientsCrm.credits.from')} {credit.sourceEventDate}
                    </span>
                  )}
                </div>
                <span
                  className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                    credit.status === 'AVAILABLE'
                      ? 'bg-success-100 text-success-700'
                      : credit.status === 'CONSUMED'
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-danger-100 text-danger-700'
                  }`}
                >
                  {credit.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

export function StaffClients() {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const canEdit = isAdmin(getGroups(auth.user));
  const [phone, setPhone] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [selected, setSelected] = useState<CrmClient | null>(null);

  const { data: results, isLoading, error } = useCrmSearch(submitted);

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(phone.trim());
    setSelected(null);
  }

  return (
    <div className="p-6 sm:p-8">
      <div className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-3xl font-semibold text-brand-900">
          {t('clientsCrm.listTitle')}
        </h1>

        <form
          onSubmit={handleSearch}
          className="flex gap-2 rounded-lg border border-border bg-background p-4"
        >
          <input
            type="search"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t('clientsCrm.searchPlaceholder')}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={phone.trim().length < 3}
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('clientsCrm.searchCta')}
          </button>
        </form>

        {!submitted ? (
          <p className="text-sm text-muted-foreground">{t('clientsCrm.searchHint')}</p>
        ) : isLoading ? (
          <p className="text-muted-foreground">{t('common.loading')}</p>
        ) : error ? (
          <p className="text-destructive">
            {error instanceof ApiError
              ? `${error.status}: ${error.message}`
              : t('common.error')}
          </p>
        ) : !results || results.length === 0 ? (
          <p className="text-muted-foreground">{t('clientsCrm.noResults')}</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <ul className="space-y-2">
              {results.map((c) => {
                const isSelected = selected?.phone === c.phone;
                return (
                  <li key={c.phone}>
                    <button
                      type="button"
                      onClick={() => setSelected(c)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        isSelected
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-background hover:border-primary'
                      }`}
                    >
                      <p className="font-semibold text-brand-900">{c.name ?? '—'}</p>
                      <p className="text-sm text-muted-foreground">{c.phone}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {c.totalReservations ?? 0} ·{' '}
                        {moneyFormatter.format(c.totalSpend ?? 0)}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div>
              {selected ? (
                <ClientDetail client={selected} canEdit={canEdit} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('clientsCrm.selectHint')}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
