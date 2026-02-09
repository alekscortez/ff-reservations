import { Injectable, inject } from '@angular/core';
import {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from '@angular/common/http';
import { Observable, switchMap, take } from 'rxjs';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { APP_CONFIG } from '../config/app-config';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  private oidc = inject(OidcSecurityService);

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    const isApi = req.url.startsWith(APP_CONFIG.apiBaseUrl);
    if (!isApi) return next.handle(req);

    return this.oidc.getAccessToken().pipe(
      take(1),
      switchMap((token) => {
        if (!token) return next.handle(req);
        const authReq = req.clone({
          setHeaders: { Authorization: `Bearer ${token}` },
        });
        return next.handle(authReq);
      })
    );
  }
}
