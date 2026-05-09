import { useQuery } from '@tanstack/react-query';
import type { EventItem } from '@ff/core';
import { useApiClient } from '@/lib/use-api-client';

interface EventsListResponse {
  items: EventItem[];
}

export function useEventsList() {
  const api = useApiClient();
  return useQuery({
    queryKey: ['events', 'list'],
    queryFn: async () => {
      const res = await api.get<EventsListResponse>('/events');
      return res.items;
    },
  });
}
