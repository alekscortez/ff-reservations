import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { ReservationItem } from '@ff/core';
import {
  useAddManualPayment,
  useCancelReservation,
  useCheckInPass,
  useCreateCashAppLink,
  useCreateSquarePaymentLink,
  useIssueCheckInPass,
  useReservation,
  useReservationHistory,
  useSendCashAppLinkSms,
  useSendSquareLinkSms,
} from '@/lib/api/reservations';
import { ApiError } from '@/lib/api-client';

interface CashPaymentForm {
  amount: number;
  receiptNumber: string;
  note: string;
}

interface CancelForm {
  cancelReason: string;
  resolutionType: 'CANCEL_NO_REFUND' | 'RESCHEDULE_CREDIT' | 'REFUND';
}

function formatEpoch(epoch: number | undefined, locale: string) {
  if (!epoch) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(epoch * 1000));
}

function CashPaymentSection({
  reservation,
  eventDate,
  remaining,
}: {
  reservation: ReservationItem;
  eventDate: string;
  remaining: number;
}) {
  const { t, i18n } = useTranslation();
  const addPayment = useAddManualPayment(reservation.reservationId, eventDate);
  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  const { register, handleSubmit, reset, formState } = useForm<CashPaymentForm>({
    defaultValues: { amount: remaining, receiptNumber: '', note: '' },
  });

  const onSubmit = handleSubmit(async (form) => {
    await addPayment.mutateAsync({
      eventDate,
      amount: Number(form.amount),
      method: 'cash',
      receiptNumber: form.receiptNumber.trim() || undefined,
      note: form.note.trim() || undefined,
    });
    reset({ amount: 0, receiptNumber: '', note: '' });
  });

  const error =
    addPayment.error instanceof ApiError
      ? `${addPayment.error.status}: ${addPayment.error.message}`
      : null;

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-border p-4">
      <p className="text-xs text-muted-foreground">
        {t('reservationDetail.cash.remaining')}: {moneyFormatter.format(remaining)}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-brand-700" htmlFor="amount">
            {t('reservationDetail.cash.amount')} *
          </label>
          <input
            id="amount"
            type="number"
            step="0.01"
            min="0"
            max={remaining}
            {...register('amount', { valueAsNumber: true, required: true, min: 0.01, max: remaining })}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-brand-700" htmlFor="receiptNumber">
            {t('reservationDetail.cash.receipt')}
          </label>
          <input
            id="receiptNumber"
            type="text"
            inputMode="numeric"
            pattern="\d*"
            {...register('receiptNumber')}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs text-brand-700" htmlFor="note">
          {t('reservationDetail.cash.note')}
        </label>
        <input
          id="note"
          {...register('note')}
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={addPayment.isPending || !formState.isValid}
          className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {addPayment.isPending ? t('common.saving') : t('reservationDetail.cash.record')}
        </button>
      </div>
    </form>
  );
}

function CancelSection({
  reservation,
  eventDate,
}: {
  reservation: ReservationItem;
  eventDate: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cancel = useCancelReservation(reservation.reservationId, eventDate);
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, formState } = useForm<CancelForm>({
    defaultValues: { cancelReason: '', resolutionType: 'CANCEL_NO_REFUND' },
  });

  const hasPayments = (reservation.payments ?? []).some(
    (p) => p.method === 'square' || p.method === 'cashapp'
  );

  const onSubmit = handleSubmit(async (form) => {
    if (!window.confirm(t('reservationDetail.cancel.confirmAgain'))) return;
    await cancel.mutateAsync({
      eventDate,
      tableId: reservation.tableId,
      cancelReason: form.cancelReason.trim(),
      resolutionType: form.resolutionType,
    });
    navigate('/staff/reservations');
  });

  const error =
    cancel.error instanceof ApiError
      ? `${cancel.error.status}: ${cancel.error.message}`
      : null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-destructive hover:underline"
      >
        {t('reservationDetail.cancel.cta')}
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-destructive p-4">
      <p className="text-sm font-medium text-destructive">
        {t('reservationDetail.cancel.heading')}
      </p>
      <div>
        <label className="mb-1 block text-xs text-brand-700" htmlFor="resolutionType">
          {t('reservationDetail.cancel.resolution')} *
        </label>
        <select
          id="resolutionType"
          {...register('resolutionType', { required: true })}
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="CANCEL_NO_REFUND">CANCEL_NO_REFUND</option>
          <option value="RESCHEDULE_CREDIT">RESCHEDULE_CREDIT</option>
          {hasPayments && <option value="REFUND">REFUND</option>}
        </select>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('reservationDetail.cancel.resolutionHint')}
        </p>
      </div>
      <div>
        <label className="mb-1 block text-xs text-brand-700" htmlFor="cancelReason">
          {t('reservationDetail.cancel.reason')} *
        </label>
        <textarea
          id="cancelReason"
          rows={2}
          {...register('cancelReason', { required: true, minLength: 1 })}
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-muted-foreground hover:underline"
        >
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          disabled={cancel.isPending || !formState.isValid}
          className="inline-flex items-center rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
        >
          {cancel.isPending ? t('common.saving') : t('reservationDetail.cancel.confirm')}
        </button>
      </div>
    </form>
  );
}

