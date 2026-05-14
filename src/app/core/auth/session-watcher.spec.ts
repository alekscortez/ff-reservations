import { TestBed } from '@angular/core/testing';
import {
  EventTypes,
  OidcSecurityService,
  PublicEventsService,
} from 'angular-auth-oidc-client';
import { Subject, of } from 'rxjs';
import { SessionWatcher } from './session-watcher';

function makeOidcStub(overrides: Partial<{
  forceRefreshSession: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    forceRefreshSession:
      overrides.forceRefreshSession ?? vi.fn(() => of({ isAuthenticated: true })),
    isAuthenticated$: of({ isAuthenticated: true, allConfigsAuthenticated: [] }),
    getAccessToken: () => of(''),
  };
}

function setup(overrides: Parameters<typeof makeOidcStub>[0] = {}) {
  const oidc = makeOidcStub(overrides);
  const eventsSubject = new Subject<{ type: EventTypes }>();
  TestBed.configureTestingModule({
    providers: [
      { provide: OidcSecurityService, useValue: oidc },
      {
        provide: PublicEventsService,
        useValue: { registerForEvents: () => eventsSubject.asObservable() },
      },
    ],
  });
  const watcher = TestBed.inject(SessionWatcher);
  return { watcher, oidc, eventsSubject };
}

describe('SessionWatcher', () => {
  it('refreshOnce() returns the same in-flight observable for concurrent callers', () => {
    const subj = new Subject<unknown>();
    const force = vi.fn(() => subj.asObservable());
    const { watcher } = setup({ forceRefreshSession: force });

    let a = 0;
    let b = 0;
    watcher.refreshOnce('interceptor').subscribe(() => (a += 1));
    watcher.refreshOnce('interceptor').subscribe(() => (b += 1));

    expect(force).toHaveBeenCalledTimes(1);
    subj.next(null);
    subj.complete();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('debounces a second refresh within the cooldown window', () => {
    const force = vi.fn(() => of(null));
    const { watcher } = setup({ forceRefreshSession: force });

    watcher.refreshOnce('visibility').subscribe();
    // First refresh completed synchronously; the second call falls inside
    // the 30s debounce window and should resolve to of(null) without
    // invoking forceRefreshSession again.
    watcher.refreshOnce('visibility').subscribe();
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('triggers a refresh on TokenExpired / SilentRenewFailed events', () => {
    const force = vi.fn(() => of(null));
    const { watcher, eventsSubject } = setup({ forceRefreshSession: force });
    watcher.start();

    eventsSubject.next({ type: EventTypes.TokenExpired });
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated OIDC events', () => {
    const force = vi.fn(() => of(null));
    const { watcher, eventsSubject } = setup({ forceRefreshSession: force });
    watcher.start();

    eventsSubject.next({ type: EventTypes.UserDataChanged });
    eventsSubject.next({ type: EventTypes.CheckSessionReceived });
    expect(force).not.toHaveBeenCalled();
  });
});
