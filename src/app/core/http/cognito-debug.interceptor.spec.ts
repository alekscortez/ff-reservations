import { TestBed } from '@angular/core/testing';
import {
  HttpClient,
  HTTP_INTERCEPTORS,
  HttpErrorResponse,
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { CognitoDebugInterceptor } from './cognito-debug.interceptor';
import { TelemetryService } from './telemetry.service';
import { APP_CONFIG } from '../config/app-config';

const TOKEN_URL = `${APP_CONFIG.cognito.hostedUiDomain}/oauth2/token`;
const USERINFO_URL = `${APP_CONFIG.cognito.hostedUiDomain}/oauth2/userInfo`;
const JWKS_URL = `${APP_CONFIG.cognito.authority}/.well-known/jwks.json`;
const DISCOVERY_URL = `${APP_CONFIG.cognito.authority}/.well-known/openid-configuration`;

function setup() {
  const fireSpy = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptorsFromDi()),
      provideHttpClientTesting(),
      {
        provide: HTTP_INTERCEPTORS,
        useClass: CognitoDebugInterceptor,
        multi: true,
      },
      { provide: TelemetryService, useValue: { fire: fireSpy } },
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    httpTesting: TestBed.inject(HttpTestingController),
    fireSpy,
  };
}

describe('CognitoDebugInterceptor', () => {
  it('ignores non-Cognito requests', () => {
    const { http, httpTesting, fireSpy } = setup();
    http.get('https://api.famosofuego.com/widgets').subscribe({
      next: () => undefined,
      error: () => undefined,
    });
    const req = httpTesting.expectOne('https://api.famosofuego.com/widgets');
    req.flush({});
    expect(fireSpy).not.toHaveBeenCalled();
    httpTesting.verify();
  });

  it('fires auth_cognito_observed on successful /oauth2/token call', () => {
    const { http, httpTesting, fireSpy } = setup();
    http
      .post(TOKEN_URL, 'grant_type=refresh_token')
      .subscribe({ next: () => undefined, error: () => undefined });
    const req = httpTesting.expectOne(TOKEN_URL);
    req.flush({ access_token: 'abc', refresh_token: 'rt2' });
    expect(fireSpy).toHaveBeenCalledTimes(1);
    const [eventName, payload] = fireSpy.mock.calls[0];
    expect(eventName).toBe('auth_cognito_observed');
    expect(payload?.extra).toMatchObject({
      urlPath: '/oauth2/token',
      status: 200,
      method: 'POST',
    });
    expect(typeof payload?.extra?.elapsedMs).toBe('number');
  });

  it('fires auth_cognito_observed on successful /jwks.json fetch', () => {
    const { http, httpTesting, fireSpy } = setup();
    http.get(JWKS_URL).subscribe({ next: () => undefined });
    const req = httpTesting.expectOne(JWKS_URL);
    req.flush({ keys: [] });
    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy.mock.calls[0][0]).toBe('auth_cognito_observed');
    expect(fireSpy.mock.calls[0][1]?.extra?.urlPath).toContain('jwks.json');
    expect(fireSpy.mock.calls[0][1]?.extra?.method).toBe('GET');
  });

  it('fires auth_cognito_token_error on /oauth2/token error with full body', () => {
    const { http, httpTesting, fireSpy } = setup();
    const body = 'grant_type=refresh_token&client_id=abc&refresh_token=rt';
    http
      .post(TOKEN_URL, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      .subscribe({ error: () => undefined });
    const req = httpTesting.expectOne(TOKEN_URL);
    req.flush(
      { error: 'invalid_grant', error_description: 'Refresh Token has been revoked' },
      { status: 400, statusText: 'Bad Request' }
    );
    expect(fireSpy).toHaveBeenCalledTimes(1);
    const [eventName, payload] = fireSpy.mock.calls[0];
    expect(eventName).toBe('auth_cognito_token_error');
    expect(payload?.extra).toMatchObject({
      urlPath: '/oauth2/token',
      status: 400,
      errorCode: 'invalid_grant',
      errorDescription: 'Refresh Token has been revoked',
      grantType: 'refresh_token',
      method: 'POST',
    });
  });

  it('fires auth_cognito_token_error on /oauth2/userInfo 401', () => {
    const { http, httpTesting, fireSpy } = setup();
    http.get(USERINFO_URL).subscribe({ error: () => undefined });
    const req = httpTesting.expectOne(USERINFO_URL);
    req.flush('unauthorized', { status: 401, statusText: 'Unauthorized' });
    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy.mock.calls[0][0]).toBe('auth_cognito_token_error');
    expect(fireSpy.mock.calls[0][1]?.extra).toMatchObject({
      urlPath: '/oauth2/userInfo',
      status: 401,
      method: 'GET',
    });
  });

  it('fires for cognito-idp authority host (discovery doc)', () => {
    const { http, httpTesting, fireSpy } = setup();
    http.get(DISCOVERY_URL).subscribe({ error: () => undefined });
    const req = httpTesting.expectOne(DISCOVERY_URL);
    req.flush('boom', { status: 500, statusText: 'Server Error' });
    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy.mock.calls[0][0]).toBe('auth_cognito_token_error');
    expect(fireSpy.mock.calls[0][1]?.extra?.urlPath).toContain(
      'openid-configuration'
    );
    expect(fireSpy.mock.calls[0][1]?.extra?.status).toBe(500);
  });

  it('handles string-typed error bodies (gateway intermediaries)', () => {
    const { http, httpTesting, fireSpy } = setup();
    http
      .post(TOKEN_URL, 'grant_type=refresh_token')
      .subscribe({ error: () => undefined });
    const req = httpTesting.expectOne(TOKEN_URL);
    req.flush(JSON.stringify({ error: 'invalid_client' }), {
      status: 401,
      statusText: 'Unauthorized',
    });
    expect(fireSpy.mock.calls[0][1]?.extra?.errorCode).toBe('invalid_client');
  });

  it('rethrows the original HttpErrorResponse so callers still see it', () => {
    const { http, httpTesting, fireSpy } = setup();
    let captured: unknown = null;
    http.post(TOKEN_URL, 'grant_type=refresh_token').subscribe({
      error: (err) => (captured = err),
    });
    const req = httpTesting.expectOne(TOKEN_URL);
    req.flush(
      { error: 'invalid_grant' },
      { status: 400, statusText: 'Bad Request' }
    );
    expect(captured).toBeInstanceOf(HttpErrorResponse);
    expect((captured as HttpErrorResponse).status).toBe(400);
    expect(fireSpy).toHaveBeenCalled();
  });

  it('does not log refresh_token value (PII safety)', () => {
    const { http, httpTesting, fireSpy } = setup();
    http
      .post(
        TOKEN_URL,
        'grant_type=refresh_token&refresh_token=SUPER_SECRET_RT&client_id=abc'
      )
      .subscribe({ error: () => undefined });
    const req = httpTesting.expectOne(TOKEN_URL);
    req.flush({ error: 'invalid_grant' }, { status: 400, statusText: 'Bad' });
    const payload = JSON.stringify(fireSpy.mock.calls[0][1]);
    expect(payload).not.toContain('SUPER_SECRET_RT');
  });
});
