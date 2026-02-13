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

  private roleSub: Subscription | null = null;
  private routeSub: Subscription | null = null;
  private contextSub: Subscription | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

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
  }

  closeQuickActions(): void {
    this.isQuickActionsOpen = false;
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

  private loadTopbarContext(): void {
    const today = this.todayString();

    this.contextSub?.unsubscribe();
    this.contextSub = this.eventsApi
      .getEventByDate(today)
      .pipe(
        map((event) => ({ event, mode: 'TODAY' as const })),
        catchError((err) => {
          if (Number(err?.status) !== 404) {
            return of({ event: null, mode: 'NONE' as const });
          }
          return this.eventsApi.listEvents().pipe(
            map((events) => {
              const next =
                [...(events ?? [])]
                  .filter((e) => (e.eventDate || '') >= today)
                  .sort((a, b) => (a.eventDate || '').localeCompare(b.eventDate || ''))[0] ?? null;
              return { event: next, mode: next ? ('NEXT' as const) : ('NONE' as const) };
            }),
            catchError(() => of({ event: null, mode: 'NONE' as const }))
          );
        }),
        switchMap((ctx) => {
          if (!ctx.event?.eventDate) {
            return of({ ctx, urgentCount: 0 });
          }
          return this.reservationsApi.list(ctx.event.eventDate).pipe(
            map((items) => ({ ctx, urgentCount: this.computeUrgentCount(items ?? []) })),
            catchError(() => of({ ctx, urgentCount: 0 }))
          );
        })
      )
      .subscribe(({ ctx, urgentCount }) => {
        this.contextEvent = ctx.event;
        this.contextMode = ctx.mode;
        this.urgentPaymentCount = urgentCount;
      });
  }

  private computeUrgentCount(items: ReservationItem[]): number {
    const now = Date.now();
    const dueSoonWindowMs = 6 * 60 * 60 * 1000;
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
    this.pollTimer = setInterval(() => this.loadTopbarContext(), 30000);
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
    this.contextSub?.unsubscribe();
    this.contextSub = null;
  }

  private todayString(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}
