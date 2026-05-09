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

export interface UseTablesForEventOptions {
  /** Polling interval in seconds. Pass 0 / null to disable polling. */
  pollingSeconds?: number | null;
}

export function useTablesForEvent(
  eventDate: string | null | undefined,
  options?: UseTablesForEventOptions
) {
  const api = useApiClient();
  const seconds =
    options?.pollingSeconds === null
      ? 0
      : Number.isFinite(options?.pollingSeconds)
        ? Number(options?.pollingSeconds)
        : 10;
  return useQuery({
    queryKey: ['tables', 'for-event', eventDate ?? ''],
    enabled: Boolean(eventDate),
    queryFn: async () => {
      return await api.get<TablesForEventResponse>(`/tables/for-event/${eventDate}`);
    },
    refetchInterval: seconds > 0 ? seconds * 1000 : false,
  });
}

export interface TableTemplateEntry {
  id: string;
  number: number | string;
  section: string;
  price: number;
}

export interface TableTemplate {
  version: string;
  sections: Record<string, number>;
  tables: TableTemplateEntry[];
}

export function useTableTemplate() {
  const api = useApiClient();
  return useQuery({
    queryKey: ['tables', 'template'],
    queryFn: async () => {
      const res = await api.get<{ template: TableTemplate }>('/tables/template');
      return res.template;
    },
    staleTime: 60 * 60 * 1000,
  });
}
