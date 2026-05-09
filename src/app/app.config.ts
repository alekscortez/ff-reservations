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
import { provideAuth, OidcSecurityService } from 'angular-auth-oidc-client';
import { AuthInterceptor } from './core/http/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true, runCoalescing: true }),
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptorsFromDi()),
    provideAuth(authConfig),
    { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
    provideAppInitializer(() => {
      const oidc = inject(OidcSecurityService);
      return new Promise<void>((resolve, reject) => {
        oidc.checkAuth().subscribe({
          error: (e) => reject(e),
          complete: () => resolve(),
        });
      });
    }),
  ],
};
