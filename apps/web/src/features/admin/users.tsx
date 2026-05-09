import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  useAdminUsersList,
  useResetAdminUserPassword,
  useUpdateAdminUserRole,
  useUpdateAdminUserStatus,
  type AdminUser,
} from '@/lib/api/users';
import { ApiError } from '@/lib/api-client';

function UserRow({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  const updateRole = useUpdateAdminUserRole();
  const updateStatus = useUpdateAdminUserStatus();
  const resetPassword = useResetAdminUserPassword();

  if (!user.username) return null;
  const username = user.username;
  const primaryGroup = user.groups.find((g) => g === 'Admin' || g === 'Staff') ?? '';

  function handleRoleChange(role: 'Admin' | 'Staff') {
    if (role === primaryGroup) return;
    updateRole.mutate({ username, role });
  }
  function handleStatusToggle() {
    const next = !user.enabled;
    const promptKey = next ? t('adminUsers.confirmEnable', { username }) : t('adminUsers.confirmDisable', { username });
    if (!window.confirm(promptKey)) return;
    updateStatus.mutate({ username, enabled: next });
  }
  function handleResetPassword() {
    if (!window.confirm(t('adminUsers.confirmResetPassword', { username }))) return;
    resetPassword.mutate(username);
  }

  const busy = updateRole.isPending || updateStatus.isPending || resetPassword.isPending;

  return (
    <li className="rounded-lg border border-border bg-background p-4">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="font-semibold text-brand-900">
            {user.name ?? user.email ?? username}
          </h2>
          {user.email ? (
            <p className="text-sm text-muted-foreground">{user.email}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">@{username}</p>
        </div>
        <div className="flex flex-col items-end gap-2 text-right text-sm">
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs ${
              user.enabled ? 'bg-success-100 text-success-700' : 'bg-danger-100 text-danger-700'
            }`}
          >
            {user.enabled ? t('adminUsers.enabled') : t('adminUsers.disabled')}
          </span>
          <select
            value={primaryGroup}
            onChange={(e) => handleRoleChange(e.target.value as 'Admin' | 'Staff')}
            disabled={busy}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="">—</option>
            <option value="Admin">Admin</option>
            <option value="Staff">Staff</option>
          </select>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleStatusToggle}
              disabled={busy}
              className="text-xs text-primary hover:underline disabled:opacity-50"
            >
              {user.enabled ? t('adminUsers.disable') : t('adminUsers.enable')}
            </button>
            <button
              type="button"
              onClick={handleResetPassword}
              disabled={busy}
              className="text-xs text-primary hover:underline disabled:opacity-50"
            >
              {t('adminUsers.resetPassword')}
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

export function AdminUsers() {
  const { t } = useTranslation();
  const { data: users, isLoading, error } = useAdminUsersList();

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {t('adminUsers.listTitle')}
          </h1>
          <Link to="/staff/dashboard" className="text-sm text-muted-foreground hover:text-brand-900">
            ← {t('staff.dashboardTitle')}
          </Link>
        </header>

        <div className="mt-4 flex justify-end">
          <Link
            to="/admin/users/new"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            + {t('adminUsers.newCta')}
          </Link>
        </div>

        <section className="mt-4">
          {isLoading ? (
            <p className="text-muted-foreground">{t('common.loading')}</p>
          ) : error ? (
            <p className="text-destructive" role="alert">
              {error instanceof ApiError ? `${error.status}: ${error.message}` : t('common.error')}
            </p>
          ) : !users || users.length === 0 ? (
            <p className="text-muted-foreground">{t('adminUsers.empty')}</p>
          ) : (
            <ul className="space-y-3">
              {users.map((user) => (
                <UserRow key={user.username ?? user.email} user={user} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
