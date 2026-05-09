import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { useEventsList } from '@/lib/api/events';
import { useTablesForEvent, type TableForEvent } from '@/lib/api/tables';
import { useCreateHold, useReleaseHold, type Hold } from '@/lib/api/holds';
import { useCreateReservation } from '@/lib/api/reservations';
import { usePackagesList } from '@/lib/api/packages';
import { TableMap } from '@/components/table-map';

interface CustomerForm {
  customerName: string;
  phone: string;
  phoneCountry: 'US' | 'MX';
  depositAmount: number;
  paymentMethod: 'cash' | 'square' | 'cashapp' | 'credit';
  packageId: string;
  receiptNumber: string;
}

export function ReservationNew() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [eventDate, setEventDate] = useState<string>('');
  const [hold, setHold] = useState<Hold | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const { data: events, isLoading: eventsLoading } = useEventsList();
  const { data: tablesData, isLoading: tablesLoading } = useTablesForEvent(eventDate || null);
  const { data: packages } = usePackagesList();
  const createHold = useCreateHold();
  const releaseHold = useReleaseHold(eventDate);
  const createReservation = useCreateReservation();

  const sortedEvents = useMemo(() => {
    if (!events) return [];
    return [...events]
      .filter((e) => e.status === 'ACTIVE')
      .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  }, [events]);

  useEffect(() => {
    if (!eventDate && sortedEvents.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const next = sortedEvents.find((e) => e.eventDate >= today) ?? sortedEvents[0];
      setEventDate(next.eventDate);
    }
  }, [eventDate, sortedEvents]);

  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const selectedEvent = useMemo(
    () => sortedEvents.find((e) => e.eventDate === eventDate) ?? null,
    [sortedEvents, eventDate]
  );

  const tablesArray = tablesData?.tables ?? [];
  const sectionStats = useMemo(() => {
    const map = new Map<string, { total: number; available: number }>();
    for (const tb of tablesArray) {
      const cur = map.get(tb.section) ?? { total: 0, available: 0 };
      cur.total += 1;
      if (tb.status === 'AVAILABLE') cur.available += 1;
      map.set(tb.section, cur);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tablesArray]);

  const heldTable = useMemo(() => {
    if (!hold || !tablesData?.tables) return null;
    return tablesData.tables.find((tb) => tb.id === hold.tableId) ?? null;
  }, [hold, tablesData?.tables]);

  const remainingSec = hold?.expiresAt ? hold.expiresAt - nowSec : 0;
  const expired = hold?.expiresAt ? remainingSec <= 0 : false;

  const minDeposit = selectedEvent?.minDeposit ?? 0;
  const tablePrice = heldTable?.price ?? 0;

  const { register, handleSubmit, watch, setValue, formState } = useForm<CustomerForm>({
    defaultValues: {
      customerName: '',
      phone: '',
      phoneCountry: 'MX',
      depositAmount: 0,
      paymentMethod: 'cash',
      packageId: '',
      receiptNumber: '',
    },
  });

  useEffect(() => {
    if (heldTable) {
      const suggested = Math.max(minDeposit, 0);
      if (suggested > 0) setValue('depositAmount', suggested);
    }
  }, [heldTable, minDeposit, setValue]);

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  function handleHold(table: TableForEvent) {
    if (table.status !== 'AVAILABLE') return;
    createHold.mutate(
      { eventDate, tableId: table.id },
      {
        onSuccess: (created) => {
          setHold(created);
        },
      }
    );
  }

  function handleReleaseHold() {
    if (!hold || !window.confirm(t('reservationNew.confirmRelease'))) return;
    releaseHold.mutate(hold.tableId, {
      onSuccess: () => setHold(null),
    });
  }

  const onSubmit = handleSubmit(async (form) => {
    if (!hold) return;
    const created = await createReservation.mutateAsync({
      eventDate,
      tableId: hold.tableId,
      holdId: hold.holdId ?? '',
      customerName: form.customerName.trim(),
      phone: form.phone.trim(),
      phoneCountry: form.phoneCountry,
      depositAmount: Number(form.depositAmount),
      paymentMethod: form.paymentMethod,
      packageId: form.packageId || undefined,
      receiptNumber: form.receiptNumber.trim() || undefined,
    });
    navigate(`/staff/reservations/${created.eventDate}/${created.reservationId}`);
  });

  const submitError =
    createReservation.error instanceof ApiError
      ? `${createReservation.error.status}: ${createReservation.error.message}`
      : null;
  const holdError =
    createHold.error instanceof ApiError
      ? `${createHold.error.status}: ${createHold.error.message}`
      : null;

  const watchedDeposit = watch('depositAmount');
  const depositValid =
    Number.isFinite(Number(watchedDeposit)) && Number(watchedDeposit) >= minDeposit;

  return (
    <div className="p-6 sm:p-8">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {t('reservationNew.title')}
          </h1>
          <Link
            to="/staff/reservations"
            className="text-sm text-muted-foreground hover:text-brand-900"
          >
            ← {t('reservations.listTitle')}
          </Link>
        </div>

        <section className="rounded-lg border border-border bg-background p-4">
          <label className="block text-sm font-medium text-brand-700" htmlFor="evt">
            {t('reservationNew.eventLabel')}
          </label>
          <select
            id="evt"
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={eventDate}
            onChange={(e) => {
              if (hold) {
                if (!window.confirm(t('reservationNew.confirmSwitchEvent'))) return;
                releaseHold.mutate(hold.tableId);
                setHold(null);
              }
              setEventDate(e.target.value);
            }}
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
          {selectedEvent && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('reservationNew.minDeposit')}:{' '}
              {moneyFormatter.format(selectedEvent.minDeposit)}
            </p>
          )}
        </section>

        {hold && heldTable ? (
          <section
            className={`rounded-lg border-2 p-4 ${
              expired ? 'border-destructive bg-danger-100/40' : 'border-primary bg-primary/5'
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-brand-900">
                  {t('reservationNew.heldTable', {
                    section: heldTable.section,
                    id: heldTable.id,
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {moneyFormatter.format(heldTable.price)}
                </p>
              </div>
              <div className="text-right text-sm">
                {expired ? (
                  <span className="font-semibold text-destructive">
                    {t('reservationNew.holdExpired')}
                  </span>
                ) : (
                  <span className="font-mono text-brand-900">
                    {Math.floor(remainingSec / 60)}m {String(remainingSec % 60).padStart(2, '0')}s
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleReleaseHold}
                  className="ml-3 text-xs text-destructive hover:underline"
                >
                  {t('holds.release')}
                </button>
              </div>
            </div>
          </section>
        ) : eventDate ? (
          <section className="rounded-lg border border-border bg-background p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-brand-900">
                {t('reservationNew.pickTable')}
              </h2>
              {sectionStats.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {sectionStats
                    .map(([s, c]) => `${s}: ${c.available}/${c.total}`)
                    .join(' · ')}
                </span>
              )}
            </div>
            {holdError && <p className="mt-2 text-xs text-destructive">{holdError}</p>}
            {tablesLoading ? (
              <p className="mt-3 text-muted-foreground">{t('common.loading')}</p>
            ) : tablesArray.length === 0 ? (
              <p className="mt-3 text-muted-foreground">{t('events.empty')}</p>
            ) : (
              <TableMap
                tables={tablesArray}
                interactive={!createHold.isPending}
                onSelect={handleHold}
                className="mt-3"
              />
            )}
            <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ background: '#16a34a' }}
                />{' '}
                {t('reservationNew.legend.available')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ background: '#f59e0b' }}
                />{' '}
                {t('reservationNew.legend.hold')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ background: '#dc2626' }}
                />{' '}
                {t('reservationNew.legend.reserved')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ background: '#9ca3af' }}
                />{' '}
                {t('reservationNew.legend.disabled')}
              </span>
            </div>
          </section>
        ) : null}

        {hold && heldTable && !expired && (
          <form
            onSubmit={onSubmit}
            className="space-y-4 rounded-lg border border-border bg-background p-5"
          >
            <h2 className="text-lg font-semibold text-brand-900">
              {t('reservationNew.customerHeading')}
            </h2>
            <div>
              <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="customerName">
                {t('reservationNew.field.customerName')} *
              </label>
              <input
                id="customerName"
                {...register('customerName', { required: true })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="phone">
                  {t('reservationNew.field.phone')} *
                </label>
                <input
                  id="phone"
                  type="tel"
                  placeholder="+528991234567"
                  {...register('phone', { required: true })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="phoneCountry"
                >
                  {t('frequentClients.field.country')}
                </label>
                <select
                  id="phoneCountry"
                  {...register('phoneCountry')}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="MX">MX</option>
                  <option value="US">US</option>
                </select>
              </div>
            </div>

            {(packages ?? []).filter((p) => p.status === 'ACTIVE').length > 0 && (
              <div>
                <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="packageId">
                  {t('reservationNew.field.package')}
                </label>
                <select
                  id="packageId"
                  {...register('packageId')}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">{t('reservationNew.field.noPackage')}</option>
                  {(packages ?? [])
                    .filter((p) => p.status === 'ACTIVE')
                    .map((p) => (
                      <option key={p.packageId} value={p.packageId}>
                        {p.name} (+{moneyFormatter.format(p.priceUSD)})
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="depositAmount"
                >
                  {t('reservationNew.field.deposit')} *
                </label>
                <input
                  id="depositAmount"
                  type="number"
                  step="0.01"
                  min={minDeposit}
                  {...register('depositAmount', { valueAsNumber: true, min: minDeposit })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('reservationNew.field.depositHint', {
                    min: moneyFormatter.format(minDeposit),
                    table: moneyFormatter.format(tablePrice),
                  })}
                </p>
              </div>
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="paymentMethod"
                >
                  {t('reservationNew.field.paymentMethod')} *
                </label>
                <select
                  id="paymentMethod"
                  {...register('paymentMethod')}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="cash">cash</option>
                  <option value="square">square</option>
                  <option value="cashapp">cashapp</option>
                  <option value="credit">credit</option>
                </select>
              </div>
            </div>

            {watch('paymentMethod') === 'cash' && (
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="receiptNumber"
                >
                  {t('reservationNew.field.receiptNumber')}
                </label>
                <input
                  id="receiptNumber"
                  inputMode="numeric"
                  pattern="\d*"
                  {...register('receiptNumber')}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
            )}

            {submitError && (
              <p className="text-sm text-destructive" role="alert">
                {submitError}
              </p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="submit"
                disabled={
                  createReservation.isPending ||
                  !formState.isValid ||
                  !depositValid ||
                  expired
                }
                className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {createReservation.isPending
                  ? t('common.saving')
                  : t('reservationNew.confirmCta')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
