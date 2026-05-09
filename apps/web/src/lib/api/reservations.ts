import { useQuery } from '@tanstack/react-query';
import type { ReservationItem } from '@ff/core';
import { useApiClient } from '@/lib/use-api-client';

interface ReservationsListResponse {
  items: ReservationItem[];
}

export function useReservationsList(eventDate: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: ['reservations', 'list', eventDate],
    queryFn: async () => {
      const res = await api.get<ReservationsListResponse>('/reservations', { eventDate });
      return res.items;
    },
    enabled: Boolean(eventDate),
  });
}
