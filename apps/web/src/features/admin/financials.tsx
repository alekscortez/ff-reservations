import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useFinancials, type FinancialRow } from '@/lib/api/financials';
import { ApiError } from '@/lib/api-client';

const PAYMENT_STATUS_TONE: Record<string, string> = {
  PAID: 'bg-success-100 text-success-700',
  PARTIAL: 'bg-accent text-accent-foreground',
  PENDING: 'bg-muted text-muted-foreground',
  COURTESY: 'bg-secondary text-secondary-foreground',
  REFUNDED: 'bg-danger-100 text-danger-700',
};

function defaultFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function defaultToDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

export function AdminFinancials() {
  const { t, i18n } = useTranslation();
  const [fromDate, setFromDate] = useState(defaultFromDate);
  const [toDate, setToDate] = useState(defaultToDate);
  const [eventStatus, setEventStatus] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  const moneyFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' }),
    [i18n.language]
  );
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    [i18n.language]
  );

  const { data, isLoading, error, refetch } = useFinancials({
    fromDate: fromDate || null,
    toDate: toDate || null,
    eventStatus,
  });

  const apiError = error instanceof ApiError ? error : null;

  function downloadCsv() {
    if (!data) return;
    const headers = [
      'eventDate',
      'eventName',
      'reservationId',
      'tableId',
      'customer',
      'phone',
      'status',
      'paymentStatus',
      'amountDue',
      'paid',
      'balance',
      'paymentDeadlineAt',
    ];
    const lines = [headers.join(',')];
    for (const r of data.rows) {
      const row = [
        r.eventDate,
        JSON.stringify(r.eventName),
        r.reservationId,
        r.tableId,
        JSON.stringify(r.customerName),
        r.phone,
        r.status,
        r.paymentStatus ?? '',
        r.amountDue.toFixed(2),
        r.paid.toFixed(2),
        r.balance.toFixed(2),
        r.paymentDeadlineAt ?? '',
      ];
      lines.push(row.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `financials-${fromDate}-to-${toDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-6 sm:p-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="rounded-lg border border-border bg-background p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('financials.adminEyebrow')}
              </p>
              <h1 className="text-3xl font-semibold text-brand-900">
                {t('financials.listTitle')}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t('financials.listDescription')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refetch()}
                disabled={isLoading}
                className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm font-medium text-brand-900 hover:bg-muted disabled:opacity-50"
              >
                {t('financials.refresh')}
              </button>
              <button
                type="button"
                onClick={downloadCsv}
                disabled={!data || data.rows.length === 0}
                className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {t('financials.exportCsv')}
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="text-xs font-medium text-brand-700">
              {t('financials.from')}
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-brand-700">
              {t('financials.to')}
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-brand-700">
              {t('financials.eventStatus')}
              <select
                value={eventStatus}
                onChange={(e) => setEventStatus(e.target.value as 'ALL' | 'ACTIVE' | 'INACTIVE')}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              >
                <option value="ALL">All</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </label>
            <div className="flex items-end text-xs text-muted-foreground">
              {data ? t('financials.eventsInRange', { count: data.filteredEvents.length }) : '—'}
            </div>
          </div>

          {apiError && (
            <p className="mt-2 text-sm text-destructive">
              {apiError.status}: {apiError.message}
            </p>
          )}
          {data && data.warnings.length > 0 && (
            <div className="mt-3 rounded-md border border-accent bg-accent/30 p-3 text-xs text-accent-foreground">
              <p className="font-semibold">{t('financials.partialWarning')}</p>
              <ul className="mt-1 space-y-1">
                {data.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          )}
        </header>

        {isLoading ? (
          <p className="text-muted-foreground">{t('common.loading')}</p>
        ) : data ? (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Kpi
                tone="success"
                label={t('financials.kpi.collected')}
                value={moneyFormatter.format(data.overview.collected)}
              />
              <Kpi
                tone="brand"
                label={t('financials.kpi.expected')}
                value={moneyFormatter.format(data.overview.expected)}
              />
              <Kpi
                tone="accent"
                label={t('financials.kpi.outstanding')}
                value={moneyFormatter.format(data.overview.outstanding)}
              />
              <Kpi
                tone="danger"
                label={t('financials.kpi.overdue')}
                value={moneyFormatter.format(data.overview.overdue)}
              />
              <Kpi
                tone="accent"
                label={t('financials.kpi.dueSoon')}
                value={moneyFormatter.format(data.overview.dueSoon)}
              />
              <Kpi
                tone="muted"
                label={t('financials.kpi.courtesy')}
                value={moneyFormatter.format(data.overview.courtesyValue)}
                sublabel={t('financials.kpi.confirmedRatio', {
                  confirmed: data.overview.confirmed,
                  total: data.overview.reservations,
                })}
              />
            </section>

            <section className="rounded-lg border border-border bg-background p-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-semibold text-brand-900">
                  {t('financials.eventSummary.heading')}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {data.eventSummaries.length} {t('financials.eventSummary.eventsLabel')}
                </span>
              </div>
              {data.eventSummaries.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  {t('financials.eventSummary.empty')}
                </p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-2 py-2">{t('financials.col.eventDate')}</th>
                        <th className="px-2 py-2">{t('financials.col.eventName')}</th>
                        <th className="px-2 py-2 text-right">{t('financials.col.reservations')}</th>
                        <th className="px-2 py-2 text-right">{t('financials.col.collected')}</th>
                        <th className="px-2 py-2 text-right">{t('financials.col.expected')}</th>
                        <th className="px-2 py-2 text-right">{t('financials.col.outstanding')}</th>
                        <th className="px-2 py-2 text-right">{t('financials.col.overdue')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.eventSummaries.map((s) => (
                        <tr key={s.eventId} className="border-b border-border/40">
                          <td className="px-2 py-2 text-brand-900">
                            {dateFormatter.format(new Date(s.eventDate + 'T00:00:00'))}
                          </td>
                          <td className="px-2 py-2 text-brand-700">{s.eventName}</td>
                          <td className="px-2 py-2 text-right">
                            {s.confirmed} / {s.reservations}
                          </td>
                          <td className="px-2 py-2 text-right text-success-700">
                            {moneyFormatter.format(s.collected)}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {moneyFormatter.format(s.expected)}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {moneyFormatter.format(s.outstanding)}
                          </td>
                          <td
                            className={`px-2 py-2 text-right ${
                              s.overdue > 0 ? 'font-semibold text-destructive' : ''
                            }`}
                          >
                            {moneyFormatter.format(s.overdue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {data.receivables.length > 0 && (
              <section className="rounded-lg border border-border bg-background p-4">
                <h2 className="text-lg font-semibold text-brand-900">
                  {t('financials.receivables.heading')}
                </h2>
                <ul className="mt-3 space-y-2">
                  {data.receivables.slice(0, 25).map((r: FinancialRow) => (
                    <li
                      key={r.reservationId}
                      className="flex items-baseline justify-between gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm"
                    >
                      <div>
                        <Link
                          to={`/staff/reservations/${r.eventDate}/${r.reservationId}`}
                          className="font-medium text-brand-900 hover:underline"
                        >
                          {r.customerName} · T{r.tableId}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {r.eventDate} · {r.phone}
                        </p>
                      </div>
                      <div className="text-right">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                            PAYMENT_STATUS_TONE[r.paymentStatus ?? 'PENDING']
                          }`}
                        >
                          {r.paymentStatus ?? 'PENDING'}
                        </span>
                        <p className="mt-1 text-sm font-semibold text-brand-900">
                          {moneyFormatter.format(r.balance)}
                        </p>
                        {r.isOverdue ? (
                          <p className="text-xs font-semibold text-destructive">
                            {t('financials.receivables.overdue')}
                          </p>
                        ) : r.isDueSoon ? (
                          <p className="text-xs text-accent-foreground">
                            {t('financials.receivables.dueSoon')}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
                {data.receivables.length > 25 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('financials.receivables.more', {
                      count: data.receivables.length - 25,
                    })}
                  </p>
                )}
              </section>
            )}

            <section className="rounded-lg border border-border bg-background p-4">
              <h2 className="text-lg font-semibold text-brand-900">
                {t('financials.methodTotals.heading')}
              </h2>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Money label={t('financials.methodTotals.cash')} value={data.methodTotals.cash} f={moneyFormatter} />
                <Money label={t('financials.methodTotals.square')} value={data.methodTotals.square} f={moneyFormatter} />
                <Money label={t('financials.methodTotals.cashapp')} value={data.methodTotals.cashapp} f={moneyFormatter} />
                <Money label={t('financials.methodTotals.credit')} value={data.methodTotals.credit} f={moneyFormatter} />
              </dl>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

interface KpiProps {
  tone: 'success' | 'brand' | 'accent' | 'danger' | 'muted';
  label: string;
  value: string;
  sublabel?: string;
}

function Kpi({ tone, label, value, sublabel }: KpiProps) {
  const map = {
    success: 'border-success-200 bg-success-100/40 text-success-700',
    brand: 'border-border bg-background text-brand-900',
    accent: 'border-accent bg-accent/30 text-accent-foreground',
    danger: 'border-danger-200 bg-danger-100/40 text-danger-700',
    muted: 'border-border bg-muted/30 text-brand-900',
  } as const;
  return (
    <article className={`rounded-xl border p-4 ${map[tone]}`}>
      <p className="text-xs uppercase tracking-wide opacity-80">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      {sublabel && <p className="mt-1 text-xs opacity-70">{sublabel}</p>}
    </article>
  );
}

function Money({
  label,
  value,
  f,
}: {
  label: string;
  value: number;
  f: Intl.NumberFormat;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold text-brand-900">{f.format(value)}</dd>
    </div>
  );
}
