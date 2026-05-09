import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFieldArray, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import {
  useCreateFrequentClient,
  useFrequentClient,
  useUpdateFrequentClient,
  type FrequentClientInput,
} from '@/lib/api/frequent-clients';
import { useTableTemplate } from '@/lib/api/tables';

interface TableSettingRow {
  tableId: string;
  paymentStatus: 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY';
  amountDue: number;
  amountPaid: number;
  paymentDeadlineTime: string;
  paymentDeadlineTz: string;
}

interface FormShape {
  name: string;
  phone: string;
  phoneCountry: 'US' | 'MX';
  notes: string;
  status: 'ACTIVE' | 'DISABLED';
  tableSettings: TableSettingRow[];
}

const EMPTY_FORM: FormShape = {
  name: '',
  phone: '',
  phoneCountry: 'MX',
  notes: '',
  status: 'ACTIVE',
  tableSettings: [],
};

const DEFAULT_TZ = 'America/Chicago';

export function FrequentClientForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { clientId } = useParams<{ clientId?: string }>();
  const isEdit = Boolean(clientId);

  const { data: existing, isLoading: loadingExisting } = useFrequentClient(clientId);
  const { data: template } = useTableTemplate();
  const createMutation = useCreateFrequentClient();
  const updateMutation = useUpdateFrequentClient(clientId ?? '');

  const { register, handleSubmit, reset, control, formState, watch } = useForm<FormShape>({
    defaultValues: EMPTY_FORM,
  });

  const tableSettings = useFieldArray({ control, name: 'tableSettings' });

  useEffect(() => {
    if (existing) {
      reset({
        name: existing.name,
        phone: existing.phone,
        phoneCountry: (existing.phoneCountry as 'US' | 'MX') ?? 'MX',
        notes: existing.notes ?? '',
        status: existing.status,
        tableSettings: (existing.tableSettings ?? []).map((s) => ({
          tableId: s.tableId,
          paymentStatus:
            (s.paymentStatus as TableSettingRow['paymentStatus']) ?? 'PENDING',
          amountDue: Number(s.amountDue ?? 0),
          amountPaid: Number(s.amountPaid ?? 0),
          paymentDeadlineTime: s.paymentDeadlineTime ?? '00:00',
          paymentDeadlineTz: s.paymentDeadlineTz ?? DEFAULT_TZ,
        })),
      });
    }
  }, [existing, reset]);

  const usedTableIds = new Set(watch('tableSettings').map((row) => row.tableId).filter(Boolean));

  const onSubmit = handleSubmit(async (form) => {
    const payload: FrequentClientInput = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      phoneCountry: form.phoneCountry,
      notes: form.notes.trim() || undefined,
      tableSettings: form.tableSettings
        .filter((s) => s.tableId)
        .map((s) => ({
          tableId: s.tableId,
          paymentStatus: s.paymentStatus,
          amountDue: Number(s.amountDue) || 0,
          amountPaid: Number(s.amountPaid) || 0,
          paymentDeadlineTime: s.paymentDeadlineTime || '00:00',
          paymentDeadlineTz: s.paymentDeadlineTz || DEFAULT_TZ,
        })),
    };
    if (isEdit && clientId) {
      await updateMutation.mutateAsync({ ...payload, status: form.status });
    } else {
      await createMutation.mutateAsync(payload);
    }
    navigate('/staff/frequent-clients');
  });

  function addTableRow() {
    tableSettings.append({
      tableId: '',
      paymentStatus: 'PENDING',
      amountDue: 0,
      amountPaid: 0,
      paymentDeadlineTime: '00:00',
      paymentDeadlineTz: DEFAULT_TZ,
    });
  }

  const submitting = createMutation.isPending || updateMutation.isPending;
  const submitError =
    createMutation.error instanceof ApiError
      ? `${createMutation.error.status}: ${createMutation.error.message}`
      : updateMutation.error instanceof ApiError
        ? `${updateMutation.error.status}: ${updateMutation.error.message}`
        : null;

  return (
    <div className="p-6 sm:p-8">
      <div className="mx-auto max-w-2xl">
        <header className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {isEdit ? t('frequentClients.editTitle') : t('frequentClients.newTitle')}
          </h1>
          <Link
            to="/staff/frequent-clients"
            className="text-sm text-muted-foreground hover:text-brand-900"
          >
            ← {t('frequentClients.listTitle')}
          </Link>
        </header>

        {isEdit && loadingExisting ? (
          <p className="mt-6 text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-5">
            <div>
              <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="name">
                {t('frequentClients.field.name')} *
              </label>
              <input
                id="name"
                {...register('name', { required: true })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-[1fr_120px] gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="phone">
                  {t('frequentClients.field.phone')} *
                </label>
                <input
                  id="phone"
                  type="tel"
                  placeholder="+528991234567"
                  {...register('phone', { required: true })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('frequentClients.field.phoneHint')}
                </p>
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

            <div>
              <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="notes">
                {t('frequentClients.field.notes')}
              </label>
              <textarea
                id="notes"
                rows={3}
                {...register('notes')}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            {isEdit && (
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="status"
                >
                  {t('frequentClients.field.status')}
                </label>
                <select
                  id="status"
                  {...register('status')}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="DISABLED">DISABLED</option>
                </select>
              </div>
            )}

            <fieldset className="rounded-md border border-border bg-background p-4">
              <legend className="px-2 text-sm font-medium text-brand-900">
                {t('frequentClients.tables.heading')}
              </legend>
              <p className="text-xs text-muted-foreground">
                {t('frequentClients.tables.hint')}
              </p>

              {tableSettings.fields.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t('frequentClients.tables.empty')}
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {tableSettings.fields.map((field, index) => (
                    <div
                      key={field.id}
                      className="grid grid-cols-2 gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-[120px_120px_120px_120px_120px_auto]"
                    >
                      <select
                        {...register(`tableSettings.${index}.tableId`)}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      >
                        <option value="">— {t('frequentClients.tables.tableId')} —</option>
                        {(template?.tables ?? []).map((t) => {
                          const used = usedTableIds.has(t.id);
                          const current = watch(`tableSettings.${index}.tableId`) === t.id;
                          if (used && !current) return null;
                          return (
                            <option key={t.id} value={t.id}>
                              {t.id} (${t.price})
                            </option>
                          );
                        })}
                      </select>
                      <select
                        {...register(`tableSettings.${index}.paymentStatus`)}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      >
                        <option value="PENDING">PENDING</option>
                        <option value="PARTIAL">PARTIAL</option>
                        <option value="PAID">PAID</option>
                        <option value="COURTESY">COURTESY</option>
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        {...register(`tableSettings.${index}.amountDue`, { valueAsNumber: true })}
                        placeholder={t('frequentClients.tables.amountDue')}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      />
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        {...register(`tableSettings.${index}.amountPaid`, { valueAsNumber: true })}
                        placeholder={t('frequentClients.tables.amountPaid')}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      />
                      <input
                        type="time"
                        {...register(`tableSettings.${index}.paymentDeadlineTime`)}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => tableSettings.remove(index)}
                        className="text-xs text-destructive hover:underline"
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={addTableRow}
                className="mt-3 inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-brand-900 hover:bg-muted"
              >
                + {t('frequentClients.tables.addRow')}
              </button>
            </fieldset>

            {submitError && (
              <p className="text-sm text-destructive" role="alert">
                {submitError}
              </p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Link
                to="/staff/frequent-clients"
                className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm font-medium text-brand-900 hover:bg-muted"
              >
                {t('common.cancel')}
              </Link>
              <button
                type="submit"
                disabled={submitting || !formState.isValid}
                className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {submitting ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
