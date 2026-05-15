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
import { CognitoDebugInterceptor } from './core/http/cognito-debug.interceptor';
import { SessionWatcher } from './core/auth/session-watcher';
import { TelemetryService } from './core/http/telemetry.service';
import { RefreshTokenVault } from './core/auth/refresh-token-vault';
import { DirectRefreshClient } from './core/auth/direct-refresh-client';
import { LibraryStorageBridge } from './core/auth/library-storage-bridge';

// 30 days — matches Cognito staff app client RefreshTokenValidity.
const RT_TTL_SEC = 30 * 24 * 60 * 60;

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
    // Phase 0 diagnostic — observes Cognito /oauth2/token errors before the
    // OIDC library swallows the status code. Pass-through only; no behavior
    // change. Remove once we've collected the data we need.
    { provide: HTTP_INTERCEPTORS, useClass: CognitoDebugInterceptor, multi: true },
    provideAppInitializer(() => {
      const oidc = inject(OidcSecurityService);
      const watcher = inject(SessionWatcher);
      const telemetry = inject(TelemetryService);
      const vault = inject(RefreshTokenVault);
      const direct = inject(DirectRefreshClient);
      const storageBridge = inject(LibraryStorageBridge);
      // Always resolve so a flaky OIDC discovery call doesn't brick the
      // entire app boot. Worst case the user lands on /login, which is
      // exactly where authGuard would route them anyway.
      //
      // Phase 1 recovery: if checkAuth() concludes the user is not
      // authenticated (either via emission or thrown error) but the shadow
      // vault holds a refresh token, attempt a direct /oauth2/token call.
      // On success, write tokens into the library's storage and re-run
      // checkAuth so isAuthenticated$ flips to true without a /login hop.
      // This is the deploy-causes-logout fix: when a new bundle ships and
      // the library can't resume the session from its storage for whatever
      // reason, the shadow recovers it.
      const startedAt = Date.now();
      let retried = false;
      let lastResult: { isAuthenticated?: boolean } | null = null;

      return new Promise<void>((resolve) => {
        const finishBootstrap = (extra: Record<string, unknown>): void => {
          telemetry.fire('auth_bootstrap_check', { extra });
          watcher.start();
          resolve();
        };

        const attemptShadowRecovery = (
          baseExtras: Record<string, unknown>
        ): void => {
          if (!vault.hasFresh()) {
            finishBootstrap({ ...baseExtras, shadowRecovery: 'skipped_no_token' });
            return;
          }
          const entry = vault.read();
          if (!entry) {
            finishBootstrap({ ...baseExtras, shadowRecovery: 'skipped_no_token' });
            return;
          }
          const recoveryStart = Date.now();
          direct.refresh(entry.refreshToken).subscribe({
            next: (resp) => {
              storageBridge.applyTokenResponse(resp);
              const newRt = resp.refresh_token ?? entry.refreshToken;
              vault.write(newRt, Math.floor(Date.now() / 1000) + RT_TTL_SEC);
              // Re-run checkAuth so the library's in-memory auth state
              // re-syncs with the storage we just updated.
              oidc.checkAuth().subscribe({
                next: () => {
                  telemetry.fire('auth_shadow_restored', {
                    extra: { elapsedMs: Date.now() - recoveryStart },
                  });
                  finishBootstrap({
                    ...baseExtras,
                    shadowRecovery: 'succeeded',
                  });
                },
                error: () => {
                  finishBootstrap({
                    ...baseExtras,
                    shadowRecovery: 'checkauth_failed',
                  });
                },
              });
            },
            error: (e: unknown) => {
              // Direct refresh failed definitively. Clear the shadow so we
              // don't keep retrying a dead refresh token; user will land
              // at /login via authGuard.
              vault.clear();
              finishBootstrap({
                ...baseExtras,
                shadowRecovery: 'direct_refresh_failed',
                shadowStatus: Number((e as { status?: number })?.status ?? 0) || null,
              });
            },
          });
        };

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
            next: (result) => {
              lastResult = result as { isAuthenticated?: boolean };
            },
            error: (e) => {
              console.warn('oidc_checkauth_failed_at_bootstrap', e);
              attemptShadowRecovery({
                outcome: 'error',
                retried,
                elapsedMs: Date.now() - startedAt,
                status: Number((e as { status?: number })?.status ?? 0) || null,
              });
            },
            complete: () => {
              if (lastResult?.isAuthenticated) {
                finishBootstrap({
                  outcome: retried ? 'recovered' : 'ok',
                  retried,
                  elapsedMs: Date.now() - startedAt,
                });
                return;
              }
              attemptShadowRecovery({
                outcome: 'not_authed',
                retried,
                elapsedMs: Date.now() - startedAt,
              });
            },
          });
      });
    }),
  ],
};
