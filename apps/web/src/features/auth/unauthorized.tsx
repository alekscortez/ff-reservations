import { useAuth } from 'react-oidc-context';
import { useTranslation } from 'react-i18next';
import { cognitoLogoutUrl } from '@/lib/auth';

export function Unauthorized() {
  const auth = useAuth();
  const { t } = useTranslation();

  async function signOut() {
    await auth.removeUser();
    window.location.href = cognitoLogoutUrl();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-50 p-8">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold text-brand-900">{t('auth.unauthorizedTitle')}</h1>
        <p className="mt-3 text-brand-700">{t('auth.unauthorized')}</p>
        <button
          type="button"
          className="mt-6 inline-flex items-center justify-center rounded-md border border-border px-5 py-2 text-sm transition hover:bg-secondary"
          onClick={() => void signOut()}
        >
          {t('auth.logout')}
        </button>
      </div>
    </main>
  );
}
