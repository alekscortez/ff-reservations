import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router, provideRouter } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { filter, firstValueFrom } from 'rxjs';

import { SessionExpiry } from './session-expiry';
import { TelemetryService } from '../http/telemetry.service';

@Component({ standalone: true, template: '' })
class Blank {}

function setup() {
  const fireSpy = vi.fn();
  const logoffLocalSpy = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'login', component: Blank },
        { path: 'staff/dashboard', component: Blank },
        { path: '', redirectTo: '/staff/dashboard', pathMatch: 'full' },
      ]),
      {
        provide: OidcSecurityService,
        useValue: { logoffLocal: logoffLocalSpy },
      },
      { provide: TelemetryService, useValue: { fire: fireSpy } },
    ],
  });
  const expiry = TestBed.inject(SessionExpiry);
  const router = TestBed.inject(Router);
  return { expiry, router, fireSpy, logoffLocalSpy };
}

describe('SessionExpiry', () => {
  it('navigates to /login with reason=session-expired, clears OIDC state, fires telemetry', async () => {
    const { expiry, router, fireSpy, logoffLocalSpy } = setup();
    await router.navigateByUrl('/staff/dashboard');

    const arrived = firstValueFrom(
      router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
    );
    expiry.notifyExpired('interceptor');
    await arrived;

    expect(router.url).toBe('/login?reason=session-expired');
    expect(logoffLocalSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy).toHaveBeenCalledWith(
      'auth_session_expired_redirect',
      expect.objectContaining({ extra: expect.objectContaining({ reason: 'interceptor' }) })
    );
  });

  it('is idempotent — concurrent calls only navigate + fire once', async () => {
    const { expiry, router, fireSpy, logoffLocalSpy } = setup();
    await router.navigateByUrl('/staff/dashboard');

    expiry.notifyExpired('interceptor');
    expiry.notifyExpired('silent-renew-failed');
    expiry.notifyExpired('interceptor');

    expect(logoffLocalSpy).toHaveBeenCalledTimes(1);
    expect(
      fireSpy.mock.calls.filter((c) => c[0] === 'auth_session_expired_redirect')
        .length
    ).toBe(1);
  });

  it('reset() re-arms the notifier (e.g. after successful re-login)', async () => {
    const { expiry, router, fireSpy } = setup();
    await router.navigateByUrl('/staff/dashboard');

    expiry.notifyExpired('interceptor');
    expiry.reset();
    expiry.notifyExpired('silent-renew-failed');

    expect(
      fireSpy.mock.calls.filter((c) => c[0] === 'auth_session_expired_redirect')
        .length
    ).toBe(2);
  });
});
