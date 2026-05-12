import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideAppInitializer,
  provideZoneChangeDetection,
  inject,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import {
  HTTP_INTERCEPTORS,
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';

import { routes } from './app.routes';
import { authConfig } from './core/auth/auth.config';
import {
  provideAuth,
  OidcSecurityService,
  AbstractSecurityStorage,
  DefaultLocalStorageService,
} from 'angular-auth-oidc-client';
import { AuthInterceptor } from './core/http/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true, runCoalescing: true }),
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptorsFromDi()),
    provideAuth(authConfig),
    // Persist OIDC state (incl. the 30-day refresh token) in localStorage
    // instead of the library's default sessionStorage. sessionStorage is
    // cleared when the user closes the last tab/window for the origin, which
    // forced a fresh /login round-trip on every browser restart even though
    // the refresh token was nowhere near its TTL.
    { provide: AbstractSecurityStorage, useClass: DefaultLocalStorageService },
    { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
    provideAppInitializer(() => {
      const oidc = inject(OidcSecurityService);
      // Always resolve so a flaky OIDC discovery call doesn't brick the
      // entire app boot. Worst case the user lands on /login, which is
      // exactly where authGuard would route them anyway.
      return new Promise<void>((resolve) => {
        oidc.checkAuth().subscribe({
          error: (e) => {
            console.warn('oidc_checkauth_failed_at_bootstrap', e);
            resolve();
          },
          complete: () => resolve(),
        });
      });
    }),
  ],
};
