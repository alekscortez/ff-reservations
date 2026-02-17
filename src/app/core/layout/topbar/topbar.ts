import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../auth/auth.service';
import { Subscription, catchError, filter, map, of, switchMap } from 'rxjs';
import { EventsService } from '../../http/events.service';
import { ReservationsService } from '../../http/reservations.service';
import { EventItem } from '../../../shared/models/event.model';
import { ReservationItem } from '../../../shared/models/reservation.model';

@Component({
  selector: 'app-topbar',
  imports: [CommonModule, RouterLink],
  templateUrl: './topbar.html',
  styleUrl: './topbar.scss',
})
export class Topbar implements OnInit, OnDestroy {
  private auth = inject(AuthService);
  private router = inject(Router);
  private eventsApi = inject(EventsService);
  private reservationsApi = inject(ReservationsService);

  isAuthenticated$ = this.auth.isAuthenticated$();

  isStaffOrAdmin = false;
  isQuickActionsOpen = false;
  contextMode: 'TODAY' | 'NEXT' | 'NONE' = 'NONE';
  contextEvent: EventItem | null = null;
  urgentPaymentCount = 0;
  quickAvailabilityNotice: string | null = null;
  quickAvailabilityError: string | null = null;

  private roleSub: Subscription | null = null;
  private routeSub: Subscription | null = null;
  private contextSub: Subscription | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private topbarPollingSeconds = 30;
  private urgentPaymentWindowMinutes = 360;

