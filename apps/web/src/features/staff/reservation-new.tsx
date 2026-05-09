import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { useApiClient } from '@/lib/use-api-client';
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
import {
  useCrmSearch,
  useRescheduleCredits,
  type CrmClient,
  type RescheduleCredit,
} from '@/lib/api/clients';
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
const HOLD_STORAGE_KEY = 'ff_new_res_active_hold_v1';

interface PersistedHoldSession {
  hold: Hold;
  eventDate: string;
  form: CustomerForm;
  allowCustomDeposit: boolean;
  paymentDeadlineEnabled: boolean;
  creditEnabled: boolean;
  selectedCreditId: string | null;
  savedAt: number;
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

  const [allowCustomDeposit, setAllowCustomDeposit] = useState(false);
  const [paymentDeadlineEnabled, setPaymentDeadlineEnabled] = useState(false);

  const { register, handleSubmit, watch, setValue, reset, getValues, formState } = useForm<CustomerForm>({
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

  // When a table gets held, prefill amountDue with table price — but only if
  // it's still at the default 0. Skipping the prefill when a value is already
  // present avoids clobbering a restored hold session or staff-typed override.
  useEffect(() => {
    if (heldTable && tablePrice > 0 && (Number(getValues('amountDue')) || 0) <= 0) {
      setValue('amountDue', tablePrice);
    }
  }, [heldTable, tablePrice, setValue, getValues]);

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
        onSuccess: (created) => setHold(created),
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

  // Restore an active hold session from localStorage on first mount. Survives
  // page reloads / accidental tab close — staff don't lose their typed customer
  // info if a refresh happens mid-flow. Discard if the hold has already
  // expired (server-side). Done before any other form effect so the typed
  // values aren't clobbered by the prefill-amountDue effect.
  const [restoredOnce, setRestoredOnce] = useState(false);
  useEffect(() => {
    if (restoredOnce) return;
    try {
      const raw =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(HOLD_STORAGE_KEY)
          : null;
      if (!raw) {
        setRestoredOnce(true);
        return;
      }
      const data = JSON.parse(raw) as Partial<PersistedHoldSession>;
      const nowS = Math.floor(Date.now() / 1000);
      const exp = Number(data?.hold?.expiresAt ?? 0);
      if (!data?.hold || !data.eventDate || exp <= nowS) {
        window.localStorage.removeItem(HOLD_STORAGE_KEY);
        setRestoredOnce(true);
        return;
      }
      setHold(data.hold as Hold);
      setEventDate(data.eventDate);
      if (data.form) reset(data.form as CustomerForm);
      setAllowCustomDeposit(Boolean(data.allowCustomDeposit));
      setPaymentDeadlineEnabled(Boolean(data.paymentDeadlineEnabled));
    } catch {
      try {
        window.localStorage.removeItem(HOLD_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
    setRestoredOnce(true);
  }, [restoredOnce, reset]);

  const watchedPhone = watch('phone');
  const watchedPhoneCountry = watch('phoneCountry');
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

  // Credits lookup: only fires once we have a CRM-confirmed phone (i.e. at least
  // one match in the search). Backend keys credits on (phone, phoneCountry).
  const crmConfirmed = crmMatches.length > 0;
  const creditsQuery = useRescheduleCredits(
    crmConfirmed ? debouncedPhone : null,
    watchedPhoneCountry
  );
  const availableCredits = useMemo<RescheduleCredit[]>(() => {
    return (creditsQuery.data ?? []).filter((c) => {
      if (c.status !== 'AVAILABLE') return false;
      const remaining = Number(c.amount ?? 0) - Number(c.amountUsed ?? 0);
      return remaining > 0.005;
    });
  }, [creditsQuery.data]);
  const [selectedCreditId, setSelectedCreditId] = useState<string | null>(null);
  // Auto-select the largest credit when the panel first appears.
  useEffect(() => {
    if (availableCredits.length === 0) {
      if (selectedCreditId) setSelectedCreditId(null);
      return;
    }
    if (selectedCreditId && availableCredits.some((c) => c.creditId === selectedCreditId)) {
      return;
    }
    const sorted = [...availableCredits].sort((a, b) => {
      const ar = Number(a.amount ?? 0) - Number(a.amountUsed ?? 0);
      const br = Number(b.amount ?? 0) - Number(b.amountUsed ?? 0);
      return br - ar;
    });
    setSelectedCreditId(sorted[0].creditId);
  }, [availableCredits, selectedCreditId]);
  const selectedCredit = useMemo(
    () => availableCredits.find((c) => c.creditId === selectedCreditId) ?? null,
    [availableCredits, selectedCreditId]
  );
  const [creditEnabled, setCreditEnabled] = useState(false);
  // If credits disappear (phone change), turn off the toggle.
  useEffect(() => {
    if (availableCredits.length === 0 && creditEnabled) setCreditEnabled(false);
  }, [availableCredits.length, creditEnabled]);
  const creditRemainingOnSelected = selectedCredit
    ? Math.max(
        0,
        Number(selectedCredit.amount ?? 0) - Number(selectedCredit.amountUsed ?? 0)
      )
    : 0;
  const creditApplied = creditEnabled && selectedCredit
    ? Math.min(creditRemainingOnSelected, watchedAmountDue || 0)
    : 0;
  const creditRemainderDue = creditEnabled
    ? Math.max(0, (watchedAmountDue || 0) - creditApplied)
    : watchedAmountDue || 0;
  const apiClient = useApiClient();
  const [creditApplyError, setCreditApplyError] = useState<string | null>(null);

  // Persist the active hold session whenever any captured field changes. The
  // load effect above will restore it on next mount if the hold hasn't expired.
  useEffect(() => {
    if (!restoredOnce) return;
    const clear = () => {
      try {
        window.localStorage.removeItem(HOLD_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    };
    if (!hold || expired || createdReservation) {
      clear();
      return;
    }
    const save = () => {
      const data: PersistedHoldSession = {
        hold,
        eventDate,
        form: getValues(),
        allowCustomDeposit,
        paymentDeadlineEnabled,
        creditEnabled,
        selectedCreditId,
        savedAt: Math.floor(Date.now() / 1000),
      };
      try {
        window.localStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(data));
      } catch {
        /* quota / disabled — ignore */
      }
    };
    save();
    const sub = watch(() => save());
    return () => sub.unsubscribe();
  }, [
    restoredOnce,
    hold,
    expired,
    createdReservation,
    eventDate,
    allowCustomDeposit,
    paymentDeadlineEnabled,
    creditEnabled,
    selectedCreditId,
    getValues,
    watch,
  ]);

  function applyCrmMatch(client: CrmClient) {
    if (client.name) setValue('customerName', client.name, { shouldDirty: true });
    if (client.phone) setValue('phone', client.phone, { shouldDirty: true });
    if (client.phoneCountry === 'US' || client.phoneCountry === 'MX') {
      setValue('phoneCountry', client.phoneCountry, { shouldDirty: true });
    }
  }

  const onSubmit = handleSubmit(async (form) => {
    if (!hold) return;
    setCreditApplyError(null);
    // When applying a credit, the reservation is created as PENDING with no
    // deposit; the credit lands as a separate payment immediately after via
    // PUT /reservations/{id}/payment with method=credit. The remainder (if any)
    // is collected through the post-create Square link panel.
    const useCredit = creditEnabled && creditApplied > 0;
    const amountDue = Number(form.amountDue) || 0;
    const wantsDeadline = useCredit
      ? amountDue - creditApplied > 0.005
      : paymentDeadlineEnabled || isDigital || cashRequiresDeadline;
    const paymentDeadlineAt = wantsDeadline
      ? `${form.paymentDeadlineDate}T${form.paymentDeadlineTime}:00`
      : undefined;
    const status: PaymentStatusChoice = useCredit
      ? 'PENDING'
      : isDigital
        ? 'PENDING'
        : form.paymentStatus;
    const created = await createReservation.mutateAsync({
      eventDate,
      tableId: hold.tableId,
      holdId: hold.holdId ?? '',
      customerName: form.customerName.trim(),
      phone: form.phone.trim(),
      phoneCountry: form.phoneCountry,
      paymentMethod: form.paymentMethod,
      paymentStatus: status,
      amountDue,
      depositAmount: useCredit ? 0 : Number(form.depositAmount) || 0,
      packageId: form.packageId || undefined,
      receiptNumber: form.receiptNumber.trim() || undefined,
      paymentDeadlineAt,
      paymentDeadlineTz: wantsDeadline ? DEFAULT_DEADLINE_TZ : undefined,
    });
    if (useCredit && selectedCredit) {
      try {
        const res = await apiClient.put<{ item: ReservationItem }>(
          `/reservations/${created.reservationId}/payment`,
          {
            eventDate,
            amount: creditApplied,
            method: 'credit',
            creditId: selectedCredit.creditId,
          }
        );
        setCreatedReservation(res.item ?? created);
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? `${err.status}: ${err.message}`
            : (err as Error)?.message ?? 'Failed to apply credit';
        setCreditApplyError(msg);
        setCreatedReservation(created);
      }
    } else {
      setCreatedReservation(created);
    }
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

  const depositValid = creditEnabled
    ? true
    : isCash && watchedStatus === 'COURTESY'
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
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <span className="text-brand-700">
                  {t('reservationNew.legend.available')}
                </span>
                {(['A', 'B', 'C', 'D', 'E'] as const).map((s) => (
                  <span
                    key={s}
                    aria-hidden
                    title={`Section ${s}`}
                    className="inline-block h-3 w-3 rounded-full"
                    style={{
                      background: { A: '#ec008c', B: '#2e3192', C: '#00aeef', D: '#f7941d', E: '#711411' }[s],
                    }}
                  />
                ))}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ background: '#9ca3af' }}
                />
                {t('reservationNew.legend.unavailable')}
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
                  createdReservation.paymentMethod === 'cashapp' ||
                  // Backend nulls paymentMethod when status is PENDING (digital
                  // flow + credit-with-remainder); fall back to the form choice.
                  ((createdReservation.paymentMethod ?? null) === null &&
                    (watchedMethod === 'square' || watchedMethod === 'cashapp'))
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

            {availableCredits.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
                <label className="flex items-start gap-2 text-brand-900">
                  <input
                    type="checkbox"
                    checked={creditEnabled}
                    onChange={(e) => setCreditEnabled(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-border"
                  />
                  <span className="flex-1">
                    <span className="font-semibold">
                      {t('reservationNew.credit.applyToggle', {
                        count: availableCredits.length,
                      })}
                    </span>
                  </span>
                </label>
                {creditEnabled && (
                  <div className="mt-2 space-y-2 pl-6">
                    {availableCredits.length > 1 && (
                      <select
                        value={selectedCreditId ?? ''}
                        onChange={(e) => setSelectedCreditId(e.target.value || null)}
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                      >
                        {availableCredits.map((c) => {
                          const remaining =
                            Number(c.amount ?? 0) - Number(c.amountUsed ?? 0);
                          return (
                            <option key={c.creditId} value={c.creditId}>
                              {moneyFormatter.format(remaining)}
                              {c.expiresAt ? ` · exp ${c.expiresAt}` : ''}
                            </option>
                          );
                        })}
                      </select>
                    )}
                    {selectedCredit && (
                      <p className="text-xs text-brand-700">
                        {t('reservationNew.credit.summary', {
                          applied: moneyFormatter.format(creditApplied),
                          remaining: moneyFormatter.format(creditRemainderDue),
                        })}
                      </p>
                    )}
                    {creditRemainderDue > 0.005 && (
                      <p className="text-xs text-muted-foreground">
                        {t('reservationNew.credit.remainderHint')}
                      </p>
                    )}
                  </div>
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

            {isCash && !creditEnabled && (
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

            {isDigital && !creditEnabled && (
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

            <div className={creditEnabled && creditRemainderDue <= 0.005 ? 'hidden' : ''}>
              {!deadlineRequired && !creditEnabled && (
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
            {creditApplyError && (
              <p className="text-sm text-destructive" role="alert">
                {t('reservationNew.credit.applyFailed', { error: creditApplyError })}
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
  const paidTotal = Array.isArray(reservation.payments)
    ? reservation.payments.reduce((sum, p) => sum + (Number(p?.amount) || 0), 0)
    : Number(reservation.depositAmount ?? 0);
  const remaining = Math.max(
    0,
    Number(reservation.amountDue ?? 0) - paidTotal
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
