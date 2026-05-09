import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';

export interface CrmClient {
  name?: string;
  phone: string;
  phoneCountry?: string;
  totalSpend?: number;
  totalReservations?: number;
  lastReservationAt?: number;
  lastEventDate?: string;
  lastTableId?: string;
  updatedBy?: string;
}

export interface RescheduleCredit {
  creditId: string;
  phone: string;
  phoneCountry?: string;
  amount: number;
  amountUsed?: number;
  status: 'AVAILABLE' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';
  sourceEventDate?: string;
  sourceReservationId?: string;
  expiresAt?: string;
  createdAt?: number;
  createdBy?: string;
  consumedAt?: number;
  consumedReservationId?: string;
}

const searchKey = (phone: string) => ['clients', 'search', phone] as const;
const fullListKey = ['clients', 'full-list'] as const;
const creditsKey = (phone: string, country: string) =>
  ['clients', 'credits', phone, country] as const;

export function useCrmSearch(phone: string) {
  const api = useApiClient();
  const trimmed = phone.trim();
  return useQuery({
    queryKey: searchKey(trimmed),
    enabled: trimmed.length >= 3,
    queryFn: async () => {
      const res = await api.get<{ items: CrmClient[] }>('/clients/search', {
        phone: trimmed,
      });
      return res.items;
    },
  });
}

export function useCrmFullList(enabled: boolean) {
  const api = useApiClient();
  return useQuery({
    queryKey: fullListKey,
    enabled,
    queryFn: async () => {
      const res = await api.get<{ items: CrmClient[] }>('/clients');
      return res.items;
    },
  });
}

export function useRescheduleCredits(
  phone: string | null | undefined,
  phoneCountry: string = 'MX'
) {
  const api = useApiClient();
  const trimmed = (phone ?? '').trim();
  return useQuery({
    queryKey: creditsKey(trimmed, phoneCountry),
    enabled: trimmed.length >= 3,
    queryFn: async () => {
      const res = await api.get<{ items: RescheduleCredit[] }>('/clients/credits', {
        phone: trimmed,
        phoneCountry,
      });
      return res.items;
    },
  });
}

export interface CrmClientUpdate {
  name?: string;
  phone?: string;
  phoneCountry?: 'US' | 'MX';
}

export function useUpdateCrmClient() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      phoneKey,
      patch,
    }: {
      phoneKey: string;
      patch: CrmClientUpdate;
    }) => {
      const res = await api.put<{ item: CrmClient }>(
        `/clients/${encodeURIComponent(phoneKey)}`,
        patch
      );
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients', 'search'] });
    },
  });
}
