import { useQuery } from '@tanstack/react-query';
import { ApiClient } from '@/lib/api-client';

const publicApi = new ApiClient({ getAccessToken: () => null });

export interface PassPreview {
  reservationId: string | null;
  eventDate: string | null;
  tableId: string | null;
  customerName: string | null;
  status: string | null;
  expiresAt: number | null;
}

export function usePassPreview(token: string) {
  const trimmed = token.trim();
  return useQuery({
    queryKey: ['check-in-pass', 'preview', trimmed],
    enabled: trimmed.length > 0,
    queryFn: async () => {
      const res = await publicApi.get<{ pass: PassPreview }>('/check-in/pass', {
        token: trimmed,
      });
      return res.pass;
    },
    retry: false,
  });
}