function PaymentLinkSection({
  reservation,
  eventDate,
  remaining,
}: {
  reservation: ReservationItem;
  eventDate: string;
  remaining: number;
}) {
  const { t, i18n } = useTranslation();
  const create = useCreateSquarePaymentLink(reservation.reservationId, eventDate);
  const sendSms = useSendSquareLinkSms(reservation.reservationId, eventDate);
  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });
  const createError =
    create.error instanceof ApiError
      ? `${create.error.status}: ${create.error.message}`
      : null;
  const smsError =
    sendSms.error instanceof ApiError
      ? `${sendSms.error.status}: ${sendSms.error.message}`
      : null;
  const smsSuccess = sendSms.isSuccess;

  return (
    <div className="space-y-2 rounded-md border border-border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-brand-900">
            {t('reservationDetail.link.title')}
          </p>
          <p className="text-xs text-muted-foreground">
            {reservation.paymentLinkUrl
              ? t('reservationDetail.link.regenerateHint')
              : t('reservationDetail.link.createHint', {
                  amount: moneyFormatter.format(remaining),
                })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => create.mutate({ eventDate })}
            disabled={create.isPending || remaining <= 0}
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {create.isPending
              ? t('common.saving')
              : reservation.paymentLinkUrl
                ? t('reservationDetail.link.regenerate')
                : t('reservationDetail.link.create')}
          </button>
          {reservation.paymentLinkUrl && (
            <button
              type="button"
              onClick={() => sendSms.mutate()}
              disabled={sendSms.isPending}
              className="text-xs text-primary hover:underline disabled:opacity-50"
            >
              {sendSms.isPending ? t('common.saving') : t('reservationDetail.link.sendSms')}
            </button>
          )}
        </div>
      </div>
      {reservation.paymentLinkUrl && (
        <div className="rounded-md bg-muted/40 p-2">
          <p className="text-xs font-mono break-all text-brand-700">
            {reservation.paymentLinkUrl}
          </p>
          {reservation.paymentLinkExpiresAt && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('reservationDetail.link.expiresAt')}: {reservation.paymentLinkExpiresAt}
            </p>
          )}
        </div>
      )}
      {createError && <p className="text-xs text-destructive">{createError}</p>}
      {smsError && <p className="text-xs text-destructive">{smsError}</p>}
      {smsSuccess && (
        <p className="text-xs text-success-700">{t('reservationDetail.link.smsSent')}</p>
      )}
    </div>
  );
}

function CashAppLinkSection({
  reservation,
  eventDate,
  remaining,
}: {
  reservation: ReservationItem;
  eventDate: string;
  remaining: number;
}) {
  const { t, i18n } = useTranslation();
  const create = useCreateCashAppLink(reservation.reservationId, eventDate);
  const sendSms = useSendCashAppLinkSms(reservation.reservationId, eventDate);
  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  const createError =
    create.error instanceof ApiError
      ? `${create.error.status}: ${create.error.message}`
      : null;
  const smsError =
    sendSms.error instanceof ApiError
      ? `${sendSms.error.status}: ${sendSms.error.message}`
      : null;
  const url = create.data?.paymentLinkUrl;

  return (
    <div className="space-y-2 rounded-md border border-border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-brand-900">
            {t('reservationDetail.cashapp.title')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('reservationDetail.cashapp.hint', {
              amount: moneyFormatter.format(remaining),
            })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending || remaining <= 0}
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {create.isPending
              ? t('common.saving')
              : url
                ? t('reservationDetail.cashapp.regenerate')
                : t('reservationDetail.cashapp.create')}
          </button>
          {url && (
            <button
              type="button"
              onClick={() => sendSms.mutate()}
              disabled={sendSms.isPending}
              className="text-xs text-primary hover:underline disabled:opacity-50"
            >
              {sendSms.isPending ? t('common.saving') : t('reservationDetail.cashapp.sendSms')}
            </button>
          )}
        </div>
      </div>
      {url && (
        <div className="rounded-md bg-muted/40 p-2">
          <p className="text-xs font-mono break-all text-brand-700">{url}</p>
        </div>
      )}
      {createError && <p className="text-xs text-destructive">{createError}</p>}
      {smsError && <p className="text-xs text-destructive">{smsError}</p>}
      {sendSms.isSuccess && (
        <p className="text-xs text-success-700">{t('reservationDetail.cashapp.smsSent')}</p>
      )}
    </div>
  );
}

