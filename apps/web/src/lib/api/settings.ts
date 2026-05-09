import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';

export interface AppSettings {
  operatingTz: string;
  operatingDayCutoffHour: number;
  holdTtlSeconds: number;
  cashReceiptNumberRequired: boolean;
  paymentLinkTtlMinutes: number;
  frequentPaymentLinkTtlMinutes: number;
  autoSendSquareLinkSms: boolean;
  smsEnabled: boolean;
  defaultPaymentDeadlineHour: number;
  defaultPaymentDeadlineMinute: number;
  rescheduleCutoffHour: number;
  rescheduleCutoffMinute: number;
  allowPastEventEdits: boolean;
  allowPastEventPayments: boolean;
  dashboardPollingSeconds: number;
  tableAvailabilityPollingSeconds: number;
  clientAvailabilityPollingSeconds: number;
  urgentPaymentWindowMinutes: number;
  maxReservationsPerPhonePerEvent: number;
  maxPendingWindowMinutes: number;
  checkInPassTtlDays: number;
  checkInPassBaseUrl: string;
  showClientFacingMap: boolean;
  auditVerboseLogging: boolean;
  squareEnvMode?: string;
  squareApplicationId?: string;
  squareLocationId?: string;
  sectionMapColors?: Record<string, string>;
}

const KEY = ['admin-settings'] as const;

export function useAppSettings() {
  const api = useApiClient();
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await api.get<{ item: AppSettings }>('/admin/settings');
      return res.item;
    },
  });
}

// Public-ish (staff/admin) runtime context loaded by the reservation flows.
// Mirror of `runtimeSettingsSubset` on the backend.
export interface RuntimeSettings {
  operatingTz: string;
  operatingDayCutoffHour: number;
  defaultPaymentDeadlineHour: number;
  defaultPaymentDeadlineMinute: number;
  cashReceiptNumberRequired: boolean;
  rescheduleCutoffHour: number;
  rescheduleCutoffMinute: number;
  dashboardPollingSeconds: number;
  tableAvailabilityPollingSeconds: number;
  clientAvailabilityPollingSeconds: number;
  urgentPaymentWindowMinutes: number;
  showClientFacingMap: boolean;
  squareEnvMode?: string;
  squareApplicationId?: string;
  squareLocationId?: string;
  squareWebPaymentsEnabled?: boolean;
  sectionMapColors?: Record<string, string>;
}

export interface CurrentEventContext {
  businessDate: string;
  event: { eventId: string; eventDate: string; eventName: string } | null;
  nextEvent: { eventId: string; eventDate: string; eventName: string } | null;
  settings: RuntimeSettings;
  operatingTz: string;
  operatingDayCutoffHour: number;
}

const CONTEXT_KEY = ['events', 'context', 'current'] as const;

export function useEventContext() {
  const api = useApiClient();
  return useQuery({
    queryKey: CONTEXT_KEY,
    queryFn: async () => api.get<CurrentEventContext>('/events/context/current'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpdateAppSettings() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<AppSettings>) => {
      const res = await api.put<{ item: AppSettings }>('/admin/settings', patch);
      return res.item;
    },
    onSuccess: (item) => {
      qc.setQueryData(KEY, item);
    },
  });
}
