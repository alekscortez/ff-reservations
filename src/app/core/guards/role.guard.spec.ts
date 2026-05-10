import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { Observable, lastValueFrom, of } from 'rxjs';

import { roleGuard } from './role.guard';
import { adminGuard } from './admin.guard';
import { AuthService } from '../auth/auth.service';

function provideAuth(groups: string[] | Observable<string[]>) {
  const groups$ = Array.isArray(groups) ? of(groups) : groups;
  return {
    provide: AuthService,
    useValue: { groups$: () => groups$ },
  };
}

async function runGuard(guard: ReturnType<typeof roleGuard>): Promise<boolean | UrlTree> {
  const result = TestBed.runInInjectionContext(() => guard(null as any, []));
  return lastValueFrom(result as Observable<boolean | UrlTree>);
}

describe('roleGuard', () => {
  it('returns true when the user has any allowed group', async () => {
    TestBed.configureTestingModule({ providers: [provideAuth(['Staff'])] });
    const result = await runGuard(roleGuard(['Staff']));
    expect(result).toBe(true);
  });

  it('returns true when ANY of multiple allowed groups matches', async () => {
    TestBed.configureTestingModule({ providers: [provideAuth(['Staff'])] });
    const result = await runGuard(roleGuard(['Admin', 'Staff']));
    expect(result).toBe(true);
  });

  it('returns a UrlTree to /unauthorized when no allowed group matches', async () => {
    TestBed.configureTestingModule({ providers: [provideAuth(['Staff'])] });
    const result = await runGuard(roleGuard(['Admin']));
    expect(result).not.toBe(true);
    expect(result instanceof UrlTree).toBe(true);
    const router = TestBed.inject(Router);
    expect(router.serializeUrl(result as UrlTree)).toBe('/unauthorized');
  });

  it('returns UrlTree when groups list is empty (default-deny)', async () => {
    TestBed.configureTestingModule({ providers: [provideAuth([])] });
    const result = await runGuard(roleGuard(['Admin']));
    expect(result instanceof UrlTree).toBe(true);
  });

  it('returns UrlTree when allowed list is empty (no role can ever pass)', async () => {
    TestBed.configureTestingModule({ providers: [provideAuth(['Admin', 'Staff'])] });
    const result = await runGuard(roleGuard([]));
    // .some() over an empty array is always false, so guard rejects.
    expect(result instanceof UrlTree).toBe(true);
  });

  it('takes only the first emission (take(1)) — does not hang on hot streams', async () => {
    let emissionCount = 0;
    const stream = new Observable<string[]>((sub) => {
      emissionCount += 1;
      sub.next(['Admin']);
      sub.next([]); // would flip the verdict if not for take(1)
      // intentionally never completes
    });
    TestBed.configureTestingModule({ providers: [provideAuth(stream)] });
    const result = await runGuard(roleGuard(['Admin']));
    expect(result).toBe(true);
    expect(emissionCount).toBe(1);
  });
});

describe('adminGuard', () => {
  it('is roleGuard(["Admin"]) — passes for Admin only', async () => {
    TestBed.configureTestingModule({ providers: [provideAuth(['Admin'])] });
    expect(await runGuard(adminGuard)).toBe(true);
  });

  it('rejects Staff (UrlTree to /unauthorized)', async () => {
    TestBed.configureTestingModule({ providers: [provideAuth(['Staff'])] });
    const result = await runGuard(adminGuard);
    expect(result instanceof UrlTree).toBe(true);
    const router = TestBed.inject(Router);
    expect(router.serializeUrl(result as UrlTree)).toBe('/unauthorized');
  });

  it('rejects users with no groups', async () => {
    TestBed.configureTestingModule({ providers: [provideAuth([])] });
    const result = await runGuard(adminGuard);
    expect(result instanceof UrlTree).toBe(true);
  });
});
