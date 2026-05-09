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

// Backend stores the table id only in the DDB sort key ("TABLE#A04") and
// doesn't add a top-level tableId field. Recover it client-side so every
// consumer can rely on hold.tableId.
function withTableId(hold: Hold, fallback?: string): Hold {
  if (hold.tableId) return hold;
  const fromSk = hold.SK?.replace(/^TABLE#/, '');
  return { ...hold, tableId: fromSk ?? fallback ?? '' };
}

export function useHoldsList(eventDate: string | null | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: listKey(eventDate ?? ''),
    enabled: Boolean(eventDate),
    queryFn: async () => {
      const res = await api.get<{ items: Hold[] }>('/holds', { eventDate });
      return (res.items ?? []).map((h) => withTableId(h));
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
  customerName?: string;
  phone?: string;
  phoneCountry?: 'US' | 'MX';
}

export function useCreateHold() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateHoldInput) => {
      const res = await api.post<{ item: Hold }>('/holds', input);
      return withTableId(res.item, input.tableId);
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: listKey(vars.eventDate) });
      qc.invalidateQueries({ queryKey: ['tables', 'for-event', vars.eventDate] });
    },
  });
}
