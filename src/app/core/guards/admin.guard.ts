import { inject } from '@angular/core';
import { CanMatchFn, Router, UrlSegment } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { map, switchMap, take } from 'rxjs/operators';
import { of } from 'rxjs';

export const adminGuard: CanMatchFn = (_route, segments: UrlSegment[]) => {
  const oidc = inject(OidcSecurityService);
  const router = inject(Router);

  console.log('[adminGuard] check', segments.map(s => s.path).join('/'));

  // ✅ Force auth initialization before deciding
  return oidc.checkAuth().pipe(
    take(1),
    switchMap(({ isAuthenticated }) => {
      console.log('[adminGuard] checkAuth isAuthenticated =', isAuthenticated);

      if (!isAuthenticated) {
        console.log('[adminGuard] -> /home (not logged in)');
        return of(router.createUrlTree(['/unauthorized']));
      }

      // ✅ Use ID token for groups (often most reliable for Cognito groups)
      return oidc.getIdToken().pipe(
        take(1),
        map((token) => {
          const payload = decodeJwt(token);
          const groups: string[] = payload?.['cognito:groups'] ?? [];
          const isAdmin = groups.includes('Admin');

          console.log('[adminGuard] groups =', groups, 'isAdmin =', isAdmin);

          return isAdmin
            ? true
            : router.createUrlTree(['/unauthorized']);
        })
      );
    })
  );
};

function decodeJwt(token: string | null | undefined): any {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(payload);
}