function CheckInPassSection({
  reservation,
  eventDate,
}: {
  reservation: ReservationItem;
  eventDate: string;
}) {
  const { t, i18n } = useTranslation();
  const isPaid = reservation.paymentStatus === 'PAID';
  const fetchPass = useCheckInPass(eventDate, reservation.reservationId, isPaid);
  const issue = useIssueCheckInPass(reservation.reservationId, eventDate);

  if (!isPaid) return null;

  const active = fetchPass.data?.pass ?? null;
  const latest = fetchPass.data?.latestPass ?? null;
  const error =
    issue.error instanceof ApiError
      ? `${issue.error.status}: ${issue.error.message}`
      : null;

  return (
    <section className="rounded-lg border border-border bg-background p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-brand-900">
          {t('reservationDetail.checkInPass.heading')}
        </h2>
        <button
          type="button"
          onClick={() => issue.mutate(Boolean(active))}
          disabled={issue.isPending}
          className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {issue.isPending
            ? t('common.saving')
            : active
              ? t('reservationDetail.checkInPass.reissue')
              : t('reservationDetail.checkInPass.issue')}
        </button>
      </div>

      {fetchPass.isLoading && (
        <p className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>
      )}

      {active ? (
        <div className="mt-3 space-y-2">
          <div className="rounded-md bg-muted/40 p-2">
            {active.url && (
              <p className="text-xs font-mono break-all text-brand-700">{active.url}</p>
            )}
            {active.expiresAt && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('reservationDetail.checkInPass.expiresAt')}:{' '}
                {new Intl.DateTimeFormat(i18n.language, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(active.expiresAt * 1000))}
              </p>
            )}
            {active.qrUrl && (
              <a
                href={active.qrUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-xs text-primary hover:underline"
              >
                {t('reservationDetail.checkInPass.openQr')}
              </a>
            )}
          </div>
        </div>
      ) : latest && latest.consumedAt ? (
        <div className="mt-3 rounded-md bg-success-100 px-3 py-2 text-xs text-success-700">
          {t('reservationDetail.checkInPass.consumed', {
            at: new Intl.DateTimeFormat(i18n.language, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(latest.consumedAt * 1000)),
          })}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {t('reservationDetail.checkInPass.none')}
        </p>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}

export function ReservationDetail() {
  const { t, i18n } = useTranslation();
  const { eventDate, reservationId } = useParams<{
    eventDate: string;
    reservationId: string;
  }>();
  const { data: reservation, isLoading } = useReservation(eventDate, reservationId);
  const { data: history } = useReservationHistory(eventDate, reservationId);

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  if (isLoading) {
    return (
      <main className="min-h-screen bg-brand-50 p-8">
        <p className="text-muted-foreground">{t('common.loading')}</p>
      </main>
    );
  }

  if (!reservation) {
    return (
      <main className="min-h-screen bg-brand-50 p-8">
        <div className="mx-auto max-w-3xl">
          <Link
            to="/staff/reservations"
            className="text-sm text-muted-foreground hover:text-brand-900"
          >
            ← {t('reservations.listTitle')}
          </Link>
          <p className="mt-4 text-destructive">{t('reservationDetail.notFound')}</p>
        </div>
      </main>
    );
  }

  const amountDue = reservation.amountDue ?? 0;
  const paid = reservation.depositAmount ?? 0;
  const remaining = Math.max(0, amountDue - paid);
  const isCancelled = reservation.status === 'CANCELLED';
  const isCourtesy = reservation.paymentStatus === 'COURTESY';

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {reservation.customerName}
            <span className="ml-2 text-base font-normal text-muted-foreground">
              · {t('reservations.tableShort')} {reservation.tableId}
            </span>
          </h1>
          <Link
            to="/staff/reservations"
            className="text-sm text-muted-foreground hover:text-brand-900"
          >
            ← {t('reservations.listTitle')}
          </Link>
        </header>

        <section className="rounded-lg border border-border bg-background p-5">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t('reservationDetail.field.phone')}</dt>
            <dd>{reservation.phone}</dd>
            <dt className="text-muted-foreground">{t('reservationDetail.field.eventDate')}</dt>
            <dd>{reservation.eventDate}</dd>
            <dt className="text-muted-foreground">{t('reservationDetail.field.status')}</dt>
            <dd>
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                  isCancelled
                    ? 'bg-danger-100 text-danger-700'
                    : 'bg-success-100 text-success-700'
                }`}
              >
                {reservation.status}
              </span>
            </dd>
            <dt className="text-muted-foreground">{t('reservationDetail.field.paymentStatus')}</dt>
            <dd>{reservation.paymentStatus ?? 'PENDING'}</dd>
            <dt className="text-muted-foreground">{t('reservationDetail.field.tablePrice')}</dt>
            <dd>{moneyFormatter.format(reservation.tablePrice ?? 0)}</dd>
            <dt className="text-muted-foreground">{t('reservationDetail.field.amountDue')}</dt>
            <dd>{moneyFormatter.format(amountDue)}</dd>
            <dt className="text-muted-foreground">{t('reservationDetail.field.paid')}</dt>
            <dd>{moneyFormatter.format(paid)}</dd>
            <dt className="text-muted-foreground">{t('reservationDetail.field.remaining')}</dt>
            <dd className="font-semibold">{moneyFormatter.format(remaining)}</dd>
            {reservation.paymentDeadlineAt && (
              <>
                <dt className="text-muted-foreground">
                  {t('reservationDetail.field.paymentDeadline')}
                </dt>
                <dd>
                  {reservation.paymentDeadlineAt} ({reservation.paymentDeadlineTz})
                </dd>
              </>
            )}
            {reservation.packageSnapshot && (
              <>
                <dt className="text-muted-foreground">
                  {t('reservationDetail.field.package')}
                </dt>
                <dd>{reservation.packageSnapshot.name}</dd>
              </>
            )}
            {reservation.checkedInAt && (
              <>
                <dt className="text-muted-foreground">{t('reservationDetail.field.checkedIn')}</dt>
                <dd>{formatEpoch(reservation.checkedInAt, i18n.language)}</dd>
              </>
            )}
          </dl>
        </section>

        {!isCancelled && !isCourtesy && remaining > 0 && (
          <section className="rounded-lg border border-border bg-background p-5">
            <h2 className="text-lg font-semibold text-brand-900">
              {t('reservationDetail.payments.heading')}
            </h2>
            <div className="mt-3 space-y-4">
              <PaymentLinkSection
                reservation={reservation}
                eventDate={reservation.eventDate}
                remaining={remaining}
              />
              <CashAppLinkSection
                reservation={reservation}
                eventDate={reservation.eventDate}
                remaining={remaining}
              />
              <CashPaymentSection
                reservation={reservation}
                eventDate={reservation.eventDate}
                remaining={remaining}
              />
            </div>
          </section>
        )}

        {!isCancelled && (
          <CheckInPassSection
            reservation={reservation}
            eventDate={reservation.eventDate}
          />
        )}

        {(reservation.payments ?? []).length > 0 && (
          <section className="rounded-lg border border-border bg-background p-5">
            <h2 className="text-lg font-semibold text-brand-900">
              {t('reservationDetail.paymentHistory.heading')}
            </h2>
            <ul className="mt-3 space-y-2 text-sm">
              {(reservation.payments ?? []).map((p) => (
                <li
                  key={p.paymentId}
                  className="flex items-baseline justify-between rounded-md bg-muted/40 px-3 py-2"
                >
                  <div>
                    <span className="font-medium">{moneyFormatter.format(p.amount)}</span>{' '}
                    <span className="text-xs uppercase text-muted-foreground">
                      {p.method}
                    </span>
                    {p.receiptNumber && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        #{p.receiptNumber}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatEpoch(p.createdAt, i18n.language)}
                    {p.createdBy && <span className="ml-2">· {p.createdBy}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!isCancelled && (
          <section className="rounded-lg border border-border bg-background p-5">
            <h2 className="text-lg font-semibold text-brand-900">
              {t('reservationDetail.cancel.heading')}
            </h2>
            <div className="mt-3">
              <CancelSection reservation={reservation} eventDate={reservation.eventDate} />
            </div>
          </section>
        )}

        {history && history.length > 0 && (
          <section className="rounded-lg border border-border bg-background p-5">
            <h2 className="text-lg font-semibold text-brand-900">
              {t('reservationDetail.history.heading')}
            </h2>
            <ul className="mt-3 space-y-2 text-sm">
              {history.map((h) => (
                <li
                  key={h.SK ?? `${h.changedAt}-${h.changeType}`}
                  className="rounded-md bg-muted/40 px-3 py-2"
                >
                  <p className="font-medium">
                    {h.changeType ?? '—'}
                    {h.beforeStatus !== h.afterStatus &&
                      h.beforeStatus &&
                      h.afterStatus && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {h.beforeStatus} → {h.afterStatus}
                        </span>
                      )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatEpoch(h.changedAt, i18n.language)}
                    {h.changedBy && <span className="ml-2">· {h.changedBy}</span>}
                  </p>
                  {h.changeReason && (
                    <p className="mt-1 text-xs text-brand-700">{h.changeReason}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
