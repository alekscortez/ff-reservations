import { useEffect } from 'react';
import { useForm, type UseFormRegister, type FieldPath } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { useAppSettings, useUpdateAppSettings, type AppSettings } from '@/lib/api/settings';

type FormShape = AppSettings;

interface NumberFieldProps {
  name: FieldPath<FormShape>;
  label: string;
  hint?: string;
  min?: number;
  max?: number;
  register: UseFormRegister<FormShape>;
}

function NumberField({ name, label, hint, min, max, register }: NumberFieldProps) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-brand-700" htmlFor={name}>
        {label}
        {(min !== undefined || max !== undefined) && (
          <span className="ml-2 text-muted-foreground">
            ({min ?? '–'}…{max ?? '–'})
          </span>
        )}
      </label>
      <input
        id={name}
        type="number"
        step="1"
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        {...register(name as FieldPath<FormShape>, { valueAsNumber: true })}
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
      />
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function BoolField({
  name,
  label,
  hint,
  register,
}: {
  name: FieldPath<FormShape>;
  label: string;
  hint?: string;
  register: UseFormRegister<FormShape>;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        {...register(name as FieldPath<FormShape>)}
        className="mt-1 h-4 w-4 rounded border-border"
      />
      <span>
        <span className="block text-sm font-medium text-brand-900">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

function TextField({
  name,
  label,
  hint,
  register,
}: {
  name: FieldPath<FormShape>;
  label: string;
  hint?: string;
  register: UseFormRegister<FormShape>;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-brand-700" htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        type="text"
        {...register(name as FieldPath<FormShape>)}
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
      />
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function AdminSettings() {
  const { t } = useTranslation();
  const { data: settings, isLoading, error } = useAppSettings();
  const update = useUpdateAppSettings();
  const { register, handleSubmit, reset, formState } = useForm<FormShape>({
    defaultValues: undefined,
  });

  useEffect(() => {
    if (settings) reset(settings);
  }, [settings, reset]);

  const onSubmit = handleSubmit(async (form) => {
    await update.mutateAsync(form);
    reset(form);
  });

  const submitError =
    update.error instanceof ApiError
      ? `${update.error.status}: ${update.error.message}`
      : null;
  const loadError =
    error instanceof ApiError ? `${error.status}: ${error.message}` : null;

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold text-brand-900">
          {t('settings.listTitle')}
        </h1>

        {isLoading ? (
          <p className="mt-6 text-muted-foreground">{t('common.loading')}</p>
        ) : loadError ? (
          <p className="mt-6 text-destructive" role="alert">
            {loadError}
          </p>
        ) : !settings ? null : (
          <form onSubmit={onSubmit} className="mt-6 space-y-6">
            <fieldset className="rounded-lg border border-border bg-background p-5">
              <legend className="px-2 text-sm font-semibold text-brand-900">
                {t('settings.groups.operations')}
              </legend>
              <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField
                  name="operatingTz"
                  label={t('settings.field.operatingTz')}
                  hint={t('settings.field.operatingTzHint')}
                  register={register}
                />
                <NumberField
                  name="operatingDayCutoffHour"
                  label={t('settings.field.operatingDayCutoffHour')}
                  hint={t('settings.field.operatingDayCutoffHourHint')}
                  min={0}
                  max={23}
                  register={register}
                />
                <NumberField
                  name="holdTtlSeconds"
                  label={t('settings.field.holdTtlSeconds')}
                  min={60}
                  max={1800}
                  register={register}
                />
                <NumberField
                  name="dashboardPollingSeconds"
                  label={t('settings.field.dashboardPollingSeconds')}
                  min={5}
                  max={120}
                  register={register}
                />
                <NumberField
                  name="tableAvailabilityPollingSeconds"
                  label={t('settings.field.tableAvailabilityPollingSeconds')}
                  min={5}
                  max={120}
                  register={register}
                />
                <NumberField
                  name="clientAvailabilityPollingSeconds"
                  label={t('settings.field.clientAvailabilityPollingSeconds')}
                  min={5}
                  max={120}
                  register={register}
                />
              </div>
            </fieldset>

            <fieldset className="rounded-lg border border-border bg-background p-5">
              <legend className="px-2 text-sm font-semibold text-brand-900">
                {t('settings.groups.payments')}
              </legend>
              <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <NumberField
                  name="paymentLinkTtlMinutes"
                  label={t('settings.field.paymentLinkTtlMinutes')}
                  min={1}
                  max={120}
                  register={register}
                />
                <NumberField
                  name="frequentPaymentLinkTtlMinutes"
                  label={t('settings.field.frequentPaymentLinkTtlMinutes')}
                  min={10}
                  max={10080}
                  register={register}
                />
                <NumberField
                  name="defaultPaymentDeadlineHour"
                  label={t('settings.field.defaultPaymentDeadlineHour')}
                  min={0}
                  max={23}
                  register={register}
                />
                <NumberField
                  name="defaultPaymentDeadlineMinute"
                  label={t('settings.field.defaultPaymentDeadlineMinute')}
                  min={0}
                  max={59}
                  register={register}
                />
                <NumberField
                  name="rescheduleCutoffHour"
                  label={t('settings.field.rescheduleCutoffHour')}
                  min={0}
                  max={23}
                  register={register}
                />
                <NumberField
                  name="rescheduleCutoffMinute"
                  label={t('settings.field.rescheduleCutoffMinute')}
                  min={0}
                  max={59}
                  register={register}
                />
                <NumberField
                  name="urgentPaymentWindowMinutes"
                  label={t('settings.field.urgentPaymentWindowMinutes')}
                  min={5}
                  max={1440}
                  register={register}
                />
                <NumberField
                  name="maxPendingWindowMinutes"
                  label={t('settings.field.maxPendingWindowMinutes')}
                  min={5}
                  max={720}
                  register={register}
                />
              </div>
              <div className="mt-4 space-y-3">
                <BoolField
                  name="autoSendSquareLinkSms"
                  label={t('settings.field.autoSendSquareLinkSms')}
                  hint={t('settings.field.autoSendSquareLinkSmsHint')}
                  register={register}
                />
                <BoolField
                  name="cashReceiptNumberRequired"
                  label={t('settings.field.cashReceiptNumberRequired')}
                  register={register}
                />
                <BoolField
                  name="smsEnabled"
                  label={t('settings.field.smsEnabled')}
                  hint={t('settings.field.smsEnabledHint')}
                  register={register}
                />
              </div>
            </fieldset>

            <fieldset className="rounded-lg border border-border bg-background p-5">
              <legend className="px-2 text-sm font-semibold text-brand-900">
                {t('settings.groups.behavior')}
              </legend>
              <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <NumberField
                  name="maxReservationsPerPhonePerEvent"
                  label={t('settings.field.maxReservationsPerPhonePerEvent')}
                  min={1}
                  max={50}
                  register={register}
                />
                <NumberField
                  name="checkInPassTtlDays"
                  label={t('settings.field.checkInPassTtlDays')}
                  min={1}
                  max={30}
                  register={register}
                />
                <TextField
                  name="checkInPassBaseUrl"
                  label={t('settings.field.checkInPassBaseUrl')}
                  register={register}
                />
              </div>
              <div className="mt-4 space-y-3">
                <BoolField
                  name="allowPastEventEdits"
                  label={t('settings.field.allowPastEventEdits')}
                  register={register}
                />
                <BoolField
                  name="allowPastEventPayments"
                  label={t('settings.field.allowPastEventPayments')}
                  register={register}
                />
              </div>
            </fieldset>

            <fieldset className="rounded-lg border border-border bg-background p-5">
              <legend className="px-2 text-sm font-semibold text-brand-900">
                {t('settings.groups.customerFacing')}
              </legend>
              <div className="mt-2 space-y-3">
                <BoolField
                  name="showClientFacingMap"
                  label={t('settings.field.showClientFacingMap')}
                  hint={t('settings.field.showClientFacingMapHint')}
                  register={register}
                />
              </div>
            </fieldset>

            <fieldset className="rounded-lg border border-border bg-background p-5">
              <legend className="px-2 text-sm font-semibold text-brand-900">
                {t('settings.groups.audit')}
              </legend>
              <div className="mt-2 space-y-3">
                <BoolField
                  name="auditVerboseLogging"
                  label={t('settings.field.auditVerboseLogging')}
                  register={register}
                />
              </div>
            </fieldset>

            {submitError && (
              <p className="text-sm text-destructive" role="alert">
                {submitError}
              </p>
            )}

            <div className="sticky bottom-0 -mx-2 flex justify-end gap-3 rounded-md bg-brand-50/95 px-2 py-3 backdrop-blur">
              <button
                type="submit"
                disabled={update.isPending || !formState.isDirty}
                className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {update.isPending ? t('common.saving') : t('settings.saveCta')}
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
