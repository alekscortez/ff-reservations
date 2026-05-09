import { useState, type PropsWithChildren } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { useTranslation } from 'react-i18next';
import { cognitoLogoutUrl, getGroups, isAdmin } from '@/lib/auth';

interface NavEntry {
  to: string;
  labelKey: string;
  adminOnly?: boolean;
}

const STAFF_NAV: NavEntry[] = [
  { to: '/staff/dashboard', labelKey: 'staff.dashboardTitle' },
  { to: '/staff/events', labelKey: 'events.listTitle' },
  { to: '/staff/reservations', labelKey: 'reservations.listTitle' },
  { to: '/staff/holds', labelKey: 'holds.listTitle' },
  { to: '/staff/check-in', labelKey: 'checkIn.title' },
  { to: '/staff/frequent-clients', labelKey: 'frequentClients.listTitle' },
  { to: '/staff/clients', labelKey: 'clientsCrm.listTitle' },
  { to: '/staff/packages', labelKey: 'packages.listTitle' },
];

const ADMIN_NAV: NavEntry[] = [
  { to: '/admin/financials', labelKey: 'financials.listTitle', adminOnly: true },
  { to: '/admin/users', labelKey: 'adminUsers.listTitle', adminOnly: true },
  { to: '/admin/settings', labelKey: 'settings.listTitle', adminOnly: true },
];

function LanguageToggle() {
  const { i18n } = useTranslation();
  const current = i18n.language?.startsWith('es') ? 'es' : 'en';
  return (
    <div className="inline-flex rounded-md border border-border bg-background text-xs">
      <button
        type="button"
        onClick={() => void i18n.changeLanguage('en')}
        className={`px-2 py-1 ${current === 'en' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-brand-900'}`}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => void i18n.changeLanguage('es')}
        className={`px-2 py-1 ${current === 'es' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-brand-900'}`}
      >
        ES
      </button>
    </div>
  );
}

function SidebarNav({ showAdmin, onNavigate }: { showAdmin: boolean; onNavigate: () => void }) {
  const { t } = useTranslation();
  const items = [...STAFF_NAV, ...(showAdmin ? ADMIN_NAV : [])];
  return (
    <nav className="flex flex-col gap-1 p-3">
      {items.map((entry) => (
        <NavLink
          key={entry.to}
          to={entry.to}
          end={entry.to === '/staff/dashboard'}
          onClick={onNavigate}
          className={({ isActive }) =>
            `rounded-md px-3 py-2 text-sm transition ${
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'text-brand-900 hover:bg-muted'
            }`
          }
        >
          {t(entry.labelKey)}
        </NavLink>
      ))}
    </nav>
  );
}

export function StaffLayout({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const auth = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const showAdmin = isAdmin(getGroups(auth.user));
  const email = auth.user?.profile?.email as string | undefined;

  async function signOut() {
    await auth.removeUser();
    window.location.href = cognitoLogoutUrl();
  }

  return (
    <div className="min-h-screen bg-brand-50">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
        <button
          type="button"
          aria-label={t('layout.toggleNav')}
          onClick={() => setMobileOpen((v) => !v)}
          className="rounded-md border border-border px-2 py-1 text-xs text-brand-900 hover:bg-muted md:hidden"
        >
          ☰
        </button>
        <span className="text-base font-semibold text-brand-900">
          {t('app.title')}
        </span>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <LanguageToggle />
          {email && <span className="hidden text-muted-foreground sm:inline">{email}</span>}
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-muted-foreground hover:text-brand-900"
          >
            {t('auth.logout')}
          </button>
        </div>
      </header>

      <div className="flex">
        <aside
          className={`fixed inset-y-0 left-0 top-12 z-20 w-56 transform border-r border-border bg-background transition-transform md:sticky md:top-12 md:h-[calc(100vh-3rem)] md:translate-x-0 ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <SidebarNav showAdmin={showAdmin} onNavigate={() => setMobileOpen(false)} />
        </aside>

        {mobileOpen && (
          <button
            type="button"
            aria-label={t('layout.closeNav')}
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 top-12 z-10 bg-black/30 md:hidden"
          />
        )}

        <main className="min-h-[calc(100vh-3rem)] flex-1">{children ?? <Outlet />}</main>
      </div>
    </div>
  );
}
