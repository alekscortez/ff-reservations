import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import {
  useCreateEvent,
  useEvent,
  useUpdateEvent,
  type UpdateEventPayload,
} from '@/lib/api/events';

interface FormShape {
  eventName: string;
  eventDate: string;
  minDeposit: number;
  status: 'ACTIVE' | 'INACTIVE';
}

const EMPTY_FORM: FormShape = {
  eventName: '',
  eventDate: '',
  minDeposit: 0,
  status: 'ACTIVE',
};

export function EventForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { eventId } = useParams<{ eventId?: string }>();
  const isEdit = Boolean(eventId);

  const { data: existing, isLoading: loadingExisting } = useEvent(eventId);
  const createMutation = useCreateEvent();
  const updateMutation = useUpdateEvent(eventId ?? '');

  const { register, handleSubmit, reset, formState } = useForm<FormShape>({
    defaultValues: EMPTY_FORM,
  });

  useEffect(() => {
    if (existing) {
      reset({
        eventName: existing.eventName,
        eventDate: existing.eventDate,
        minDeposit: existing.minDeposit,
        status: existing.status,
      });
    }
  }, [existing, reset]);

  const onSubmit = handleSubmit(async (form) => {
    if (isEdit && eventId) {
      const payload: UpdateEventPayload = {
        eventName: form.eventName.trim(),
        eventDate: form.eventDate,
        minDeposit: Number(form.minDeposit) || 0,
        status: form.status,
      };
      await updateMutation.mutateAsync(payload);
    } else {
      await createMutation.mutateAsync({
        eventName: form.eventName.trim(),
        eventDate: form.eventDate,
        minDeposit: Number(form.minDeposit) || 0,
      });
    }
    navigate('/staff/events');
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
            {isEdit ? t('events.editTitle') : t('events.newTitle')}
          </h1>
          <Link to="/staff/events" className="text-sm text-muted-foreground hover:text-brand-900">
            ← {t('events.listTitle')}
          </Link>
        </header>

        {isEdit && loadingExisting ? (
          <p className="mt-6 text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-5">
            <div>
              <label
                className="mb-1 block text-sm font-medium text-brand-900"
                htmlFor="eventName"
              >
                {t('events.field.name')} *
              </label>
              <input
                id="eventName"
                {...register('eventName', { required: true })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="eventDate"
                >
                  {t('events.field.date')} *
                </label>
                <input
                  id="eventDate"
                  type="date"
                  {...register('eventDate', { required: true })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="minDeposit"
                >
                  {t('events.field.minDeposit')} *
                </label>
                <input
                  id="minDeposit"
                  type="number"
                  step="0.01"
                  min="0"
                  {...register('minDeposit', { valueAsNumber: true })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>

            {isEdit && (
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="status"
                >
                  {t('events.field.status')}
                </label>
                <select
                  id="status"
                  {...register('status')}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INACTIVE">INACTIVE</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('events.field.statusHint')}
                </p>
              </div>
            )}

            {submitError && (
              <p className="text-sm text-destructive" role="alert">
                {submitError}
              </p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Link
                to="/staff/events"
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
