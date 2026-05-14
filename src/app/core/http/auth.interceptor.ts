import { Injectable, inject } from '@angular/core';
import {
  HttpErrorResponse,
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from '@angular/common/http';
import { Observable, catchError, switchMap, take, throwError } from 'rxjs';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { APP_CONFIG } from '../config/app-config';
import { SessionWatcher } from '../auth/session-watcher';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  private oidc = inject(OidcSecurityService);
  private watcher = inject(SessionWatcher);

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    const isApi = req.url.startsWith(APP_CONFIG.apiBaseUrl);
    if (!isApi) return next.handle(req);

    return this.oidc.getAccessToken().pipe(
      take(1),
      switchMap((token) => {
        const first = next.handle(this.attach(req, token));
        return first.pipe(
          catchError((err: unknown) => {
            if (!(err instanceof HttpErrorResponse) || err.status !== 401) {
              return throwError(() => err);
            }
            // 401 on an API call: try one refresh + retry. Coalesced via
            // SessionWatcher so N concurrent 401s share one /oauth2/token
            // round-trip. On a second 401 we surface the original error —
            // the new token still wasn't accepted, so it's not a freshness
            // issue and the user likely needs to re-auth.
            return this.watcher.refreshOnce('interceptor').pipe(
              switchMap(() => this.oidc.getAccessToken().pipe(take(1))),
              switchMap((newToken) => next.handle(this.attach(req, newToken))),
              catchError(() => throwError(() => err))
            );
          })
        );
      })
    );
  }

  private attach(req: HttpRequest<unknown>, token: string | null): HttpRequest<unknown> {
    if (!token) return req;
    return req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }
}
