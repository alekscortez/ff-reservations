import { useMutation } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';

export type CheckInResultCode =
  | 'CHECKED_IN'
  | 'ALREADY_USED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'INVALID_TOKEN';

export interface CheckInResult {
  ok: boolean;
  code: CheckInResultCode;
  message: string;
  reservation?: {
    reservationId?: string;
    eventDate?: string;
    tableId?: string;
    customerName?: string;
  };
  pass?: {
    status?: string;
    issuedAt?: number;
    expiresAt?: number;
    usedAt?: number;
    usedBy?: string;
  };
}

export function useVerifyCheckInPass() {
  const api = useApiClient();
  return useMutation({
    mutationFn: async (input: { token: string; scannerDevice?: string }) => {
      const res = await api.post<{ result: CheckInResult }>('/check-in/verify', input);
      return res.result;
    },
  });
}
