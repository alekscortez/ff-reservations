import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { map, take } from 'rxjs/operators';

// provideAppInitializer (app.config.ts) already runs checkAuth() during
// bootstrap, so subsequent navigations should read the cached isAuthenticated$
// state instead of re-issuing a fresh checkAuth() (network) per route match.
export const authGuard: CanMatchFn = () => {
  const oidc = inject(OidcSecurityService);
  const router = inject(Router);

  return oidc.isAuthenticated$.pipe(
    take(1),
    map(({ isAuthenticated }) =>
      isAuthenticated ? true : router.createUrlTree(['/login'])
    )
  );
};
