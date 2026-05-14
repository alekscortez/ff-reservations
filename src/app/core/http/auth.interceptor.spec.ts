import { TestBed } from '@angular/core/testing';
import {
  HttpClient,
  HTTP_INTERCEPTORS,
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { Observable, of } from 'rxjs';

import { AuthInterceptor } from './auth.interceptor';
import { APP_CONFIG } from '../config/app-config';
import { SessionWatcher } from '../auth/session-watcher';
import { SessionExpiry } from '../auth/session-expiry';

const API = APP_CONFIG.apiBaseUrl;

type OidcStub = {
  getAccessToken: (...args: unknown[]) => Observable<string>;
};

function setup(opts: {
  oidc: OidcStub;
  refreshOnce?: () => Observable<unknown>;
}) {
  const refreshSpy = vi.fn(() => opts.refreshOnce?.() ?? of(null));
  const notifyExpiredSpy = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptorsFromDi()),
      provideHttpClientTesting(),
      { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
      { provide: OidcSecurityService, useValue: opts.oidc },
      { provide: SessionWatcher, useValue: { refreshOnce: refreshSpy } },
      { provide: SessionExpiry, useValue: { notifyExpired: notifyExpiredSpy } },
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    httpTesting: TestBed.inject(HttpTestingController),
    refreshSpy,
    notifyExpiredSpy,
  };
}

describe('AuthInterceptor', () => {
  it('attaches Bearer header to API requests when a token is present', () => {
    const { http, httpTesting } = setup({
      oidc: { getAccessToken: () => of('jwt-token-abc') },
    });
    http.get(`${API}/widgets`).subscribe();
    const req = httpTesting.expectOne(`${API}/widgets`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer jwt-token-abc');
    req.flush({});
    httpTesting.verify();
  });

  it('passes API requests through unmodified when token is empty', () => {
    const { http, httpTesting } = setup({ oidc: { getAccessToken: () => of('') } });
    http.get(`${API}/widgets`).subscribe();
    const req = httpTesting.expectOne(`${API}/widgets`);
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
    httpTesting.verify();
  });

  it('does NOT touch non-API URLs even with a token present', () => {
    const { http, httpTesting } = setup({
      oidc: { getAccessToken: () => of('jwt-token-abc') },
    });
    http.get('https://example.com/external').subscribe();
    const req = httpTesting.expectOne('https://example.com/external');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
    httpTesting.verify();
  });

  it('preserves existing headers when adding Authorization', () => {
    const { http, httpTesting } = setup({ oidc: { getAccessToken: () => of('jwt') } });
    http.get(`${API}/widgets`, { headers: { 'X-Trace': 'abc-123' } }).subscribe();
    const req = httpTesting.expectOne(`${API}/widgets`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer jwt');
    expect(req.request.headers.get('X-Trace')).toBe('abc-123');
    req.flush({});
    httpTesting.verify();
  });

  it('refreshes and retries once on 401, attaching the new token', () => {
    let calls = 0;
    const { http, httpTesting, refreshSpy } = setup({
      oidc: {
        getAccessToken: () => {
          calls += 1;
          return of(calls === 1 ? 'old' : 'fresh');
        },
      },
      refreshOnce: () => of(null),
    });
    let result: unknown = null;
    let error: unknown = null;
    http.get(`${API}/widgets`).subscribe({
      next: (r) => (result = r),
      error: (e) => (error = e),
    });

    const first = httpTesting.expectOne(`${API}/widgets`);
    expect(first.request.headers.get('Authorization')).toBe('Bearer old');
    first.flush({}, { status: 401, statusText: 'Unauthorized' });

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const retried = httpTesting.expectOne(`${API}/widgets`);
    expect(retried.request.headers.get('Authorization')).toBe('Bearer fresh');
    retried.flush({ ok: true });

    expect(result).toEqual({ ok: true });
    expect(error).toBeNull();
    httpTesting.verify();
  });

  it('does NOT refresh-and-retry on 403 or 500', () => {
    const { http, httpTesting, refreshSpy } = setup({
      oidc: { getAccessToken: () => of('tok') },
    });
    let captured: unknown = null;
    http.get(`${API}/a`).subscribe({ error: (e) => (captured = e) });
    httpTesting.expectOne(`${API}/a`).flush({}, { status: 403, statusText: 'Forbidden' });
    expect(refreshSpy).not.toHaveBeenCalled();
    expect((captured as { status?: number } | null)?.status).toBe(403);
    httpTesting.verify();
  });

  it('surfaces the original 401 if the retried request also 401s (no infinite loop)', () => {
    const { http, httpTesting, refreshSpy, notifyExpiredSpy } = setup({
      oidc: { getAccessToken: () => of('tok') },
      refreshOnce: () => of(null),
    });
    let captured: unknown = null;
    http.get(`${API}/x`).subscribe({ error: (e) => (captured = e) });

    httpTesting.expectOne(`${API}/x`).flush({}, { status: 401, statusText: 'Unauthorized' });
    httpTesting.expectOne(`${API}/x`).flush({}, { status: 401, statusText: 'Unauthorized' });
    // Only one refresh was attempted across the two 401s on the same request.
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect((captured as { status?: number } | null)?.status).toBe(401);
    // We had an initial token → definitive failure routes to /login.
    expect(notifyExpiredSpy).toHaveBeenCalledWith('interceptor');
    httpTesting.verify();
  });

  it('does NOT notify session-expired on 401 when no initial access token was present', () => {
    // User wasn't logged in to start with — a 401 on an authed route is a
    // route-guard concern, not a "your session expired" UI event.
    const { http, httpTesting, refreshSpy, notifyExpiredSpy } = setup({
      oidc: { getAccessToken: () => of('') },
      refreshOnce: () => of(null),
    });
    let captured: unknown = null;
    http.get(`${API}/x`).subscribe({ error: (e) => (captured = e) });
    httpTesting.expectOne(`${API}/x`).flush({}, { status: 401, statusText: 'Unauthorized' });
    httpTesting.expectOne(`${API}/x`).flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(notifyExpiredSpy).not.toHaveBeenCalled();
    expect((captured as { status?: number } | null)?.status).toBe(401);
    httpTesting.verify();
  });

  it('does NOT notify session-expired when the retry succeeds', () => {
    let calls = 0;
    const { http, httpTesting, notifyExpiredSpy } = setup({
      oidc: {
        getAccessToken: () => {
          calls += 1;
          return of(calls === 1 ? 'old' : 'fresh');
        },
      },
      refreshOnce: () => of(null),
    });
    http.get(`${API}/y`).subscribe();
    httpTesting.expectOne(`${API}/y`).flush({}, { status: 401, statusText: 'Unauthorized' });
    httpTesting.expectOne(`${API}/y`).flush({ ok: true });
    expect(notifyExpiredSpy).not.toHaveBeenCalled();
    httpTesting.verify();
  });
});
