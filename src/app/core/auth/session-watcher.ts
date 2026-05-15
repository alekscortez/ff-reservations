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
  from,
  of,
  shareReplay,
  switchMap,
  take,
  tap,
  throwError,
} from 'rxjs';
import { decodeJwt } from './jwt';
import { TelemetryService } from '../http/telemetry.service';
import { RefreshTokenVault } from './refresh-token-vault';
import { DirectRefreshClient } from './direct-refresh-client';
import { LibraryStorageBridge } from './library-storage-bridge';

export type RefreshSource =
  | 'visibility'
  | 'focus'
  | 'heartbeat'
  | 'event'
  | 'interceptor'
  | 'bootstrap';

// Mobile browsers (iOS Safari + Chrome on iOS/Android) and desktop browsers
// with backgrounded tabs aggressively throttle or freeze JS timers. The
// angular-auth-oidc-client silent-renew is a single setTimeout keyed off
// "expires_at - 90s" — when the tab isn't visible at that moment, the timer
// never fires, the access token rots, and the next API call 401s.
//
// Worse: when the library's renew DOES fire and fails (any reason — Cognito
// 4xx, network blip, internal validation error), it calls
// `resetAuthorizationData()` which WIPES the refresh token from storage.
// All subsequent renews then throw "no refresh token found" synchronously,
// with no HTTP call and no recovery.
//
// Phase 1 fix: replace `oidc.forceRefreshSession()` with a direct call to
// Cognito's /oauth2/token that retries transients and never wipes the
// refresh token on failure. We read the refresh token from our shadow
// vault (or the library's storage as fallback), POST to Cognito, write
// new tokens back into the library's storage, then call `oidc.checkAuth()`
// so the library's in-memory `isAuthenticated$` re-syncs. The shadow vault
// + storage bridge persist across library wipes, so a failed renew never
// cascades into a permanent logout.
@Injectable({ providedIn: 'root' })
export class SessionWatcher {
  private oidc = inject(OidcSecurityService);
  private events = inject(PublicEventsService);
  private zone = inject(NgZone);
  private telemetry = inject(TelemetryService);
  private vault = inject(RefreshTokenVault);
  private direct = inject(DirectRefreshClient);
  private storageBridge = inject(LibraryStorageBridge);

  private refresh$: Observable<unknown> | null = null;
  private hiddenSinceMs = 0;
  private lastRefreshAtMs = 0;
  private started = false;

  private readonly HIDDEN_THRESHOLD_MS = 60_000; // 1 min
  private readonly REFRESH_DEBOUNCE_MS = 30_000; // 30 s
  private readonly HEARTBEAT_MS = 4 * 60_000; // 4 min
  private readonly LOW_FUEL_MS = 2 * 60_000; // 2 min
  // 30 days — matches Cognito staff app client RefreshTokenValidity.
  private readonly RT_TTL_SEC = 30 * 24 * 60 * 60;

  // Test seam — emits whenever a refresh is triggered.
  readonly refreshed$ = new Subject<RefreshSource>();

  start(): void {
    if (this.started) return;
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    this.started = true;

    // Make sure the vault starts capturing library refresh tokens.
    this.vault.start();

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
  refreshOnce(source: RefreshSource = 'event'): Observable<unknown> {
    if (this.refresh$) return this.refresh$;
    if (Date.now() - this.lastRefreshAtMs < this.REFRESH_DEBOUNCE_MS) {
      return of(null);
    }

    const startedAt = Date.now();
    this.telemetry.fire('auth_renew_started', { extra: { source } });

    this.refresh$ = this.runDirectRefresh().pipe(
      tap({
        next: () => {
          this.lastRefreshAtMs = Date.now();
          this.refreshed$.next(source);
          this.telemetry.fire('auth_renew_succeeded', {
            extra: { source, elapsedMs: Date.now() - startedAt },
          });
        },
      }),
      catchError((err) => {
        this.telemetry.fire('auth_renew_failed', {
          extra: {
            source,
            elapsedMs: Date.now() - startedAt,
            status: (err as { status?: number })?.status ?? null,
            kind: errKind(err),
            reason: (err as { ffReason?: string })?.ffReason ?? null,
          },
        });
        return throwError(() => err);
      }),
      finalize(() => {
        this.refresh$ = null;
      }),
      shareReplay(1)
    );
    return this.refresh$;
  }

  /**
   * The actual refresh chain. Read refresh token → POST to Cognito →
   * write tokens back into library storage → trigger oidc.checkAuth()
   * so isAuthenticated$ updates.
   */
  private runDirectRefresh(): Observable<unknown> {
    const refreshToken = this.readRefreshToken();
    if (!refreshToken) {
      const err = new Error('no refresh token available') as Error & {
        ffReason: string;
      };
      err.ffReason = 'no_refresh_token';
      return throwError(() => err);
    }
    return this.direct.refresh(refreshToken).pipe(
      tap((resp) => {
        this.storageBridge.applyTokenResponse(resp);
        const newRefreshToken = resp.refresh_token ?? refreshToken;
        this.vault.write(
          newRefreshToken,
          Math.floor(Date.now() / 1000) + this.RT_TTL_SEC
        );
      }),
      // Re-run the library's checkAuth so its in-memory auth state catches
      // up with the tokens we just wrote. Without this, `isAuthenticated$`
      // would stay false even though storage has fresh tokens.
      switchMap(() => from(this.oidc.checkAuth()))
    );
  }

  private readRefreshToken(): string | null {
    const vaultEntry = this.vault.read();
    if (vaultEntry?.refreshToken) return vaultEntry.refreshToken;
    return this.storageBridge.readRefreshToken();
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

function errKind(err: unknown): string {
  if (!err || typeof err !== 'object') return typeof err;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' && name ? name : 'Error';
}
