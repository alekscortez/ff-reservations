import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';

export interface TableForEvent {
  id: string;
  number: string | number;
  section: string;
  price: number;
  status:
    | 'AVAILABLE'
    | 'HOLD'
    | 'RESERVED'
    | 'PENDING_PAYMENT'
    | 'DISABLED'
    | 'UNAVAILABLE';
  disabled?: boolean;
}

export interface TablesForEventResponse {
  event: { eventId: string; eventDate: string; eventName: string; status: string };
  tables: TableForEvent[];
}

export function useTablesForEvent(eventDate: string | null | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: ['tables', 'for-event', eventDate ?? ''],
    enabled: Boolean(eventDate),
    queryFn: async () => {
      return await api.get<TablesForEventResponse>(`/tables/for-event/${eventDate}`);
    },
    refetchInterval: 10000,
  });
}
