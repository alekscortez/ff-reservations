import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import type { ReservationItem } from '@ff/core';
import { useEventsList } from '@/lib/api/events';
import { useTablesForEvent, type TableForEvent } from '@/lib/api/tables';
import { useCreateHold, useReleaseHold, type Hold } from '@/lib/api/holds';
import {
  useCreateReservation,
  useCreateSquarePaymentLink,
  useSendSquareLinkSms,
} from '@/lib/api/reservations';
import { usePackagesList } from '@/lib/api/packages';
import { useCrmSearch, type CrmClient } from '@/lib/api/clients';
import { TableMap } from '@/components/table-map';

type PaymentMethodChoice = 'cash' | 'square' | 'cashapp';
type PaymentStatusChoice = 'PAID' | 'PARTIAL' | 'PENDING' | 'COURTESY';

interface CustomerForm {
  customerName: string;
  phone: string;
  phoneCountry: 'US' | 'MX';
  paymentMethod: PaymentMethodChoice;
  paymentStatus: PaymentStatusChoice;
  amountDue: number;
  depositAmount: number;
  paymentDeadlineDate: string;
  paymentDeadlineTime: string;
  packageId: string;
  receiptNumber: string;
}

function nextDayDateString(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const DEFAULT_DEADLINE_TZ = 'America/Chicago';

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

  const [allowCustomDeposit, setAllowCustomDeposit] = useState(false);
  const [paymentDeadlineEnabled, setPaymentDeadlineEnabled] = useState(false);

  const { register, handleSubmit, watch, setValue, formState } = useForm<CustomerForm>({
    defaultValues: {
      customerName: '',
      phone: '',
      phoneCountry: 'MX',
      paymentMethod: 'square',
      paymentStatus: 'PENDING',
      amountDue: 0,
      depositAmount: 0,
      paymentDeadlineDate: nextDayDateString(),
      paymentDeadlineTime: '00:00',
      packageId: '',
      receiptNumber: '',
    },
  });

  const watchedMethod = watch('paymentMethod');
  const watchedStatus = watch('paymentStatus');
  const watchedAmountDue = Number(watch('amountDue')) || 0;
  const watchedDeposit = Number(watch('depositAmount')) || 0;
  const isCash = watchedMethod === 'cash';
  const isDigital = watchedMethod === 'square' || watchedMethod === 'cashapp';

  // When a table gets held, prefill amountDue with table price.
  useEffect(() => {
    if (heldTable && tablePrice > 0) {
      setValue('amountDue', tablePrice);
    }
  }, [heldTable, tablePrice, setValue]);

  // Digital payments are always PENDING and need a deadline.
  useEffect(() => {
    if (isDigital) {
      setValue('paymentStatus', 'PENDING');
      setPaymentDeadlineEnabled(true);
    }
  }, [isDigital, setValue]);

  // Auto-suggest deposit based on cash payment status (unless user unlocked).
  useEffect(() => {
    if (allowCustomDeposit) return;
    if (isCash) {
      if (watchedStatus === 'PAID') setValue('depositAmount', watchedAmountDue);
      else if (watchedStatus === 'PARTIAL') {
        // halfway between min and full as a sensible default
        const half = Math.max(minDeposit, Math.round(watchedAmountDue / 2));
        setValue('depositAmount', half);
      } else if (watchedStatus === 'PENDING') setValue('depositAmount', 0);
      else if (watchedStatus === 'COURTESY') setValue('depositAmount', 0);
    } else if (isDigital) {
      setValue('depositAmount', 0);
    }
  }, [allowCustomDeposit, isCash, isDigital, watchedStatus, watchedAmountDue, minDeposit, setValue]);

  // Cash status determines whether a deadline is required (PARTIAL/PENDING).
  const cashRequiresDeadline =
    isCash && (watchedStatus === 'PARTIAL' || watchedStatus === 'PENDING');
  const deadlineRequired = isDigital || cashRequiresDeadline;

  useEffect(() => {
    if (deadlineRequired) setPaymentDeadlineEnabled(true);
  }, [deadlineRequired]);

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

  const [createdReservation, setCreatedReservation] = useState<ReservationItem | null>(null);
  const watchedPhone = watch('phone');
  const [debouncedPhone, setDebouncedPhone] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedPhone(watchedPhone.trim()), 350);
    return () => clearTimeout(id);
  }, [watchedPhone]);
  const crmSearch = useCrmSearch(debouncedPhone);
  const crmMatches = crmSearch.data ?? [];
  const showCrmPanel =
    debouncedPhone.replace(/\D/g, '').length >= 3 && !createdReservation;
  const noCrmMatch = showCrmPanel && !crmSearch.isLoading && crmMatches.length === 0;

  function applyCrmMatch(client: CrmClient) {
    if (client.name) setValue('customerName', client.name, { shouldDirty: true });
    if (client.phone) setValue('phone', client.phone, { shouldDirty: true });
    if (client.phoneCountry === 'US' || client.phoneCountry === 'MX') {
      setValue('phoneCountry', client.phoneCountry, { shouldDirty: true });
    }
  }

  const onSubmit = handleSubmit(async (form) => {
    if (!hold) return;
    const wantsDeadline =
      paymentDeadlineEnabled || isDigital || cashRequiresDeadline;
    const paymentDeadlineAt = wantsDeadline
      ? `${form.paymentDeadlineDate}T${form.paymentDeadlineTime}:00`
      : undefined;
    const status: PaymentStatusChoice = isDigital ? 'PENDING' : form.paymentStatus;
    const created = await createReservation.mutateAsync({
      eventDate,
      tableId: hold.tableId,
      holdId: hold.holdId ?? '',
      customerName: form.customerName.trim(),
      phone: form.phone.trim(),
      phoneCountry: form.phoneCountry,
      paymentMethod: form.paymentMethod,
      paymentStatus: status,
      amountDue: Number(form.amountDue) || 0,
      depositAmount: Number(form.depositAmount) || 0,
      packageId: form.packageId || undefined,
      receiptNumber: form.receiptNumber.trim() || undefined,
      paymentDeadlineAt,
      paymentDeadlineTz: wantsDeadline ? DEFAULT_DEADLINE_TZ : undefined,
    });
    setCreatedReservation(created);
    setHold(null);
  });

  const submitError =
    createReservation.error instanceof ApiError
      ? `${createReservation.error.status}: ${createReservation.error.message}`
      : null;
  const holdError =
    createHold.error instanceof ApiError
      ? `${createHold.error.status}: ${createHold.error.message}`
      : null;

  const depositValid =
    isCash && watchedStatus === 'COURTESY'
      ? true
      : isCash && watchedStatus === 'PAID'
        ? Math.abs(watchedDeposit - watchedAmountDue) < 0.01
        : isCash
          ? watchedDeposit >= minDeposit
          : true;

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

        {eventDate ? (
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

      </div>

      {(createdReservation || (hold && heldTable)) && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
        >
          <div className="relative my-4 w-full max-w-3xl rounded-2xl bg-background p-5 shadow-xl">
            <header className="mb-4 flex items-baseline justify-between gap-3 border-b border-border pb-3">
              {hold && heldTable ? (
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
              ) : (
                <div>
                  <p className="text-sm font-semibold text-brand-900">
                    {t('reservationNew.postCreate.heading')}
                  </p>
                </div>
              )}
              <div className="flex items-center gap-2">
                {hold && !createdReservation && (
                  <span
                    className={`rounded-full border px-3 py-1 text-xs font-mono ${
                      expired
                        ? 'border-destructive bg-danger-100/40 text-destructive'
                        : 'border-border bg-muted/40 text-brand-900'
                    }`}
                  >
                    {expired
                      ? t('reservationNew.holdExpired')
                      : `${Math.floor(remainingSec / 60)}m ${String(remainingSec % 60).padStart(2, '0')}s`}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (createdReservation) {
                      setCreatedReservation(null);
                      return;
                    }
                    handleReleaseHold();
                  }}
                  aria-label={t('reservationNew.closeModal')}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border text-sm text-brand-900 hover:bg-muted"
                >
                  ✕
                </button>
              </div>
            </header>

            {createdReservation && (
              <PostCreatePanel
                reservation={createdReservation}
                isDigital={
                  createdReservation.paymentMethod === 'square' ||
                  createdReservation.paymentMethod === 'cashapp'
                }
                onDone={() =>
                  navigate(
                    `/staff/reservations/${createdReservation.eventDate}/${createdReservation.reservationId}`
                  )
                }
                onAnother={() => {
                  setCreatedReservation(null);
                }}
              />
            )}

            {hold && heldTable && !expired && !createdReservation && (
              <form onSubmit={onSubmit} className="space-y-4">
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

            {showCrmPanel && (
              <div className="rounded-md border border-border bg-muted/30 p-2">
                {crmSearch.isLoading ? (
                  <p className="text-xs text-muted-foreground">
                    {t('reservationNew.crm.searching')}
                  </p>
                ) : noCrmMatch ? (
                  <p className="text-xs text-muted-foreground">
                    {t('reservationNew.crm.noMatch')}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {crmMatches.slice(0, 5).map((c) => (
                      <li key={c.phone}>
                        <button
                          type="button"
                          onClick={() => applyCrmMatch(c)}
                          className="flex w-full items-baseline justify-between gap-2 rounded-md border border-border bg-background px-2 py-1 text-left text-sm hover:border-primary"
                        >
                          <span className="font-medium text-brand-900">
                            {c.name ?? '—'}
                          </span>
                          <span className="text-xs font-mono text-muted-foreground">
                            {c.phone}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

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

            <div>
              <p className="mb-1 text-sm font-medium text-brand-900">
                {t('reservationNew.field.paymentMethod')} *
              </p>
              <div className="grid grid-cols-3 gap-2">
                {(['square', 'cashapp', 'cash'] as PaymentMethodChoice[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setValue('paymentMethod', m, { shouldDirty: true })}
                    className={`h-10 rounded-md border px-3 text-sm font-semibold transition ${
                      watchedMethod === m
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-brand-900 hover:bg-muted'
                    }`}
                  >
                    {t(`reservationNew.method.${m}`)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                className="mb-1 block text-sm font-medium text-brand-900"
                htmlFor="amountDue"
              >
                {t('reservationNew.field.amountDue')} *
              </label>
              <input
                id="amountDue"
                type="number"
                step="0.01"
                min="0"
                {...register('amountDue', { valueAsNumber: true, min: 0 })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('reservationNew.field.amountDueHint', {
                  table: moneyFormatter.format(tablePrice),
                })}
              </p>
            </div>

            {isDigital && (
              <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-brand-700">
                {t('reservationNew.digitalNotice', {
                  method: watchedMethod === 'square' ? 'Square' : 'Cash App',
                })}
              </p>
            )}

            {isCash && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    className="mb-1 block text-sm font-medium text-brand-900"
                    htmlFor="paymentStatus"
                  >
                    {t('reservationNew.field.paymentStatus')} *
                  </label>
                  <select
                    id="paymentStatus"
                    {...register('paymentStatus')}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="PAID">PAID</option>
                    <option value="PARTIAL">PARTIAL</option>
                    <option value="PENDING">PENDING</option>
                    <option value="COURTESY">COURTESY</option>
                  </select>
                </div>
                <div>
                  <label
                    className="mb-1 block text-sm font-medium text-brand-900"
                    htmlFor="depositAmount"
                  >
                    {t('reservationNew.field.deposit')} *
                  </label>
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input
                      id="depositAmount"
                      type="number"
                      step="0.01"
                      min="0"
                      readOnly={!allowCustomDeposit}
                      {...register('depositAmount', { valueAsNumber: true })}
                      className={`w-full rounded-md border border-border px-3 py-2 text-sm ${
                        allowCustomDeposit ? 'bg-background' : 'bg-muted/40'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setAllowCustomDeposit((v) => !v)}
                      className="inline-flex items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-brand-900 hover:bg-muted"
                    >
                      {allowCustomDeposit
                        ? t('reservationNew.deposit.lock')
                        : t('reservationNew.deposit.modify')}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('reservationNew.field.depositHint', {
                      min: moneyFormatter.format(minDeposit),
                      table: moneyFormatter.format(tablePrice),
                    })}
                  </p>
                </div>
              </div>
            )}

            {isDigital && (
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="depositAmount"
                >
                  {t('reservationNew.field.depositOptional')}
                </label>
                <input
                  id="depositAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  {...register('depositAmount', { valueAsNumber: true })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('reservationNew.field.depositOptionalHint')}
                </p>
              </div>
            )}

            <div>
              {!deadlineRequired && (
                <label className="mb-2 flex items-center gap-2 text-sm text-brand-900">
                  <input
                    type="checkbox"
                    checked={paymentDeadlineEnabled}
                    onChange={(e) => setPaymentDeadlineEnabled(e.target.checked)}
                    className="h-4 w-4 rounded border-border"
                  />
                  {t('reservationNew.field.deadlineToggle')}
                </label>
              )}
              {(paymentDeadlineEnabled || deadlineRequired) && (
                <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-muted/20 p-3">
                  <div>
                    <label
                      className="mb-1 block text-xs text-brand-700"
                      htmlFor="paymentDeadlineDate"
                    >
                      {t('reservationNew.field.deadlineDate')}
                    </label>
                    <input
                      id="paymentDeadlineDate"
                      type="date"
                      {...register('paymentDeadlineDate')}
                      className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    />
                  </div>
                  <div>
                    <label
                      className="mb-1 block text-xs text-brand-700"
                      htmlFor="paymentDeadlineTime"
                    >
                      {t('reservationNew.field.deadlineTime')}
                    </label>
                    <input
                      id="paymentDeadlineTime"
                      type="time"
                      {...register('paymentDeadlineTime')}
                      className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    />
                  </div>
                  <p className="col-span-2 text-xs text-muted-foreground">
                    {t('reservationNew.field.deadlineHint')}
                  </p>
                </div>
              )}
            </div>

            {isCash && (
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
      )}
    </div>
  );
}

function PostCreatePanel({
  reservation,
  isDigital,
  onDone,
  onAnother,
}: {
  reservation: ReservationItem;
  isDigital: boolean;
  onDone: () => void;
  onAnother: () => void;
}) {
  const { t, i18n } = useTranslation();
  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });
  const createLink = useCreateSquarePaymentLink(
    reservation.reservationId,
    reservation.eventDate
  );
  const sendSms = useSendSquareLinkSms(
    reservation.reservationId,
    reservation.eventDate
  );

  const linkUrl = createLink.data?.paymentLinkUrl ?? reservation.paymentLinkUrl ?? '';
  const remaining = Math.max(
    0,
    Number(reservation.amountDue ?? 0) - Number(reservation.depositAmount ?? 0)
  );

  const message = t('reservationNew.share.message', {
    name: reservation.customerName,
    table: reservation.tableId,
    amount: moneyFormatter.format(remaining || (reservation.amountDue ?? 0)),
    url: linkUrl,
  });

  function copyLink() {
    if (!linkUrl) return;
    void navigator.clipboard.writeText(linkUrl);
  }
  function openWhatsApp() {
    if (!linkUrl) return;
    const phone = String(reservation.phone ?? '').replace(/\D/g, '');
    const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  }
  function nativeShare() {
    if (!linkUrl) return;
    if (navigator.share) {
      void navigator.share({ text: message, url: linkUrl });
    } else {
      copyLink();
    }
  }

  const apiError = createLink.error ?? sendSms.error;
  const errorMessage =
    apiError && 'status' in apiError && 'message' in apiError
      ? `${(apiError as { status: number }).status}: ${(apiError as { message: string }).message}`
      : null;

  return (
    <article className="rounded-lg border-2 border-success-200 bg-success-100/40 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-success-700">
            {t('reservationNew.postCreate.heading')}
          </h2>
          <p className="text-sm text-brand-700">
            {reservation.customerName} · {t('reservations.tableShort')}{' '}
            {reservation.tableId} · {moneyFormatter.format(reservation.amountDue ?? 0)}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onAnother}
            className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted"
          >
            {t('reservationNew.postCreate.another')}
          </button>
          <button
            type="button"
            onClick={onDone}
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('reservationNew.postCreate.viewDetail')}
          </button>
        </div>
      </div>

      {isDigital && remaining > 0 && (
        <div className="mt-4 space-y-3 rounded-md border border-border bg-background p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold text-brand-900">
              {t('reservationNew.postCreate.linkHeading')}
            </p>
            <button
              type="button"
              onClick={() => createLink.mutate({ eventDate: reservation.eventDate })}
              disabled={createLink.isPending}
              className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createLink.isPending
                ? t('common.saving')
                : linkUrl
                  ? t('reservationNew.postCreate.regenerate')
                  : t('reservationNew.postCreate.generate')}
            </button>
          </div>

          {linkUrl ? (
            <>
              <input
                type="text"
                readOnly
                value={linkUrl}
                className="w-full rounded-md border border-border bg-muted/40 px-2 py-1 text-xs font-mono text-brand-900"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={copyLink}
                  className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted"
                >
                  {t('reservationNew.postCreate.copy')}
                </button>
                <button
                  type="button"
                  onClick={() => sendSms.mutate()}
                  disabled={sendSms.isPending}
                  className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted disabled:opacity-50"
                >
                  {sendSms.isPending
                    ? t('common.saving')
                    : t('reservationNew.postCreate.sms')}
                </button>
                <button
                  type="button"
                  onClick={openWhatsApp}
                  className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted"
                >
                  {t('reservationNew.postCreate.whatsApp')}
                </button>
                <button
                  type="button"
                  onClick={nativeShare}
                  className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted"
                >
                  {t('reservationNew.postCreate.share')}
                </button>
              </div>
              {sendSms.isSuccess && (
                <p className="text-xs text-success-700">
                  {t('reservationNew.postCreate.smsSent')}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('reservationNew.postCreate.linkHint')}
            </p>
          )}
          {errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}
        </div>
      )}

      {!isDigital && (
        <p className="mt-4 text-sm text-brand-700">
          {t('reservationNew.postCreate.cashSummary')}
        </p>
      )}
    </article>
  );
}
