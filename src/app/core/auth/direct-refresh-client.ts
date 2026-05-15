import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  Observable,
  catchError,
  retry,
  tap,
  throwError,
  timer,
} from 'rxjs';
import { APP_CONFIG } from '../config/app-config';
import { TelemetryService } from '../http/telemetry.service';

export interface CognitoTokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

const TRANSIENT_DELAYS_MS = [400, 1500, 5000];

// Phase 1: bypasses angular-auth-oidc-client for refresh. Posts directly to
// Cognito's /oauth2/token with our own retry policy on transient errors
// (status 0 / 5xx) and definitive failure on 4xx. The library's behavior
// of nuking auth state on any failure makes it unsuitable for transient
// recovery; we own the call instead.
//
// After a successful refresh, the caller (SessionWatcher or bootstrap)
// MUST write the new tokens back into the library's storage AND call
// oidc.checkAuth() so the library's in-memory auth state re-syncs from
// disk. That's done in LibraryStorageBridge to keep concerns separate.
@Injectable({ providedIn: 'root' })
export class DirectRefreshClient {
  private http = inject(HttpClient);
  private telemetry = inject(TelemetryService);

  private readonly endpoint = `${APP_CONFIG.cognito.hostedUiDomain}/oauth2/token`;
  private readonly clientId = APP_CONFIG.cognito.clientId;

  /**
   * Exchange a refresh token for fresh access/id tokens. Retries up to 3
   * times on transient HTTP errors (status 0 / 5xx). On 4xx, the refresh
   * token is genuinely dead — propagates the error so the caller can
   * trigger session-expired UX.
   */
  refresh(refreshToken: string): Observable<CognitoTokenResponse> {
    if (!refreshToken) {
      return throwError(() => new Error('no refresh token supplied'));
    }
    const startedAt = Date.now();
    let attempts = 0;

    this.telemetry.fire('auth_shadow_refresh_started', {
      extra: { source: 'direct' },
    });

    return this.attempt(refreshToken).pipe(
      retry({
        count: TRANSIENT_DELAYS_MS.length - 1,
        delay: (err: unknown, retryCount) => {
          attempts = retryCount;
          if (!isTransient(err)) return throwError(() => err);
          return timer(TRANSIENT_DELAYS_MS[retryCount] ?? 5000);
        },
      }),
      tap(() => {
        this.telemetry.fire('auth_shadow_refresh_succeeded', {
          extra: {
            elapsedMs: Date.now() - startedAt,
            attempts: attempts + 1,
          },
        });
      }),
      catchError((err: unknown) => {
        const httpErr = err instanceof HttpErrorResponse ? err : null;
        this.telemetry.fire('auth_shadow_refresh_failed', {
          extra: {
            elapsedMs: Date.now() - startedAt,
            attempts: attempts + 1,
            status: httpErr?.status ?? null,
            errorCode: readErrorCode(httpErr?.error) ?? null,
            errorDescription: readErrorDescription(httpErr?.error) ?? null,
          },
        });
        return throwError(() => err);
      })
    );
  }

  private attempt(refreshToken: string): Observable<CognitoTokenResponse> {
    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('client_id', this.clientId);
    body.set('refresh_token', refreshToken);

    return this.http.post<CognitoTokenResponse>(this.endpoint, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof HttpErrorResponse)) return false;
  return err.status === 0 || (err.status >= 500 && err.status < 600);
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
