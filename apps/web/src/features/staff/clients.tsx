import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from 'react-oidc-context';
import { ApiError } from '@/lib/api-client';
import {
  useCrmFullList,
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
  onSaved,
}: {
  client: CrmClient;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(client.name ?? '');
  const [phone, setPhone] = useState(client.phone ?? '');
  const [phoneCountry, setPhoneCountry] = useState<'US' | 'MX'>(
    (client.phoneCountry as 'US' | 'MX') ?? 'MX'
  );
  const updateMutation = useUpdateCrmClient();
  const credits = useRescheduleCredits(client.phone, phoneCountry);

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  function reset() {
    setName(client.name ?? '');
    setPhone(client.phone ?? '');
    setPhoneCountry((client.phoneCountry as 'US' | 'MX') ?? 'MX');
    setEditing(false);
  }

  async function handleSave() {
    if (!client.phone) return;
    await updateMutation.mutateAsync({
      phoneKey: client.phone,
      patch: { name: name.trim(), phone: phone.trim(), phoneCountry },
    });
    setEditing(false);
    onSaved();
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
            <div className="flex-1 space-y-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('clientsCrm.field.name')}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-lg font-semibold text-brand-900"
              />
              <div className="grid grid-cols-[1fr_120px] gap-2">
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+528991234567"
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
                />
                <select
                  value={phoneCountry}
                  onChange={(e) => setPhoneCountry(e.target.value as 'US' | 'MX')}
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                >
                  <option value="MX">MX</option>
                  <option value="US">US</option>
                </select>
              </div>
            </div>
          ) : (
            <div>
              <h2 className="text-lg font-semibold text-brand-900">
                {client.name ?? '—'}
              </h2>
              <p className="text-sm text-muted-foreground">{client.phone}</p>
            </div>
          )}
          {canEdit ? (
            editing ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={reset}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={updateMutation.isPending || !name.trim() || !phone.trim()}
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
  const [filter, setFilter] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [browseAll, setBrowseAll] = useState(false);
  const [selected, setSelected] = useState<CrmClient | null>(null);

  const search = useCrmSearch(submitted);
  const fullList = useCrmFullList(canEdit && browseAll);

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  const allClients = browseAll ? fullList.data ?? [] : search.data ?? [];
  const isLoading = browseAll ? fullList.isLoading : search.isLoading;
  const error = browseAll ? fullList.error : search.error;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allClients;
    return allClients.filter(
      (c) =>
        c.name?.toLowerCase().includes(q) ||
        c.phone?.toLowerCase().includes(q)
    );
  }, [allClients, filter]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(filter.trim());
    setSelected(null);
  }

  return (
    <div className="p-6 sm:p-8">
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {t('clientsCrm.listTitle')}
          </h1>
          {canEdit && (
            <label className="flex items-center gap-2 text-xs text-brand-700">
              <input
                type="checkbox"
                checked={browseAll}
                onChange={(e) => {
                  setBrowseAll(e.target.checked);
                  setSelected(null);
                }}
                className="h-4 w-4 rounded border-border"
              />
              {t('clientsCrm.browseAll')}
            </label>
          )}
        </div>

        <form
          onSubmit={handleSearch}
          className="flex gap-2 rounded-lg border border-border bg-background p-4"
        >
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={
              browseAll
                ? t('clientsCrm.filterPlaceholder')
                : t('clientsCrm.searchPlaceholder')
            }
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          {!browseAll && (
            <button
              type="submit"
              disabled={filter.trim().length < 3}
              className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {t('clientsCrm.searchCta')}
            </button>
          )}
        </form>

        {browseAll && fullList.isLoading ? (
          <p className="text-muted-foreground">{t('common.loading')}</p>
        ) : !browseAll && !submitted ? (
          <p className="text-sm text-muted-foreground">{t('clientsCrm.searchHint')}</p>
        ) : isLoading ? (
          <p className="text-muted-foreground">{t('common.loading')}</p>
        ) : error ? (
          <p className="text-destructive">
            {error instanceof ApiError
              ? `${error.status}: ${error.message}`
              : t('common.error')}
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground">{t('clientsCrm.noResults')}</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <ul className="space-y-2">
              {filtered.slice(0, 100).map((c) => {
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
              {filtered.length > 100 && (
                <li className="text-xs text-muted-foreground">
                  {t('clientsCrm.tooMany', { count: filtered.length - 100 })}
                </li>
              )}
            </ul>

            <div>
              {selected ? (
                <ClientDetail
                  client={selected}
                  canEdit={canEdit}
                  onSaved={() => {
                    void search.refetch();
                    void fullList.refetch();
                  }}
                />
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
