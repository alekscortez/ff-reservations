import type { PropsWithChildren } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { useTranslation } from 'react-i18next';
import { getGroups, isAdmin, isStaffOrAdmin } from '@/lib/auth';

function LoadingScreen() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <p className="text-muted-foreground">{t('common.loading')}</p>
    </main>
  );
}

export function RequireStaffOrAdmin({ children }: PropsWithChildren) {
  const auth = useAuth();
  if (auth.isLoading) return <LoadingScreen />;
  if (!auth.isAuthenticated) return <Navigate to="/login" replace />;
  if (!isStaffOrAdmin(getGroups(auth.user))) return <Navigate to="/unauthorized" replace />;
  return <>{children}</>;
}

export function RequireAdmin({ children }: PropsWithChildren) {
  const auth = useAuth();
  if (auth.isLoading) return <LoadingScreen />;
  if (!auth.isAuthenticated) return <Navigate to="/login" replace />;
  if (!isAdmin(getGroups(auth.user))) return <Navigate to="/unauthorized" replace />;
  return <>{children}</>;
}
