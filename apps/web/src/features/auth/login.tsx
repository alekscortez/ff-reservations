import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { useTranslation } from 'react-i18next';
import { getGroups, isStaffOrAdmin } from '@/lib/auth';

export function Login() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  useEffect(() => {
    if (!auth.isAuthenticated) return;
    const next = isStaffOrAdmin(getGroups(auth.user)) ? '/staff/dashboard' : '/unauthorized';
    navigate(next, { replace: true });
  }, [auth.isAuthenticated, auth.user, navigate]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-50 p-8">
      <div className="max-w-md text-center">
        <h1 className="text-3xl font-semibold text-brand-900">{t('app.title')}</h1>
        <p className="mt-3 text-brand-700">{t('auth.loginPrompt')}</p>
        <button
          type="button"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          onClick={() => void auth.signinRedirect()}
          disabled={auth.isLoading}
        >
          {auth.isLoading ? t('common.loading') : t('auth.login')}
        </button>
        {auth.error ? (
          <p className="mt-4 text-sm text-destructive">{auth.error.message}</p>
        ) : null}
      </div>
    </main>
  );
}
