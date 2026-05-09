import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client';

export type AdminUserRole = 'Admin' | 'Staff' | 'User';

export interface AdminUser {
  username: string | null;
  enabled: boolean;
  status: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  groups: string[];
  role: AdminUserRole;
}

export interface ListAdminUsersResponse {
  items: AdminUser[];
  nextToken: string | null;
}

export interface CreateAdminUserPayload {
  email: string;
  name?: string;
  role: 'Admin' | 'Staff';
}

export interface ResetAdminUserPasswordResponse {
  ok: boolean;
  message: string;
  item: AdminUser;
}

@Injectable({ providedIn: 'root' })
export class UsersService {
  private api = inject(ApiClient);

  list(limit = 50, nextToken?: string | null) {
    const params: Record<string, string | number> = { limit };
    if (nextToken) params['nextToken'] = nextToken;
    return this.api
      .get<ListAdminUsersResponse>('/admin/users', params)
      .pipe(
        map((res) => ({
          items: res.items ?? [],
          nextToken: res.nextToken ?? null,
        }))
      );
  }

  create(payload: CreateAdminUserPayload) {
    return this.api
      .post<{ item: AdminUser }>('/admin/users', payload)
      .pipe(map((res) => res.item));
  }

  updateRole(username: string, role: 'Admin' | 'Staff') {
    return this.api
      .put<{ item: AdminUser }>(`/admin/users/${encodeURIComponent(username)}/role`, { role })
      .pipe(map((res) => res.item));
  }

  updateStatus(username: string, enabled: boolean) {
    return this.api
      .put<{ item: AdminUser }>(`/admin/users/${encodeURIComponent(username)}/status`, { enabled })
      .pipe(map((res) => res.item));
  }

  resetPassword(username: string) {
    return this.api
      .post<ResetAdminUserPasswordResponse>(
        `/admin/users/${encodeURIComponent(username)}/reset-password`,
        {}
      )
      .pipe(map((res) => res));
  }
}
