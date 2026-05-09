import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';

export interface Package {
  packageId: string;
  name: string;
  description: string;
  priceUSD: number;
  inclusions: string[];
  imageUrl: string | null;
  displayOrder: number;
  i18n: {
    en?: { name: string; description: string; inclusions: string[] };
    es?: { name: string; description: string; inclusions: string[] };
  } | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: number;
  createdBy: string;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface PackageInput {
  name: string;
  description: string;
  priceUSD: number;
  inclusions: string[];
  imageUrl: string | null;
  displayOrder: number;
  i18n: Package['i18n'];
  status?: 'ACTIVE' | 'INACTIVE';
}

const LIST_KEY = ['packages', 'list'] as const;

export function usePackagesList() {
  const api = useApiClient();
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      const res = await api.get<{ items: Package[] }>('/packages');
      return res.items;
    },
  });
}

export function usePackage(packageId: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: ['packages', 'detail', packageId],
    enabled: Boolean(packageId),
    queryFn: async () => {
      const res = await api.get<{ item: Package }>(`/packages/${packageId}`);
      return res.item;
    },
  });
}

export function useCreatePackage() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PackageInput) => {
      const res = await api.post<{ item: Package }>('/packages', input);
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useUpdatePackage(packageId: string) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<PackageInput>) => {
      const res = await api.put<{ item: Package }>(`/packages/${packageId}`, input);
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
      qc.invalidateQueries({ queryKey: ['packages', 'detail', packageId] });
    },
  });
}

export function useDeletePackage() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (packageId: string) => {
      await api.delete<unknown>(`/packages/${packageId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}
