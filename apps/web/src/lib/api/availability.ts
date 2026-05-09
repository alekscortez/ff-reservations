import { useQuery } from '@tanstack/react-query';
import { ApiClient } from '@/lib/api-client';

const publicApi = new ApiClient({ getAccessToken: () => null });

export interface PublicTable {
  id: string;
  number: string | number;
  section: string;
  price: number;
  status: 'AVAILABLE' | 'UNAVAILABLE';
  available: boolean;
}

export interface PublicAvailability {
  event: {
    eventId: string;
    eventDate: string;
    eventName: string;
    status: string;
  };
  businessDate: string | null;
  asOfEpoch: number;
  counts: {
    total: number;
    available: number;
    unavailable: number;
  };
  refreshSeconds: number;
  sectionMapColors?: Record<string, string>;
  events: Array<{ eventDate: string; eventName: string; status: string }>;
  tables: PublicTable[];
}

const FALLBACK_REFRESH_SECONDS = 10;

export function usePublicAvailability(eventDate: string | null | undefined) {
  return useQuery({
    queryKey: ['public-availability', eventDate ?? 'next'],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (eventDate) params.eventDate = eventDate;
      return await publicApi.get<PublicAvailability>('/public/availability', params);
    },
    refetchInterval: (q) => {
      const data = q.state.data as PublicAvailability | undefined;
      return ((data?.refreshSeconds ?? FALLBACK_REFRESH_SECONDS) * 1000) || FALLBACK_REFRESH_SECONDS * 1000;
    },
    staleTime: 0,
  });
}
