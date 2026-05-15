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
      error: () => undefined,
    });
    const req = httpTesting.expectOne('https://api.famosofuego.com/widgets');
    req.flush('boom', { status: 500, statusText: 'Server Error' });
    expect(fireSpy).not.toHaveBeenCalled();
    httpTesting.verify();
  });

  it('fires telemetry on Cognito token-endpoint error with status + parsed body', () => {
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
      status: 400,
      errorCode: 'invalid_grant',
      errorDescription: 'Refresh Token has been revoked',
      grantType: 'refresh_token',
    });
    expect(typeof payload?.extra?.elapsedMs).toBe('number');
    httpTesting.verify();
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
    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy.mock.calls[0][1]?.extra?.errorCode).toBe('invalid_client');
  });

  it('does not fire telemetry on success', () => {
    const { http, httpTesting, fireSpy } = setup();
    http
      .post(TOKEN_URL, 'grant_type=refresh_token')
      .subscribe({ next: () => undefined, error: () => undefined });
    const req = httpTesting.expectOne(TOKEN_URL);
    req.flush({ access_token: 'abc', refresh_token: 'rt2' });
    expect(fireSpy).not.toHaveBeenCalled();
    httpTesting.verify();
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
