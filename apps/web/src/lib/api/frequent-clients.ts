import { useQuery } from '@tanstack/react-query';
import type { FrequentClient } from '@ff/core';
import { useApiClient } from '@/lib/use-api-client';

interface FrequentClientsListResponse {
  items: FrequentClient[];
}

export function useFrequentClientsList() {
  const api = useApiClient();
  return useQuery({
    queryKey: ['frequent-clients', 'list'],
    queryFn: async () => {
      const res = await api.get<FrequentClientsListResponse>('/frequent-clients');
      return res.items;
    },
  });
}
