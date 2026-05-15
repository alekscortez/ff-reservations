import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { map, take } from 'rxjs/operators';
import { SessionExpiry } from '../auth/session-expiry';

// localStorage flag used to distinguish "session expired" from "never
// logged in". Set when the guard sees isAuthenticated=true; cleared when
// SessionExpiry.notifyExpired() runs. Without it, the guard's silent
// `/login` redirect would never trigger the session-expired banner, so
// every library-state-wipe looked like a fresh visit to the user.
const AUTHED_FLAG_KEY = 'ff_authed';

function readAuthedFlag(): boolean {
  try {
    return window.localStorage.getItem(AUTHED_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAuthedFlag(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(AUTHED_FLAG_KEY, '1');
    else window.localStorage.removeItem(AUTHED_FLAG_KEY);
  } catch {
    // Storage unavailable — flag becomes a no-op; guard still works,
    // just without the session-expired UX on this device.
  }
}

// provideAppInitializer (app.config.ts) already runs checkAuth() during
// bootstrap, so subsequent navigations should read the cached isAuthenticated$
// state instead of re-issuing a fresh checkAuth() (network) per route match.
export const authGuard: CanMatchFn = () => {
  const oidc = inject(OidcSecurityService);
  const router = inject(Router);
  const expiry = inject(SessionExpiry);

  return oidc.isAuthenticated$.pipe(
    take(1),
    map(({ isAuthenticated }) => {
      if (isAuthenticated) {
        writeAuthedFlag(true);
        return true;
      }
      // Not authenticated. Distinguish "first visit" from "session expired".
      if (readAuthedFlag()) {
        // Fire the expired-session signal (telemetry + library cleanup),
        // suppressing its own router.navigate so the guard's UrlTree return
        // is the single canonical redirect.
        expiry.notifyExpired('guard', { skipNavigation: true });
        return router.createUrlTree(['/login'], {
          queryParams: { reason: 'session-expired' },
        });
      }
      return router.createUrlTree(['/login']);
    })
  );
};
