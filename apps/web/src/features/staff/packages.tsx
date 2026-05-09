import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { useDeletePackage, usePackagesList } from '@/lib/api/packages';

export function StaffPackages() {
  const { t, i18n } = useTranslation();
  const { data: packages, isLoading, error } = usePackagesList();
  const deleteMutation = useDeletePackage();

  const moneyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  });

  function handleDelete(packageId: string, name: string, status: 'ACTIVE' | 'INACTIVE') {
    const promptKey =
      status === 'ACTIVE'
        ? t('packages.confirmSoftDelete', { name })
        : t('packages.confirmHardDelete', { name });
    if (!window.confirm(promptKey)) return;
    deleteMutation.mutate(packageId);
  }

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold text-brand-900">
          {t('packages.listTitle')}
        </h1>

        <div className="mt-4 flex justify-end">
          <Link
            to="/staff/packages/new"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            + {t('packages.newCta')}
          </Link>
        </div>

        <section className="mt-4">
          {isLoading ? (
            <p className="text-muted-foreground">{t('common.loading')}</p>
          ) : error ? (
            <p className="text-destructive" role="alert">
              {error instanceof ApiError ? `${error.status}: ${error.message}` : t('common.error')}
            </p>
          ) : !packages || packages.length === 0 ? (
            <p className="text-muted-foreground">{t('packages.empty')}</p>
          ) : (
            <ul className="space-y-3">
              {packages.map((pkg) => (
                <li
                  key={pkg.packageId}
                  className="rounded-lg border border-border bg-background p-4"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="font-semibold text-brand-900">{pkg.name}</h2>
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                            pkg.status === 'ACTIVE'
                              ? 'bg-success-100 text-success-700'
                              : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {pkg.status}
                        </span>
                      </div>
                      {pkg.description && (
                        <p className="mt-1 text-sm text-muted-foreground">{pkg.description}</p>
                      )}
                      {pkg.inclusions.length > 0 && (
                        <ul className="mt-2 list-disc pl-5 text-sm text-brand-700">
                          {pkg.inclusions.map((line, i) => (
                            <li key={i}>{line}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2 text-right text-sm">
                      <p className="text-base font-semibold text-brand-900">
                        {moneyFormatter.format(pkg.priceUSD)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('packages.displayOrderShort')}: {pkg.displayOrder}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Link
                          to={`/staff/packages/${pkg.packageId}/edit`}
                          className="text-xs text-primary hover:underline"
                        >
                          {t('common.edit')}
                        </Link>
                        <button
                          type="button"
                          onClick={() => handleDelete(pkg.packageId, pkg.name, pkg.status)}
                          disabled={deleteMutation.isPending}
                          className="text-xs text-destructive hover:underline disabled:opacity-50"
                        >
                          {pkg.status === 'ACTIVE' ? t('common.deactivate') : t('common.delete')}
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
