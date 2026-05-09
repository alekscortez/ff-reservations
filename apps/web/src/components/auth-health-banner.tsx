import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { useApiClient } from '@/lib/use-api-client';

interface WhoamiResponse {
  sub: string;
  groups: string[];
}

export function AuthHealthBanner() {
  const auth = useAuth();
  const api = useApiClient();
  const { t } = useTranslation();

  const { error } = useQuery({
    queryKey: ['admin', 'whoami'],
    queryFn: () => api.get<WhoamiResponse>('/admin/whoami'),
    enabled: auth.isAuthenticated,
    retry: false,
    staleTime: 60_000,
  });

  if (!auth.isAuthenticated) return null;
  if (!(error instanceof ApiError) || error.status !== 403) return null;

  return (
    <div
      role="alert"
      className="bg-destructive text-destructive-foreground px-4 py-2 text-sm"
    >
      <strong>{t('auth.misconfigured')}</strong>
      <span className="ml-2">{t('auth.missingGroupsHelp')}</span>
    </div>
  );
}
