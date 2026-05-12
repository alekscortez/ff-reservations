import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCalendarDays,
  lucideCircleUser,
  lucideFlame,
  lucideLayoutDashboard,
  lucideLogOut,
  lucidePartyPopper,
  lucideReceipt,
  lucideSettings,
  lucideShieldCheck,
  lucideStar,
  lucideTicket,
  lucideUsers,
} from '@ng-icons/lucide';

import { AuthService } from '../../auth/auth.service';
import { HlmButton } from '../../../shared/ui/button';
import {
  HlmSidebar,
  HlmSidebarContent,
  HlmSidebarFooter,
  HlmSidebarGroup,
  HlmSidebarGroupLabel,
  HlmSidebarHeader,
  HlmSidebarMenu,
  HlmSidebarMenuButton,
  HlmSidebarMenuItem,
  HlmSidebarService,
} from '../../../shared/ui/sidebar';

@Component({
  selector: 'app-sidebar',
  imports: [
    CommonModule,
    RouterLink,
    RouterLinkActive,
    NgIcon,
    HlmButton,
    HlmSidebar,
    HlmSidebarHeader,
    HlmSidebarContent,
    HlmSidebarFooter,
    HlmSidebarGroup,
    HlmSidebarGroupLabel,
    HlmSidebarMenu,
    HlmSidebarMenuItem,
    HlmSidebarMenuButton,
  ],
  providers: [
    provideIcons({
      lucideCalendarDays,
      lucideCircleUser,
      lucideFlame,
      lucideLayoutDashboard,
      lucideLogOut,
      lucidePartyPopper,
      lucideReceipt,
      lucideSettings,
      lucideShieldCheck,
      lucideStar,
      lucideTicket,
      lucideUsers,
    }),
  ],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar {
  private auth = inject(AuthService);
  private sidebar = inject(HlmSidebarService);

  groups$ = this.auth.groups$();
  isAdmin$ = this.auth.hasGroup$('Admin');
  isStaff$ = this.auth.hasGroup$('Staff');
  isAuthenticated$ = this.auth.isAuthenticated$();
  name$ = this.auth.displayName$();
  role$ = this.auth.roleLabel$();

  /**
   * Called by every nav link on click. On mobile, closes the slide-over
   * after navigation. Desktop is a no-op (sidebar stays visible).
   */
  onNavigate(): void {
    if (this.sidebar.isMobile()) {
      this.sidebar.setOpenMobile(false);
    }
  }

  logout(): void {
    this.onNavigate();
    this.auth.logout();
  }
}
