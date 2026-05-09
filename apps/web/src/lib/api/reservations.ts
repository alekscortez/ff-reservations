import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReservationItem } from '@ff/core';
import { useApiClient } from '@/lib/use-api-client';

interface ReservationsListResponse {
  items: ReservationItem[];
}

const listKey = (eventDate: string | undefined) =>
  ['reservations', 'list', eventDate ?? ''] as const;
const historyKey = (reservationId: string, eventDate: string) =>
  ['reservations', 'history', reservationId, eventDate] as const;

export function useReservationsList(eventDate: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: listKey(eventDate),
    enabled: Boolean(eventDate),
    queryFn: async () => {
      const res = await api.get<ReservationsListResponse>('/reservations', { eventDate });
      return res.items;
    },
  });
}

export interface CreateReservationInput {
  eventDate: string;
  tableId: string;
  holdId: string;
  customerName: string;
  phone: string;
  phoneCountry: 'US' | 'MX';
  depositAmount: number;
  amountDue?: number;
  paymentStatus?: 'PENDING' | 'PARTIAL' | 'PAID' | 'COURTESY';
  paymentMethod: 'cash' | 'square' | 'cashapp' | 'credit';
  packageId?: string;
  receiptNumber?: string;
  creditId?: string;
  paymentDeadlineAt?: string;
  paymentDeadlineTz?: string;
}

export interface AutoSquareLinkSmsResult {
  attempted: boolean;
  sent: boolean;
  paymentMethod?: string;
  linkType?: string;
  linkAmount?: number;
  paymentLinkId?: string;
  to?: string | null;
  messageId?: string | null;
  reason?: string;
}

export interface CreateReservationResult {
  item: ReservationItem;
  autoSquareLinkSms?: AutoSquareLinkSmsResult | null;
  idempotentReplay?: boolean;
}

export function useCreateReservation() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateReservationInput): Promise<CreateReservationResult> => {
      const res = await api.post<CreateReservationResult>('/reservations', input);
      return res;
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: listKey(res.item.eventDate) });
      qc.invalidateQueries({ queryKey: ['tables', 'for-event', res.item.eventDate] });
    },
  });
}

export function useReservation(eventDate: string | undefined, reservationId: string | undefined) {
  const list = useReservationsList(eventDate);
  return {
    ...list,
    data: reservationId
      ? (list.data ?? []).find((r) => r.reservationId === reservationId) ?? null
      : null,
  };
}

export interface ReservationHistoryItem {
  SK?: string;
  reservationId: string;
  eventDate?: string;
  eventName?: string;
  changeType?: string;
  changeReason?: string;
  changedAt: number;
  changedBy?: string;
  beforeStatus?: string;
  afterStatus?: string;
  beforePaymentStatus?: string;
  afterPaymentStatus?: string;
  paymentSnapshot?: unknown;
  notes?: string;
}

export function useReservationHistory(
  eventDate: string | undefined,
  reservationId: string | undefined
) {
  const api = useApiClient();
  return useQuery({
    queryKey: historyKey(reservationId ?? '', eventDate ?? ''),
    enabled: Boolean(eventDate && reservationId),
    queryFn: async () => {
      const res = await api.get<{ items: ReservationHistoryItem[] }>(
        `/reservations/${reservationId}/history`,
        { eventDate }
      );
      return res.items;
    },
  });
}

export interface ManualPaymentInput {
  eventDate: string;
  amount: number;
  method: 'cash' | 'credit';
  note?: string;
  creditId?: string;
  receiptNumber?: string;
}

export function useAddManualPayment(reservationId: string, eventDate: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManualPaymentInput) => {
      const res = await api.put<{ item: ReservationItem }>(
        `/reservations/${reservationId}/payment`,
        input
      );
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey(eventDate) });
      qc.invalidateQueries({ queryKey: historyKey(reservationId, eventDate) });
    },
  });
}

