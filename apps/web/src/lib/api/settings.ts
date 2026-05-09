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
