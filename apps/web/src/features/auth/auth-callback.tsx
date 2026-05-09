import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { useTranslation } from 'react-i18next';
import { getGroups, isStaffOrAdmin } from '@/lib/auth';

export function AuthCallback() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  useEffect(() => {
    if (auth.isLoading) return;
    if (auth.error) {
      navigate('/login', { replace: true });
      return;
    }
    if (auth.isAuthenticated) {
      const next = isStaffOrAdmin(getGroups(auth.user)) ? '/staff/dashboard' : '/unauthorized';
      navigate(next, { replace: true });
    }
  }, [auth.isLoading, auth.isAuthenticated, auth.error, auth.user, navigate]);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <p className="text-muted-foreground">{t('auth.callback.completing')}</p>
    </main>
  );
}
