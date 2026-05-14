import { TestBed } from '@angular/core/testing';
import {
  EventTypes,
  OidcSecurityService,
  PublicEventsService,
} from 'angular-auth-oidc-client';
import { Subject, of, throwError } from 'rxjs';
import { SessionWatcher } from './session-watcher';
import { TelemetryService } from '../http/telemetry.service';

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
  const fireSpy = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: OidcSecurityService, useValue: oidc },
      {
        provide: PublicEventsService,
        useValue: { registerForEvents: () => eventsSubject.asObservable() },
      },
      { provide: TelemetryService, useValue: { fire: fireSpy } },
    ],
  });
  const watcher = TestBed.inject(SessionWatcher);
  return { watcher, oidc, eventsSubject, fireSpy };
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

  it('fires auth_renew_started + auth_renew_succeeded telemetry on success', () => {
    const force = vi.fn(() => of({ isAuthenticated: true }));
    const { watcher, fireSpy } = setup({ forceRefreshSession: force });

    watcher.refreshOnce('visibility').subscribe();
    const events = fireSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('auth_renew_started');
    expect(events).toContain('auth_renew_succeeded');
    const succeededCall = fireSpy.mock.calls.find(
      (c) => c[0] === 'auth_renew_succeeded'
    );
    expect(succeededCall?.[1]?.extra?.source).toBe('visibility');
  });

  it('fires auth_renew_failed telemetry on refresh error', () => {
    const err: Error & { status?: number } = Object.assign(new Error('boom'), {
      status: 0,
    });
    const force = vi.fn(() => throwError(() => err));
    const { watcher, fireSpy } = setup({ forceRefreshSession: force });

    watcher.refreshOnce('interceptor').subscribe({ error: () => undefined });
    const events = fireSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('auth_renew_started');
    expect(events).toContain('auth_renew_failed');
  });
});
