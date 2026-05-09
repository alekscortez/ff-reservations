import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { map, take } from 'rxjs/operators';

export const authGuard: CanMatchFn = () => {
  const oidc = inject(OidcSecurityService);
  const router = inject(Router);

  return oidc.checkAuth().pipe(
    take(1),
    map(({ isAuthenticated }) =>
      isAuthenticated ? true : router.createUrlTree(['/login'])
    )
  );
};
