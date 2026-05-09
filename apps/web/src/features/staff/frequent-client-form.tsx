import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import {
  useCreateFrequentClient,
  useFrequentClient,
  useUpdateFrequentClient,
  type FrequentClientInput,
} from '@/lib/api/frequent-clients';

interface FormShape {
  name: string;
  phone: string;
  phoneCountry: 'US' | 'MX';
  notes: string;
  status: 'ACTIVE' | 'DISABLED';
}

const EMPTY_FORM: FormShape = {
  name: '',
  phone: '',
  phoneCountry: 'MX',
  notes: '',
  status: 'ACTIVE',
};

export function FrequentClientForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { clientId } = useParams<{ clientId?: string }>();
  const isEdit = Boolean(clientId);

  const { data: existing, isLoading: loadingExisting } = useFrequentClient(clientId);
  const createMutation = useCreateFrequentClient();
  const updateMutation = useUpdateFrequentClient(clientId ?? '');

  const { register, handleSubmit, reset, formState } = useForm<FormShape>({
    defaultValues: EMPTY_FORM,
  });

  useEffect(() => {
    if (existing) {
      reset({
        name: existing.name,
        phone: existing.phone,
        phoneCountry: (existing.phoneCountry as 'US' | 'MX') ?? 'MX',
        notes: existing.notes ?? '',
        status: existing.status,
      });
    }
  }, [existing, reset]);

  const onSubmit = handleSubmit(async (form) => {
    const payload: FrequentClientInput = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      phoneCountry: form.phoneCountry,
      notes: form.notes.trim() || undefined,
    };
    if (isEdit && clientId) {
      await updateMutation.mutateAsync({ ...payload, status: form.status });
    } else {
      await createMutation.mutateAsync(payload);
    }
    navigate('/staff/frequent-clients');
  });

  const submitting = createMutation.isPending || updateMutation.isPending;
  const submitError =
    createMutation.error instanceof ApiError
      ? `${createMutation.error.status}: ${createMutation.error.message}`
      : updateMutation.error instanceof ApiError
        ? `${updateMutation.error.status}: ${updateMutation.error.message}`
        : null;

  return (
    <main className="min-h-screen bg-brand-50 p-8">
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
    </main>
  );
}
