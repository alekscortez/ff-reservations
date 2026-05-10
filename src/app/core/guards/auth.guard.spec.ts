import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { Observable, lastValueFrom, of } from 'rxjs';

import { authGuard } from './auth.guard';

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

async function runGuard(): Promise<boolean | UrlTree> {
  // CanMatchFn signature is (route, segments) — neither is read by authGuard.
  const result = TestBed.runInInjectionContext(() =>
    authGuard(null as any, [])
  );
  // authGuard always returns Observable<boolean | UrlTree>
  return lastValueFrom(result as Observable<boolean | UrlTree>);
}

describe('authGuard', () => {
  it('returns true when the user is authenticated', async () => {
    TestBed.configureTestingModule({ providers: [provideOidc(true)] });
    const result = await runGuard();
    expect(result).toBe(true);
  });

  it('returns a UrlTree to /login when the user is not authenticated', async () => {
    TestBed.configureTestingModule({ providers: [provideOidc(false)] });
    const result = await runGuard();
    expect(result).not.toBe(true);
    expect(result instanceof UrlTree).toBe(true);
    // The exact path is what login.guard expects to consume.
    const router = TestBed.inject(Router);
    expect(router.serializeUrl(result as UrlTree)).toBe('/login');
  });

  it('completes after one emission (take(1)) — does not subscribe to a hot stream forever', async () => {
    // If take(1) were missing, an infinite Subject upstream would never
    // complete and lastValueFrom would hang. We model this with a stream
    // that emits twice; take(1) should pick the first value.
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
    TestBed.configureTestingModule({ providers: [provider] });
    const result = await runGuard();
    expect(result).toBe(true);
    expect(emissionCount).toBe(1);
  });
});