  ngOnInit(): void {
    this.roleSub = this.auth.groups$().subscribe((groups) => {
      this.isStaffOrAdmin = groups.includes('Staff') || groups.includes('Admin');
      if (this.isStaffOrAdmin) {
        this.loadTopbarContext();
        this.startPolling();
      } else {
        this.clearContext();
        this.stopPolling();
      }
    });

    this.routeSub = this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => {
        this.isQuickActionsOpen = false;
      });
  }

  ngOnDestroy(): void {
    this.roleSub?.unsubscribe();
    this.routeSub?.unsubscribe();
    this.contextSub?.unsubscribe();
    this.stopPolling();
  }

  login(): void {
    this.auth.login();
  }

  toggleMobileNav(): void {
    document.body.classList.toggle('mobile-nav-open');
    document.documentElement.classList.toggle('mobile-nav-open');
  }

  toggleQuickActions(): void {
    this.isQuickActionsOpen = !this.isQuickActionsOpen;
    if (this.isQuickActionsOpen) {
      this.resetQuickAvailabilityFeedback();
    }
  }

  closeQuickActions(): void {
    this.isQuickActionsOpen = false;
    this.resetQuickAvailabilityFeedback();
  }

  isOnNewReservationRoute(): boolean {
    return this.router.url.startsWith('/staff/reservations/new');
  }

  newReservationQueryParams(): { date: string } | null {
    if (!this.contextEvent?.eventDate) return null;
    return { date: this.contextEvent.eventDate };
  }

  contextLabel(): string {
    if (!this.contextEvent) return 'No event';
    const prefix = this.contextMode === 'NEXT' ? 'Next' : 'Today';
    return `${prefix}: ${this.contextEvent.eventName}`;
  }

  contextDateLabel(): string {
    if (!this.contextEvent?.eventDate) return '—';
    const date = new Date(`${this.contextEvent.eventDate}T00:00:00`);
    if (Number.isNaN(date.getTime())) return this.contextEvent.eventDate;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  quickActions(): Array<{ label: string; route: string; queryParams?: { date: string } | null; badge?: string | null }> {
    return [
      { label: 'New Reservation', route: '/staff/reservations/new', queryParams: this.newReservationQueryParams() },
      { label: 'Reservations', route: '/staff/reservations' },
      { label: 'Check-In', route: '/staff/check-in' },
      {
        label: 'Urgent Payments',
        route: '/staff/dashboard',
        badge: this.urgentPaymentCount > 0 ? `${this.urgentPaymentCount}` : null,
      },
      { label: 'Dashboard', route: '/staff/dashboard' },
    ];
  }

  sharePublicAvailability(): void {
    const url = this.publicAvailabilityUrl();
    if (!url) {
      this.quickAvailabilityError = 'Live availability link is unavailable right now.';
      this.quickAvailabilityNotice = null;
      return;
    }
    this.quickAvailabilityError = null;
    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator
        .share({
          title: 'Famoso Fuego Availability',
          url,
        })
        .then(() => {
          this.quickAvailabilityNotice = 'Availability link shared.';
        })
        .catch((err: unknown) => {
          const name = String((err as { name?: string } | null)?.name ?? '');
          if (name === 'AbortError') return;
          this.copyPublicAvailability(url);
        });
      return;
    }
    this.copyPublicAvailability(url);
  }

  private loadTopbarContext(): void {
    this.contextSub?.unsubscribe();
    this.contextSub = this.eventsApi
      .getCurrentContext()
      .pipe(
        catchError((err) => {
          if (Number(err?.status) === 403 || Number(err?.status) === 401) {
            return of(null);
          }
          return of(null);
        }),
        switchMap((ctx) => {
          if (!ctx) {
            return of({
              contextEvent: null,
              contextMode: 'NONE' as const,
              urgentCount: 0,
            });
          }
          this.setPollingSeconds(ctx.settings?.clientAvailabilityPollingSeconds);
          this.setUrgentPaymentWindowMinutes(ctx.settings?.urgentPaymentWindowMinutes);
          const contextEvent = ctx.event ?? ctx.nextEvent ?? null;
          const contextMode = ctx.event ? ('TODAY' as const) : contextEvent ? ('NEXT' as const) : ('NONE' as const);
          if (!contextEvent?.eventDate) {
            return of({
              contextEvent,
              contextMode,
              urgentCount: 0,
            });
          }
          return this.reservationsApi.list(contextEvent.eventDate).pipe(
            map((items) => ({
              contextEvent,
              contextMode,
              urgentCount: this.computeUrgentCount(items ?? []),
            })),
            catchError(() =>
              of({
                contextEvent,
                contextMode,
                urgentCount: 0,
              })
            )
          );
        })
      )
      .subscribe(({ contextEvent, contextMode, urgentCount }) => {
        this.contextEvent = contextEvent;
        this.contextMode = contextMode;
        this.urgentPaymentCount = urgentCount;
      });
  }

  private computeUrgentCount(items: ReservationItem[]): number {
    const now = Date.now();
    const dueSoonWindowMs = this.urgentPaymentWindowMinutes * 60 * 1000;
    let count = 0;

    for (const reservation of items) {
      const status = String(reservation?.status ?? '').toUpperCase();
      const paymentStatus = String(reservation?.paymentStatus ?? '').toUpperCase();
      if (status !== 'CONFIRMED') continue;
      if (paymentStatus !== 'PENDING' && paymentStatus !== 'PARTIAL') continue;

      const deadlineMs = Date.parse(String(reservation?.paymentDeadlineAt ?? ''));
      if (!Number.isFinite(deadlineMs)) continue;
      const delta = deadlineMs - now;
      if (delta <= dueSoonWindowMs) count += 1;
    }

    return count;
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(
      () => this.loadTopbarContext(),
      this.topbarPollingSeconds * 1000
    );
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private clearContext(): void {
    this.contextEvent = null;
    this.contextMode = 'NONE';
    this.urgentPaymentCount = 0;
    this.isQuickActionsOpen = false;
    this.resetQuickAvailabilityFeedback();
    this.contextSub?.unsubscribe();
    this.contextSub = null;
  }

  private publicAvailabilityUrl(): string | null {
    if (typeof window === 'undefined') return null;
    const url = new URL('/map', window.location.origin);
    const eventDate = String(this.contextEvent?.eventDate ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      url.searchParams.set('eventDate', eventDate);
    }
    return url.toString();
  }

  private copyPublicAvailability(url: string): void {
    this.writeClipboard(url).then((ok) => {
      if (ok) {
        this.quickAvailabilityNotice = 'Availability link copied.';
        this.quickAvailabilityError = null;
        return;
      }
      this.quickAvailabilityNotice = null;
      this.quickAvailabilityError = 'Copy failed. Please copy manually.';
    });
  }

  private resetQuickAvailabilityFeedback(): void {
    this.quickAvailabilityNotice = null;
    this.quickAvailabilityError = null;
  }

  private async writeClipboard(text: string): Promise<boolean> {
    const value = String(text ?? '').trim();
    if (!value) return false;
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Fall back to legacy copy.
      }
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      return copied;
    } catch {
      return false;
    }
  }

  private setPollingSeconds(value: number | null | undefined): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const next = Math.min(120, Math.max(5, Math.round(parsed)));
    if (next === this.topbarPollingSeconds) return;
    this.topbarPollingSeconds = next;
    if (this.isStaffOrAdmin) {
      this.startPolling();
    }
  }

  private setUrgentPaymentWindowMinutes(value: number | null | undefined): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.urgentPaymentWindowMinutes = Math.min(1440, Math.max(5, Math.round(parsed)));
  }
}
