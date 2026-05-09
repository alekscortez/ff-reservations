import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';

export interface Hold {
  PK?: string;
  SK?: string;
  eventDate: string;
  tableId: string;
  lockType: 'HOLD' | 'RESERVED';
  holdId?: string;
  expiresAt?: number;
  ownerLabel?: string;
  contactName?: string;
  contactPhone?: string;
  chargeAmount?: number;
  reservationId?: string;
  createdAt?: number;
}

const listKey = (eventDate: string) => ['holds', 'list', eventDate] as const;

export function useHoldsList(eventDate: string | null | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: listKey(eventDate ?? ''),
    enabled: Boolean(eventDate),
    queryFn: async () => {
      const res = await api.get<{ items: Hold[] }>('/holds', { eventDate });
      return res.items;
    },
  });
}

export function useReleaseHold(eventDate: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tableId: string) => {
      await api.delete<unknown>(`/holds/${eventDate}/${tableId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey(eventDate) });
    },
  });
}

export interface CreateHoldInput {
  eventDate: string;
  tableId: string;
  contactName?: string;
  contactPhone?: string;
  phoneCountry?: 'US' | 'MX';
  notes?: string;
  chargeAmount?: number;
}

export function useCreateHold() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateHoldInput) => {
      const res = await api.post<{ item: Hold }>('/holds', input);
      return res.item;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: listKey(vars.eventDate) });
      qc.invalidateQueries({ queryKey: ['tables', 'for-event', vars.eventDate] });
    },
  });
}
