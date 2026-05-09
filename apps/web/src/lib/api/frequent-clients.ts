import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FrequentClient } from '@ff/core';
import { useApiClient } from '@/lib/use-api-client';

interface FrequentClientsListResponse {
  items: FrequentClient[];
}

const LIST_KEY = ['frequent-clients', 'list'] as const;

export interface FrequentClientInput {
  name: string;
  phone: string;
  phoneCountry?: 'US' | 'MX';
  notes?: string;
  status?: 'ACTIVE' | 'DISABLED';
}

export function useFrequentClientsList() {
  const api = useApiClient();
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      const res = await api.get<FrequentClientsListResponse>('/frequent-clients');
      return res.items;
    },
  });
}

export function useFrequentClient(clientId: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: ['frequent-clients', 'detail', clientId],
    enabled: Boolean(clientId),
    queryFn: async () => {
      const res = await api.get<{ item: FrequentClient }>(`/frequent-clients/${clientId}`);
      return res.item;
    },
  });
}

export function useCreateFrequentClient() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: FrequentClientInput) => {
      const res = await api.post<{ item: FrequentClient }>('/frequent-clients', input);
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useUpdateFrequentClient(clientId: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<FrequentClientInput>) => {
      const res = await api.put<{ item: FrequentClient }>(
        `/frequent-clients/${clientId}`,
        input
      );
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
      qc.invalidateQueries({ queryKey: ['frequent-clients', 'detail', clientId] });
    },
  });
}

export function useDeleteFrequentClient() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: string) => {
      await api.delete<unknown>(`/frequent-clients/${clientId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}
