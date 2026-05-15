import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { Observable, lastValueFrom, of } from 'rxjs';

import { authGuard } from './auth.guard';
import { SessionExpiry } from '../auth/session-expiry';

// Build a Provider that overrides OidcSecurityService with whatever subset we
// need for the guard. The shared provideMockOidc() forces isAuthenticated:false,
// which we want to override per-test here.
function provideOidc(isAuthenticated: boolean) {
  return {
    provide: OidcSecurityService,
    useValue: {
      isAuthenticated$: of({
        isAuthenticated,
        allConfigsAuthenticated: [],
      }),
    },
  };
}

function setup(opts: { isAuthenticated: boolean; wasAuthedFlag?: boolean }) {
  // Reset the localStorage flag between tests so each starts from a known state.
  try {
    if (opts.wasAuthedFlag) localStorage.setItem('ff_authed', '1');
    else localStorage.removeItem('ff_authed');
  } catch {
    // jsdom may not have localStorage in odd setups.
  }
  const notifyExpiredSpy = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideOidc(opts.isAuthenticated),
      {
        provide: SessionExpiry,
        useValue: { notifyExpired: notifyExpiredSpy },
      },
    ],
  });
  return { notifyExpiredSpy };
}

async function runGuard(): Promise<boolean | UrlTree> {
  // CanMatchFn signature is (route, segments) — neither is read by authGuard.
  const result = TestBed.runInInjectionContext(() =>
    authGuard(null as any, [])
  );
  // authGuard always returns Observable<boolean | UrlTree>
  return lastValueFrom(result as Observable<boolean | UrlTree>);
}

describe('authGuard', () => {
  it('returns true when the user is authenticated and sets ff_authed flag', async () => {
    setup({ isAuthenticated: true });
    const result = await runGuard();
    expect(result).toBe(true);
    expect(localStorage.getItem('ff_authed')).toBe('1');
  });

  it('returns a plain UrlTree to /login when never authenticated', async () => {
    setup({ isAuthenticated: false, wasAuthedFlag: false });
    const result = await runGuard();
    expect(result).not.toBe(true);
    expect(result instanceof UrlTree).toBe(true);
    const router = TestBed.inject(Router);
    expect(router.serializeUrl(result as UrlTree)).toBe('/login');
  });

  it('returns /login?reason=session-expired AND fires SessionExpiry when ff_authed was set', async () => {
    const { notifyExpiredSpy } = setup({
      isAuthenticated: false,
      wasAuthedFlag: true,
    });
    const result = await runGuard();
    expect(notifyExpiredSpy).toHaveBeenCalledWith('guard', {
      skipNavigation: true,
    });
    expect(result instanceof UrlTree).toBe(true);
    const router = TestBed.inject(Router);
    expect(router.serializeUrl(result as UrlTree)).toBe(
      '/login?reason=session-expired'
    );
  });

  it('completes after one emission (take(1)) — does not subscribe to a hot stream forever', async () => {
    let emissionCount = 0;
    const provider = {
      provide: OidcSecurityService,
      useValue: {
        isAuthenticated$: new Observable<{ isAuthenticated: boolean }>((sub) => {
          emissionCount += 1;
          sub.next({ isAuthenticated: true });
          sub.next({ isAuthenticated: false }); // must be ignored
          // intentionally don't complete — guard must close itself via take(1)
        }),
      },
    };
    TestBed.configureTestingModule({
      providers: [
        provider,
        { provide: SessionExpiry, useValue: { notifyExpired: vi.fn() } },
      ],
    });
    const result = await runGuard();
    expect(result).toBe(true);
    expect(emissionCount).toBe(1);
  });
});
