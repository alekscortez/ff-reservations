import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateEventPayload, EventItem } from '@ff/core';
import { useApiClient } from '@/lib/use-api-client';

interface EventsListResponse {
  items: EventItem[];
}

const LIST_KEY = ['events', 'list'] as const;

export function useEventsList() {
  const api = useApiClient();
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      const res = await api.get<EventsListResponse>('/events');
      return res.items;
    },
  });
}

export function useEvent(eventId: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: ['events', 'detail', eventId],
    enabled: Boolean(eventId),
    queryFn: async () => {
      const res = await api.get<{ item: EventItem }>(`/events/${eventId}`);
      return res.item;
    },
  });
}

export function useCreateEvent() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateEventPayload) => {
      const res = await api.post<{ item: EventItem }>('/events', input);
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export interface UpdateEventPayload {
  eventName?: string;
  eventDate?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  minDeposit?: number;
  tablePricing?: Record<string, number>;
  sectionPricing?: Record<string, number>;
  disabledTables?: string[];
  disabledClients?: string[];
}

export function useUpdateEvent(eventId: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateEventPayload) => {
      const res = await api.put<{ item: EventItem }>(`/events/${eventId}`, input);
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
      qc.invalidateQueries({ queryKey: ['events', 'detail', eventId] });
    },
  });
}

export function useDeleteEvent() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (eventId: string) => {
      await api.delete<unknown>(`/events/${eventId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}
