import { Link } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { useTranslation } from 'react-i18next';
import { cognitoLogoutUrl, getGroups } from '@/lib/auth';

export function StaffDashboard() {
  const auth = useAuth();
  const { t } = useTranslation();
  const groups = getGroups(auth.user);
  const email = auth.user?.profile?.email as string | undefined;

  async function signOut() {
    await auth.removeUser();
    window.location.href = cognitoLogoutUrl();
  }

  return (
    <main className="min-h-screen bg-brand-50 p-8">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold text-brand-900">
            {t('staff.dashboardTitle')}
          </h1>
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-sm text-muted-foreground hover:text-brand-900"
          >
            {t('auth.logout')}
          </button>
        </header>
        <section className="mt-6 rounded-lg border border-border bg-background p-6">
          <p className="text-brand-700">{t('staff.dashboardWelcome')}</p>
          <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Email</dt>
            <dd>{email ?? '—'}</dd>
            <dt className="text-muted-foreground">Groups</dt>
            <dd>{groups.length ? groups.join(', ') : '—'}</dd>
          </dl>
        </section>
        <nav className="mt-6 grid gap-3 sm:grid-cols-2">
          <Link
            to="/staff/events"
            className="rounded-lg border border-border bg-background p-4 transition hover:border-primary"
          >
            <h3 className="font-semibold text-brand-900">{t('events.listTitle')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('events.listDescription')}
            </p>
          </Link>
        </nav>
      </div>
    </main>
  );
}
