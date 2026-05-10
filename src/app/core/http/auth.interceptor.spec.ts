import { TestBed } from '@angular/core/testing';
import { HttpClient, HTTP_INTERCEPTORS, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { of } from 'rxjs';

import { AuthInterceptor } from './auth.interceptor';
import { APP_CONFIG } from '../config/app-config';

const API = APP_CONFIG.apiBaseUrl;

function setup(token: string) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptorsFromDi()),
      provideHttpClientTesting(),
      { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
      {
        provide: OidcSecurityService,
        useValue: { getAccessToken: () => of(token) },
      },
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    httpTesting: TestBed.inject(HttpTestingController),
  };
}

describe('AuthInterceptor', () => {
  it('attaches Bearer header to API requests when a token is present', () => {
    const { http, httpTesting } = setup('jwt-token-abc');
    http.get(`${API}/widgets`).subscribe();
    const req = httpTesting.expectOne(`${API}/widgets`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer jwt-token-abc');
    req.flush({});
    httpTesting.verify();
  });

  it('passes API requests through unmodified when token is empty', () => {
    const { http, httpTesting } = setup('');
    http.get(`${API}/widgets`).subscribe();
    const req = httpTesting.expectOne(`${API}/widgets`);
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
    httpTesting.verify();
  });

  it('does NOT touch non-API URLs even with a token present', () => {
    const { http, httpTesting } = setup('jwt-token-abc');
    http.get('https://example.com/external').subscribe();
    const req = httpTesting.expectOne('https://example.com/external');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
    httpTesting.verify();
  });

  it('preserves existing headers when adding Authorization', () => {
    const { http, httpTesting } = setup('jwt');
    http
      .get(`${API}/widgets`, { headers: { 'X-Trace': 'abc-123' } })
      .subscribe();
    const req = httpTesting.expectOne(`${API}/widgets`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer jwt');
    expect(req.request.headers.get('X-Trace')).toBe('abc-123');
    req.flush({});
    httpTesting.verify();
  });

  it('does not retry getAccessToken (take(1)) — single subscription per request', () => {
    let calls = 0;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
        {
          provide: OidcSecurityService,
          useValue: {
            getAccessToken: () => {
              calls += 1;
              return of('tok');
            },
          },
        },
      ],
    });
    const http = TestBed.inject(HttpClient);
    const httpTesting = TestBed.inject(HttpTestingController);
    http.get(`${API}/x`).subscribe();
    httpTesting.expectOne(`${API}/x`).flush({});
    expect(calls).toBe(1);
    httpTesting.verify();
  });
});
