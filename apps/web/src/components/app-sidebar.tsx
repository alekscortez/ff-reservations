import * as React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconCalendarEvent,
  IconCheck,
  IconChartBar,
  IconDashboard,
  IconFlame,
  IconGift,
  IconListDetails,
  IconLock,
  IconSettings,
  IconStar,
  IconUserCog,
  IconUsers,
} from '@tabler/icons-react';

import { NavUser } from '@/components/nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

interface NavItem {
  to: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
}

const STAFF_NAV: NavItem[] = [
  { to: '/staff/dashboard', labelKey: 'staff.dashboardTitle', icon: IconDashboard, end: true },
  { to: '/staff/events', labelKey: 'events.listTitle', icon: IconCalendarEvent },
  { to: '/staff/reservations', labelKey: 'reservations.listTitle', icon: IconListDetails },
  { to: '/staff/holds', labelKey: 'holds.listTitle', icon: IconLock },
  { to: '/staff/check-in', labelKey: 'checkIn.title', icon: IconCheck },
  { to: '/staff/frequent-clients', labelKey: 'frequentClients.listTitle', icon: IconStar },
  { to: '/staff/clients', labelKey: 'clientsCrm.listTitle', icon: IconUsers },
  { to: '/staff/packages', labelKey: 'packages.listTitle', icon: IconGift },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/admin/financials', labelKey: 'financials.listTitle', icon: IconChartBar },
  { to: '/admin/users', labelKey: 'adminUsers.listTitle', icon: IconUserCog },
  { to: '/admin/settings', labelKey: 'settings.listTitle', icon: IconSettings },
];

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  showAdmin: boolean;
  user: { name: string; email: string };
  onSignOut: () => void;
}

function NavGroup({
  labelKey,
  items,
}: {
  labelKey: string;
  items: NavItem[];
}) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t(labelKey)}</SidebarGroupLabel>
      <SidebarGroupContent className="flex flex-col gap-1">
        <SidebarMenu>
          {items.map((item) => {
            // Active when the current path equals the route exactly (`end`) or
            // is a descendant. Computed outside so SidebarMenuButton can use
            // asChild + Link without a NavLink render prop (which conflicts
            // with shadcn's icon-on-collapse CSS that targets the button's
            // direct children).
            const isActive = item.end
              ? pathname === item.to
              : pathname === item.to || pathname.startsWith(item.to + '/');
            return (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive}
                  tooltip={t(item.labelKey)}
                >
                  <Link to={item.to}>
                    <item.icon />
                    <span>{t(item.labelKey)}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppSidebar({ showAdmin, user, onSignOut, ...props }: AppSidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="cursor-pointer data-[slot=sidebar-menu-button]:p-1.5!"
              onClick={() => navigate('/staff/dashboard')}
            >
              <IconFlame className="size-5! text-orange-500" />
              <span className="text-base font-semibold">
                {t('app.brandShort')}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavGroup labelKey="layout.staff" items={STAFF_NAV} />
        {showAdmin && <NavGroup labelKey="layout.admin" items={ADMIN_NAV} />}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} onSignOut={onSignOut} />
      </SidebarFooter>
    </Sidebar>
  );
}
