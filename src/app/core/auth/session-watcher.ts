import { Injectable, NgZone, inject } from '@angular/core';
import {
  EventTypes,
  OidcSecurityService,
  PublicEventsService,
} from 'angular-auth-oidc-client';
import {
  Observable,
  Subject,
  catchError,
  filter,
  finalize,
  of,
  shareReplay,
  take,
  tap,
  throwError,
} from 'rxjs';
import { decodeJwt } from './jwt';

// Mobile browsers (iOS Safari + Chrome on iOS/Android) and desktop browsers
// with backgrounded tabs aggressively throttle or freeze JS timers. The
// angular-auth-oidc-client silent-renew is a single setTimeout keyed off
// "expires_at - 90s" — when the tab isn't visible at that moment, the timer
// never fires, the access token rots, and the next API call 401s. By the time
// the user notices they've been "logged out" and the cached isAuthenticated
// state has flipped to false, the only recovery the app offers is /login.
//
// SessionWatcher closes that gap:
//   1. On visibilitychange/focus/pageshow, if the tab has been hidden for
//      more than HIDDEN_THRESHOLD_MS, force a refresh.
//   2. Every HEARTBEAT_MS while visible, if the access token has less than
//      LOW_FUEL_MS remaining, force a refresh. Belt + suspenders against
//      the library's single-timer renew getting throttled away even on a
//      visible tab.
//   3. On TokenExpired / SilentRenewFailed, force a refresh once.
//   4. Exposes refreshOnce() so the auth interceptor can share the same
//      in-flight refresh observable when retrying a 401 — concurrent 401s
//      across N parallel API calls collapse to one /oauth2/token round trip.
@Injectable({ providedIn: 'root' })
export class SessionWatcher {
  private oidc = inject(OidcSecurityService);
  private events = inject(PublicEventsService);
  private zone = inject(NgZone);

  private refresh$: Observable<unknown> | null = null;
  private hiddenSinceMs = 0;
  private lastRefreshAtMs = 0;
  private started = false;

  private readonly HIDDEN_THRESHOLD_MS = 60_000; // 1 min
  private readonly REFRESH_DEBOUNCE_MS = 30_000; // 30 s
  private readonly HEARTBEAT_MS = 4 * 60_000; // 4 min
  private readonly LOW_FUEL_MS = 2 * 60_000; // 2 min

  // Test seam — emits whenever a refresh is triggered.
  readonly refreshed$ = new Subject<'visibility' | 'focus' | 'heartbeat' | 'event' | 'interceptor'>();

  start(): void {
    if (this.started) return;
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    this.started = true;

    // Run listeners outside Angular's zone — these fire on every tab switch
    // and we don't want to wake change detection unless an actual refresh
    // succeeds (the OIDC service already runs inside the zone).
    this.zone.runOutsideAngular(() => {
      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('focus', this.onFocus);
      window.addEventListener('pageshow', this.onPageShow as EventListener);
      setInterval(() => this.tickHeartbeat(), this.HEARTBEAT_MS);
    });

    this.events
      .registerForEvents()
      .pipe(
        filter(
          (evt) =>
            evt?.type === EventTypes.TokenExpired ||
            evt?.type === EventTypes.SilentRenewFailed
        )
      )
      .subscribe(() => {
        this.refreshOnce('event').subscribe({ error: () => undefined });
      });
  }

  /**
   * Shared in-flight refresh observable. Subscribing while a refresh is in
   * flight returns the same observable (via shareReplay). Subscribing within
   * REFRESH_DEBOUNCE_MS of a successful refresh is a no-op (returns of(null))
   * — used to coalesce visibility + focus + pageshow firing back-to-back.
   */
  refreshOnce(
    source: 'visibility' | 'focus' | 'heartbeat' | 'event' | 'interceptor' = 'event'
  ): Observable<unknown> {
    if (this.refresh$) return this.refresh$;
    if (Date.now() - this.lastRefreshAtMs < this.REFRESH_DEBOUNCE_MS) {
      return of(null);
    }

    this.refresh$ = this.oidc.forceRefreshSession().pipe(
      tap({
        next: () => {
          this.lastRefreshAtMs = Date.now();
          this.refreshed$.next(source);
        },
      }),
      catchError((err) => throwError(() => err)),
      finalize(() => {
        this.refresh$ = null;
      }),
      shareReplay(1)
    );
    return this.refresh$;
  }

  private onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      this.hiddenSinceMs = Date.now();
      return;
    }
    if (document.visibilityState === 'visible') {
      const hiddenForMs = this.hiddenSinceMs ? Date.now() - this.hiddenSinceMs : 0;
      this.hiddenSinceMs = 0;
      if (hiddenForMs >= this.HIDDEN_THRESHOLD_MS) {
        this.refreshOnce('visibility').subscribe({ error: () => undefined });
      }
    }
  };

  private onFocus = (): void => {
    if (!this.hiddenSinceMs) return;
    const hiddenForMs = Date.now() - this.hiddenSinceMs;
    this.hiddenSinceMs = 0;
    if (hiddenForMs >= this.HIDDEN_THRESHOLD_MS) {
      this.refreshOnce('focus').subscribe({ error: () => undefined });
    }
  };

  private onPageShow = (e: PageTransitionEvent): void => {
    // BFCache restore — Safari aggressively bfcaches. The page resumes with
    // whatever in-memory state it had on suspend, including a stale renew
    // timer. Force a refresh to re-anchor expiry math.
    if (e?.persisted) {
      this.refreshOnce('visibility').subscribe({ error: () => undefined });
    }
  };

  private tickHeartbeat(): void {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return;
    }
    this.oidc.isAuthenticated$.pipe(take(1)).subscribe(({ isAuthenticated }) => {
      if (!isAuthenticated) return;
      this.oidc.getAccessToken().pipe(take(1)).subscribe((token) => {
        const exp = readExp(token);
        if (!exp) return;
        const remainingMs = exp * 1000 - Date.now();
        if (remainingMs < this.LOW_FUEL_MS) {
          this.refreshOnce('heartbeat').subscribe({ error: () => undefined });
        }
      });
    });
  }
}

function readExp(token: string | null | undefined): number | null {
  const claims = decodeJwt(token);
  if (!claims) return null;
  const exp = claims['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
}
