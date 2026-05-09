import { type PropsWithChildren } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';

import { AppSidebar } from '@/components/app-sidebar';
import { SiteHeader } from '@/components/site-header';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { cognitoLogoutUrl, getGroups, isAdmin } from '@/lib/auth';

export function StaffLayout({ children }: PropsWithChildren) {
  const auth = useAuth();
  const showAdmin = isAdmin(getGroups(auth.user));
  const profile = (auth.user?.profile ?? {}) as Record<string, unknown>;
  const profileName = typeof profile.name === 'string' ? profile.name : '';
  const profileEmail = typeof profile.email === 'string' ? profile.email : '';
  const fullName = profileName.trim()
    ? profileName
    : profileEmail
      ? profileEmail.split('@')[0]
      : 'Staff';
  const email = profileEmail;

  async function signOut() {
    await auth.removeUser();
    window.location.href = cognitoLogoutUrl();
  }

  return (
    <SidebarProvider
      style={
        {
          '--sidebar-width': 'calc(var(--spacing) * 64)',
          '--header-height': 'calc(var(--spacing) * 12)',
        } as React.CSSProperties
      }
    >
      <AppSidebar
        showAdmin={showAdmin}
        user={{ name: fullName, email }}
        onSignOut={() => void signOut()}
      />
      <SidebarInset>
        <SiteHeader />
        <div className="flex flex-1 flex-col gap-4 bg-brand-50 p-4 md:p-6">
          {children ?? <Outlet />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