export interface SquarePaymentLinkInput {
  eventDate: string;
  amount?: number;
  note?: string;
}

export interface SquarePaymentLinkResponse {
  paymentLinkUrl: string;
  paymentLinkId: string;
  expiresAt: string;
  amount: number;
  reservationId: string;
}

export function useCreateSquarePaymentLink(reservationId: string, eventDate: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SquarePaymentLinkInput) => {
      const res = await api.post<SquarePaymentLinkResponse>(
        `/reservations/${reservationId}/payment-link/square`,
        input
      );
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey(eventDate) });
    },
  });
}

export interface CancelReservationInput {
  eventDate: string;
  tableId: string;
  cancelReason: string;
  resolutionType: 'CANCEL_NO_REFUND' | 'RESCHEDULE_CREDIT' | 'REFUND';
}

export function useCancelReservation(reservationId: string, eventDate: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CancelReservationInput) => {
      await api.put<unknown>(`/reservations/${reservationId}/cancel`, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey(eventDate) });
      qc.invalidateQueries({ queryKey: historyKey(reservationId, eventDate) });
    },
  });
}

export interface CashAppLinkInput {
  eventDate: string;
  amount?: number;
}

export interface CashAppLinkResponse {
  reservation: {
    reservationId: string;
    customerName: string | null;
    phone: string | null;
    paymentStatus: string | null;
    amountDue: number;
    paid: number;
    remainingAmount: number;
    linkAmount: number;
  };
  cashAppLink: {
    url: string;
    expiresAt: number;
    ttlMinutes: number;
  };
}

export function useCreateCashAppLink(reservationId: string, eventDate: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CashAppLinkInput) => {
      const res = await api.post<CashAppLinkResponse>(
        `/reservations/${reservationId}/cashapp-link/square`,
        input
      );
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey(eventDate) });
    },
  });
}

export function useSendCashAppLinkSms(reservationId: string, eventDate: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<{ sent: boolean; messageId?: string }>(
        `/reservations/${reservationId}/cashapp-link/square/sms`,
        { eventDate }
      );
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey(eventDate) });
    },
  });
}

export function useSendSquareLinkSms(reservationId: string, eventDate: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<{ sent: boolean; messageId?: string }>(
        `/reservations/${reservationId}/payment-link/square/sms`,
        { eventDate }
      );
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey(eventDate) });
    },
  });
}

export interface CheckInPassData {
  passId?: string;
  reservationId?: string;
  token?: string | null;
  url?: string | null;
  qrUrl?: string | null;
  status?: string;
  issuedAt?: number;
  issuedBy?: string;
  expiresAt?: number;
  consumedAt?: number;
  consumedBy?: string | null;
}

export interface CheckInPassFetch {
  issued?: boolean;
  reused?: boolean;
  pass?: CheckInPassData | null;
  latestPass?: CheckInPassData | null;
}

const passKey = (reservationId: string, eventDate: string) =>
  ['reservations', 'check-in-pass', reservationId, eventDate] as const;

export function useCheckInPass(
  eventDate: string | undefined,
  reservationId: string | undefined,
  enabled: boolean
) {
  const api = useApiClient();
  return useQuery({
    queryKey: passKey(reservationId ?? '', eventDate ?? ''),
    enabled: enabled && Boolean(eventDate && reservationId),
    queryFn: async () => {
      const res = await api.get<CheckInPassFetch>(
        `/reservations/${reservationId}/check-in-pass`,
        { eventDate }
      );
      return res;
    },
  });
}

export function useIssueCheckInPass(reservationId: string, eventDate: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reissue: boolean) => {
      const res = await api.post<CheckInPassFetch>(
        `/reservations/${reservationId}/check-in-pass`,
        { eventDate, reissue }
      );
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: passKey(reservationId, eventDate) });
      qc.invalidateQueries({ queryKey: listKey(eventDate) });
    },
  });
}
