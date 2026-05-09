import { useMemo } from 'react';
import { useAuth } from 'react-oidc-context';
import { ApiClient } from './api-client';

export function useApiClient(): ApiClient {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? null;
  return useMemo(
    () => new ApiClient({ getAccessToken: () => accessToken }),
    [accessToken]
  );
}
