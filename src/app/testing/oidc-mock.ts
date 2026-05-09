import { Provider } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { of } from 'rxjs';

export function provideMockOidc(): Provider {
  const stub = {
    isAuthenticated$: of({ isAuthenticated: false, allConfigsAuthenticated: [] }),
    userData$: of({ userData: null, allUserData: [] }),
    checkAuth: () => of({ isAuthenticated: false, userData: null }),
    getAccessToken: () => of(''),
    getIdToken: () => of(''),
    getAuthenticationResult: () => of(null),
    authorize: () => undefined,
    logoff: () => of(null),
    logoffLocal: () => undefined,
  };
  return { provide: OidcSecurityService, useValue: stub };
}
