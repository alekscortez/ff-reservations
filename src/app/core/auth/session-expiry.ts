import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { TelemetryService } from '../http/telemetry.service';

// Coordinates the "session is definitively gone" UX: clears local OIDC
// state, fires telemetry, and routes to /login with a banner. Idempotent —
// repeat calls within the same SPA navigation are no-ops so concurrent
// 401s from N parallel requests don't stack-route or fire N events.
@Injectable({ providedIn: 'root' })
export class SessionExpiry {
  private oidc = inject(OidcSecurityService);
  private router = inject(Router);
  private telemetry = inject(TelemetryService);

  private notified = false;

  /**
   * Call when refresh + retry has definitively failed AND the user
   * previously had a valid session (i.e. don't fire this for "never
   * logged in" 401s on an authed route). Reason is logged for telemetry
   * triage.
   */
  notifyExpired(reason: 'interceptor' | 'silent-renew-failed'): void {
    if (this.notified) return;
    this.notified = true;

    this.telemetry.fire('auth_session_expired_redirect', {
      extra: { reason, from: this.currentPath() },
    });

    // Clear local OIDC state so the next bootstrap doesn't try to
    // re-use the stale (revoked / expired) tokens. logoffLocal does
    // not talk to Cognito — no network hop on this path.
    try {
      this.oidc.logoffLocal();
    } catch {
      // never let cleanup throw past the redirect.
    }

    if (this.currentPath() === '/login') {
      // Already there — no need to navigate; the message will surface
      // once Login reads the query param on the next load. We still
      // append the reason so a soft refresh shows the banner.
      this.router.navigate(['/login'], {
        queryParams: { reason: 'session-expired' },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
      return;
    }
    this.router.navigate(['/login'], {
      queryParams: { reason: 'session-expired' },
      replaceUrl: true,
    });
  }

  /** Reset notified-flag — e.g. after a successful new sign-in. */
  reset(): void {
    this.notified = false;
  }

  private currentPath(): string {
    const url = this.router.url || '/';
    return url.split('?')[0].split('#')[0] || '/';
  }
}
