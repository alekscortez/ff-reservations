import type { ConnectedPosition } from '@angular/cdk/overlay';
import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCalendarDays,
  lucideChevronsUpDown,
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
import { map } from 'rxjs';

import { AuthService } from '../../auth/auth.service';
import {
  HlmAvatar,
  HlmAvatarFallback,
  HlmAvatarImage,
} from '../../../shared/ui/avatar';
import {
  HlmMenu,
  HlmMenuItem,
  HlmMenuSeparator,
  HlmMenuTrigger,
} from '../../../shared/ui/dropdown-menu';
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

/**
 * Desktop: popup opens to the right of the chip, bottom-aligned. The
 * chip sits at the bottom of the sidebar, so anchoring to the chip's
 * bottom-right and snapping the overlay's bottom-left to it keeps the
 * menu inside the viewport without overlapping the chip.
 *
 * Fallbacks (in order): if the menu would clip on the right, fall back
 * to opening above; if it would clip downward, fall back to opening
 * below. CDK's FlexibleConnectedPositionStrategy tries each in order
 * until it finds one that fits.
 */
const DESKTOP_MENU_POSITION: ConnectedPosition[] = [
  { originX: 'end', originY: 'bottom', overlayX: 'start', overlayY: 'bottom', offsetX: 8 },
  { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -8 },
  { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 8 },
];

/**
 * Mobile: popup opens above the chip, right-aligned to it. The slide-
 * over sheet occupies a fixed 16rem width on the left, so the chip's
 * right edge is well inside the viewport — anchoring to the chip's
 * top-right and snapping the overlay's bottom-right to it keeps the
 * menu inside the sheet's column.
 */
const MOBILE_MENU_POSITION: ConnectedPosition[] = [
  { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -8 },
  { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -8 },
  { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 8 },
];

@Component({
  selector: 'app-sidebar',
  imports: [
    CommonModule,
    RouterLink,
    RouterLinkActive,
    NgIcon,
    HlmAvatar,
    HlmAvatarImage,
    HlmAvatarFallback,
    HlmMenu,
    HlmMenuTrigger,
    HlmMenuItem,
    HlmMenuSeparator,
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
      lucideChevronsUpDown,
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
  subtitle$ = this.auth.subtitle$();
  photoUrl$ = this.auth.photoUrl$();
  initials$ = this.name$.pipe(map((n) => toInitials(n)));

  /**
   * CDK overlay position for the user-menu popup. Swaps to the mobile
   * variant when the sidebar service detects a narrow viewport so the
   * menu opens above the chip instead of beside it.
   */
  menuPosition = computed<ConnectedPosition[]>(() =>
    this.sidebar.isMobile() ? MOBILE_MENU_POSITION : DESKTOP_MENU_POSITION,
  );

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

/**
 * 1-2 letter initials from a display name. Falls back to "U" for empty
 * strings. Email-shaped names take the first letter of the local part
 * (e.g. "aleks@redbone.mx" → "A"); multi-word names take the first
 * letter of the first and last whitespace-separated tokens
 * ("John Doe" → "JD").
 */
function toInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return (parts[0][0] ?? 'U').toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
