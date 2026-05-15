import { Injectable, inject } from '@angular/core';
import {
  HttpErrorResponse,
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from '@angular/common/http';
import { Observable, catchError, throwError } from 'rxjs';
import { APP_CONFIG } from '../config/app-config';
import { TelemetryService } from './telemetry.service';

// Diagnostic-only interceptor (Phase 0 of the auth-resilience audit, 2026-05-14).
// The OIDC library wraps the underlying HttpErrorResponse in `new Error(error)`
// before our SessionWatcher catchError runs, which destroys the status code +
// the Cognito error_description. This interceptor sits in front of the library's
// own DataService and captures the raw token-endpoint response so we can see
// exactly what Cognito is returning when refresh fails (invalid_grant, 5xx,
// network, etc.). No behavior change — failed requests still propagate.
@Injectable()
export class CognitoDebugInterceptor implements HttpInterceptor {
  private telemetry = inject(TelemetryService);

  intercept(
    req: HttpRequest<unknown>,
    next: HttpHandler
  ): Observable<HttpEvent<unknown>> {
    if (!isCognitoTokenRequest(req.url)) return next.handle(req);

    const startedAt = Date.now();
    return next.handle(req).pipe(
      catchError((err: unknown) => {
        if (err instanceof HttpErrorResponse) {
          this.telemetry.fire('auth_cognito_token_error', {
            extra: {
              status: err.status,
              errorCode: readErrorCode(err.error),
              errorDescription: readErrorDescription(err.error),
              elapsedMs: Date.now() - startedAt,
              grantType: readGrantType(req.body),
            },
          });
        }
        return throwError(() => err);
      })
    );
  }
}

function isCognitoTokenRequest(url: string): boolean {
  if (!url) return false;
  const hostedUi = APP_CONFIG.cognito.hostedUiDomain.replace(/\/$/, '');
  return (
    url.startsWith(`${hostedUi}/oauth2/token`) ||
    url.includes('.amazoncognito.com/oauth2/token')
  );
}

function readErrorCode(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const e = (body as Record<string, unknown>)['error'];
    return typeof e === 'string' && e.length > 0 ? e : null;
  }
  if (typeof body === 'string' && body.length > 0) {
    try {
      const parsed = JSON.parse(body);
      const e = parsed?.['error'];
      return typeof e === 'string' && e.length > 0 ? e : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readErrorDescription(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const d = (body as Record<string, unknown>)['error_description'];
    return typeof d === 'string' && d.length > 0 ? d : null;
  }
  if (typeof body === 'string' && body.length > 0) {
    try {
      const parsed = JSON.parse(body);
      const d = parsed?.['error_description'];
      return typeof d === 'string' && d.length > 0 ? d : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readGrantType(body: unknown): string | null {
  if (!body) return null;
  // /oauth2/token bodies are application/x-www-form-urlencoded — typically
  // a string or URLSearchParams. We don't want to log the refresh_token
  // value, just the grant_type so we can distinguish refresh vs code flow.
  if (typeof body === 'string') {
    return matchGrantType(body);
  }
  if (body instanceof URLSearchParams) {
    const g = body.get('grant_type');
    return typeof g === 'string' && g.length > 0 ? g : null;
  }
  return null;
}

function matchGrantType(raw: string): string | null {
  const m = /(?:^|&)grant_type=([^&]+)/.exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}
