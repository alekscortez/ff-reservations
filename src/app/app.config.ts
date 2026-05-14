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
import { retry, throwError, timer } from 'rxjs';
import { AuthInterceptor } from './core/http/auth.interceptor';
import { SessionWatcher } from './core/auth/session-watcher';
import { TelemetryService } from './core/http/telemetry.service';

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
      const watcher = inject(SessionWatcher);
      const telemetry = inject(TelemetryService);
      // Always resolve so a flaky OIDC discovery call doesn't brick the
      // entire app boot. Worst case the user lands on /login, which is
      // exactly where authGuard would route them anyway.
      //
      // Retry once on a transient failure (network blip, Cognito 5xx,
      // captive-portal interstitial mid-resume) — a single transient miss
      // here is the difference between "stays signed in" and "back to
      // /login" on mobile resume.
      const startedAt = Date.now();
      let retried = false;
      return new Promise<void>((resolve) => {
        oidc
          .checkAuth()
          .pipe(
            retry({
              count: 1,
              delay: (err: unknown) => {
                const status = Number((err as { status?: number })?.status ?? 0);
                const transient = status === 0 || (status >= 500 && status < 600);
                if (transient) retried = true;
                return transient ? timer(400) : throwError(() => err);
              },
            })
          )
          .subscribe({
            error: (e) => {
              console.warn('oidc_checkauth_failed_at_bootstrap', e);
              telemetry.fire('auth_bootstrap_check', {
                extra: {
                  outcome: 'error',
                  retried,
                  elapsedMs: Date.now() - startedAt,
                  status: Number((e as { status?: number })?.status ?? 0) || null,
                },
              });
              watcher.start();
              resolve();
            },
            complete: () => {
              telemetry.fire('auth_bootstrap_check', {
                extra: {
                  outcome: retried ? 'recovered' : 'ok',
                  retried,
                  elapsedMs: Date.now() - startedAt,
                },
              });
              watcher.start();
              resolve();
            },
          });
      });
    }),
  ],
};
