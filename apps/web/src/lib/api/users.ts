import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/use-api-client';

export interface AdminUser {
  username: string | null;
  enabled: boolean;
  status: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  name: string | null;
  email: string | null;
  groups: string[];
}

export interface CreateUserInput {
  email: string;
  name?: string;
  role: 'Admin' | 'Staff';
}

const LIST_KEY = ['admin-users', 'list'] as const;

export function useAdminUsersList() {
  const api = useApiClient();
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      const res = await api.get<{ items: AdminUser[]; nextToken: string | null }>(
        '/admin/users',
        { limit: 60 }
      );
      return res.items;
    },
  });
}

export function useCreateAdminUser() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateUserInput) => {
      const res = await api.post<{ item: AdminUser }>('/admin/users', input);
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useUpdateAdminUserRole() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, role }: { username: string; role: 'Admin' | 'Staff' }) => {
      const res = await api.put<{ item: AdminUser }>(
        `/admin/users/${encodeURIComponent(username)}/role`,
        { role }
      );
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useUpdateAdminUserStatus() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, enabled }: { username: string; enabled: boolean }) => {
      const res = await api.put<{ item: AdminUser }>(
        `/admin/users/${encodeURIComponent(username)}/status`,
        { enabled }
      );
      return res.item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY });
    },
  });
}

export function useResetAdminUserPassword() {
  const api = useApiClient();
  return useMutation({
    mutationFn: async (username: string) => {
      const res = await api.post<{ ok: boolean; message: string }>(
        `/admin/users/${encodeURIComponent(username)}/reset-password`,
        {}
      );
      return res;
    },
  });
}
