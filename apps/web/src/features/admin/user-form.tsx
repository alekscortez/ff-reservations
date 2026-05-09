import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api-client';
import { useCreateAdminUser, type CreateUserInput } from '@/lib/api/users';

interface FormShape {
  email: string;
  name: string;
  role: 'Admin' | 'Staff';
}

export function AdminUserForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createMutation = useCreateAdminUser();

  const { register, handleSubmit, formState } = useForm<FormShape>({
    defaultValues: { email: '', name: '', role: 'Staff' },
  });

  const onSubmit = handleSubmit(async (form) => {
    const payload: CreateUserInput = {
      email: form.email.trim().toLowerCase(),
      name: form.name.trim() || undefined,
      role: form.role,
    };
    await createMutation.mutateAsync(payload);
    navigate('/admin/users');
  });

  const submitError =
    createMutation.error instanceof ApiError
      ? `${createMutation.error.status}: ${createMutation.error.message}`
      : null;

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-2xl">
        <header className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {t('adminUsers.newTitle')}
          </h1>
          <Link to="/admin/users" className="text-sm text-muted-foreground hover:text-brand-900">
            ← {t('adminUsers.listTitle')}
          </Link>
        </header>

        <form onSubmit={onSubmit} className="mt-6 space-y-5">
          <div>
            <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="email">
              {t('adminUsers.field.email')} *
            </label>
            <input
              id="email"
              type="email"
              {...register('email', { required: true })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('adminUsers.field.emailHint')}
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="name">
              {t('adminUsers.field.name')}
            </label>
            <input
              id="name"
              {...register('name')}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-brand-900" htmlFor="role">
              {t('adminUsers.field.role')} *
            </label>
            <select
              id="role"
              {...register('role', { required: true })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="Staff">Staff</option>
              <option value="Admin">Admin</option>
            </select>
          </div>

          {submitError && (
            <p className="text-sm text-destructive" role="alert">
              {submitError}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Link
              to="/admin/users"
              className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm font-medium text-brand-900 hover:bg-muted"
            >
              {t('common.cancel')}
            </Link>
            <button
              type="submit"
              disabled={createMutation.isPending || !formState.isValid}
              className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
