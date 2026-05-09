import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import {
  useCreatePackage,
  usePackage,
  useUpdatePackage,
  type PackageInput,
} from '@/lib/api/packages';

interface FormShape {
  name: string;
  description: string;
  priceUSD: number;
  inclusionsText: string;
  imageUrl: string;
  displayOrder: number;
  status: 'ACTIVE' | 'INACTIVE';
  esName: string;
  esDescription: string;
  esInclusionsText: string;
}

const EMPTY_FORM: FormShape = {
  name: '',
  description: '',
  priceUSD: 0,
  inclusionsText: '',
  imageUrl: '',
  displayOrder: 0,
  status: 'ACTIVE',
  esName: '',
  esDescription: '',
  esInclusionsText: '',
};

function splitLines(input: string): string[] {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function shapeToInput(form: FormShape): PackageInput {
  const inclusions = splitLines(form.inclusionsText);
  const esInclusions = splitLines(form.esInclusionsText);
  const hasEsBlock =
    form.esName.trim() !== '' || form.esDescription.trim() !== '' || esInclusions.length > 0;

  return {
    name: form.name.trim(),
    description: form.description.trim(),
    priceUSD: Number(form.priceUSD) || 0,
    inclusions,
    imageUrl: form.imageUrl.trim() || null,
    displayOrder: Number(form.displayOrder) || 0,
    status: form.status,
    i18n: hasEsBlock
      ? {
          en: { name: form.name.trim(), description: form.description.trim(), inclusions },
          es: {
            name: form.esName.trim(),
            description: form.esDescription.trim(),
            inclusions: esInclusions,
          },
        }
      : null,
  };
}

export function PackageForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { packageId } = useParams<{ packageId?: string }>();
  const isEdit = Boolean(packageId);

  const { data: existing, isLoading: loadingExisting } = usePackage(packageId);
  const createMutation = useCreatePackage();
  const updateMutation = useUpdatePackage(packageId ?? '');

  const { register, handleSubmit, reset, formState } = useForm<FormShape>({
    defaultValues: EMPTY_FORM,
  });

  useEffect(() => {
    if (existing) {
      reset({
        name: existing.name,
        description: existing.description,
        priceUSD: existing.priceUSD,
        inclusionsText: existing.inclusions.join('\n'),
        imageUrl: existing.imageUrl ?? '',
        displayOrder: existing.displayOrder,
        status: existing.status,
        esName: existing.i18n?.es?.name ?? '',
        esDescription: existing.i18n?.es?.description ?? '',
        esInclusionsText: (existing.i18n?.es?.inclusions ?? []).join('\n'),
      });
    }
  }, [existing, reset]);

  const onSubmit = handleSubmit(async (form) => {
    const payload = shapeToInput(form);
    if (isEdit && packageId) {
      await updateMutation.mutateAsync(payload);
    } else {
      await createMutation.mutateAsync(payload);
    }
    navigate('/staff/packages');
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
            {isEdit ? t('packages.editTitle') : t('packages.newTitle')}
          </h1>
          <Link
            to="/staff/packages"
            className="text-sm text-muted-foreground hover:text-brand-900"
          >
            ← {t('packages.listTitle')}
          </Link>
        </header>

        {isEdit && loadingExisting ? (
          <p className="mt-6 text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-5">
            <div>
              <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="name">
                {t('packages.field.name')} *
              </label>
              <input
                id="name"
                {...register('name', { required: true })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label
                className="mb-1 block text-sm font-medium text-brand-900"
                htmlFor="description"
              >
                {t('packages.field.description')}
              </label>
              <textarea
                id="description"
                rows={3}
                {...register('description')}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="priceUSD"
                >
                  {t('packages.field.priceUSD')} *
                </label>
                <input
                  id="priceUSD"
                  type="number"
                  step="0.01"
                  min="0"
                  {...register('priceUSD', { valueAsNumber: true })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-brand-900"
                  htmlFor="displayOrder"
                >
                  {t('packages.field.displayOrder')}
                </label>
                <input
                  id="displayOrder"
                  type="number"
                  step="1"
                  {...register('displayOrder', { valueAsNumber: true })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div>
              <label
                className="mb-1 block text-sm font-medium text-brand-900"
                htmlFor="inclusionsText"
              >
                {t('packages.field.inclusions')}
              </label>
              <p className="mb-2 text-xs text-muted-foreground">
                {t('packages.field.inclusionsHint')}
              </p>
              <textarea
                id="inclusionsText"
                rows={4}
                {...register('inclusionsText')}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="imageUrl">
                {t('packages.field.imageUrl')}
              </label>
              <input
                id="imageUrl"
                type="url"
                {...register('imageUrl')}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <fieldset className="rounded-md border border-border bg-background p-4">
              <legend className="px-1 text-sm font-medium text-brand-900">
                {t('packages.field.spanishOverride')}
              </legend>
              <p className="text-xs text-muted-foreground">
                {t('packages.field.spanishHint')}
              </p>
              <div className="mt-3 space-y-3">
                <div>
                  <label
                    className="mb-1 block text-xs font-medium text-brand-700"
                    htmlFor="esName"
                  >
                    {t('packages.field.name')} (es)
                  </label>
                  <input
                    id="esName"
                    {...register('esName')}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label
                    className="mb-1 block text-xs font-medium text-brand-700"
                    htmlFor="esDescription"
                  >
                    {t('packages.field.description')} (es)
                  </label>
                  <textarea
                    id="esDescription"
                    rows={2}
                    {...register('esDescription')}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label
                    className="mb-1 block text-xs font-medium text-brand-700"
                    htmlFor="esInclusionsText"
                  >
                    {t('packages.field.inclusions')} (es)
                  </label>
                  <textarea
                    id="esInclusionsText"
                    rows={3}
                    {...register('esInclusionsText')}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                  />
                </div>
              </div>
            </fieldset>

            <div>
              <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="status">
                {t('packages.field.status')}
              </label>
              <select
                id="status"
                {...register('status')}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="INACTIVE">INACTIVE</option>
              </select>
            </div>

            {submitError && (
              <p className="text-sm text-destructive" role="alert">
                {submitError}
              </p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Link
                to="/staff/packages"
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
