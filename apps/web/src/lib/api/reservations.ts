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
