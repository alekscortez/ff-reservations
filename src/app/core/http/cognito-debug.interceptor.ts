import { Injectable, inject } from '@angular/core';
import {
  HttpErrorResponse,
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { TelemetryService } from './telemetry.service';

// Diagnostic-only interceptor (Phase 0 of the auth-resilience audit, 2026-05-14).
// The OIDC library wraps the underlying HttpErrorResponse in `new Error(error)`
// before our SessionWatcher catchError runs, which destroys the status code +
// the Cognito error_description. This interceptor sits in front of the library's
// own DataService and captures the raw response on every request the library
// makes against Cognito — /oauth2/token, /.well-known/jwks.json, /oauth2/userInfo,
// the authority discovery doc — so we can see exactly which call is failing
// and why. No behavior change — both success and error responses propagate
// through unchanged.
//
// Two events:
//   - auth_cognito_observed → fires on success. Confirms the interceptor is
//     wired and lets us see which Cognito URLs the library actually hits.
//   - auth_cognito_token_error → fires on error. Includes status + the
//     Cognito error body (when JSON-parseable).
@Injectable()
export class CognitoDebugInterceptor implements HttpInterceptor {
  private telemetry = inject(TelemetryService);

  intercept(
    req: HttpRequest<unknown>,
    next: HttpHandler
  ): Observable<HttpEvent<unknown>> {
    if (!isCognitoRequest(req.url)) return next.handle(req);

    const startedAt = Date.now();
    const urlPath = extractPath(req.url);

    return next.handle(req).pipe(
      tap((evt) => {
        if (evt instanceof HttpResponse) {
          this.telemetry.fire('auth_cognito_observed', {
            extra: {
              urlPath,
              status: evt.status,
              elapsedMs: Date.now() - startedAt,
              method: req.method,
            },
          });
        }
      }),
      catchError((err: unknown) => {
        if (err instanceof HttpErrorResponse) {
          this.telemetry.fire('auth_cognito_token_error', {
            extra: {
              urlPath,
              status: err.status,
              errorCode: readErrorCode(err.error),
              errorDescription: readErrorDescription(err.error),
              elapsedMs: Date.now() - startedAt,
              grantType: readGrantType(req.body),
              method: req.method,
            },
          });
        }
        return throwError(() => err);
      })
    );
  }
}

// Matches every URL the angular-auth-oidc-client library calls against
// Cognito for the staff pool: the Hosted UI domain (*.amazoncognito.com)
// for /oauth2/token, /oauth2/userInfo, /oauth2/revoke; and the authority
// domain (cognito-idp.<region>.amazonaws.com) for the well-known discovery
// document and JWKS endpoint.
function isCognitoRequest(url: string): boolean {
  if (!url) return false;
  if (url.includes('.amazoncognito.com/')) return true;
  if (url.includes('cognito-idp.') && url.includes('.amazonaws.com/')) {
    return true;
  }
  return false;
}

// /oauth2/token, /us-east-1_xxx/.well-known/jwks.json, etc. Drops the
// host + query + fragment so the urlPath dimension on the telemetry side
// has a small, stable cardinality.
function extractPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // best-effort fallback for non-absolute URLs (shouldn't happen for
    // Cognito calls, but defensive).
    const stripped = url.replace(/^https?:\/\/[^/]+/, '');
    return stripped.split('?')[0].split('#')[0] || url;
  }
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
