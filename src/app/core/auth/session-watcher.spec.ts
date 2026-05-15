import { TestBed } from '@angular/core/testing';
import {
  EventTypes,
  OidcSecurityService,
  PublicEventsService,
} from 'angular-auth-oidc-client';
import { Observable, Subject, of, throwError } from 'rxjs';
import { SessionWatcher } from './session-watcher';
import { TelemetryService } from '../http/telemetry.service';
import { RefreshTokenVault } from './refresh-token-vault';
import { DirectRefreshClient, CognitoTokenResponse } from './direct-refresh-client';
import { LibraryStorageBridge } from './library-storage-bridge';

interface SetupOptions {
  /** What direct.refresh(rt) emits. Defaults to a successful token response. */
  refresh?: () => Observable<CognitoTokenResponse>;
  /** What vault.read() returns. Defaults to a valid token. */
  vaultRead?: () => { refreshToken: string; expiresAt: number } | null;
  /** What library storage's getRefreshToken returns. Defaults to null. */
  bridgeRead?: () => string | null;
}

function defaultTokenResponse(): CognitoTokenResponse {
  return {
    access_token: 'new-access',
    id_token: 'new-id',
    refresh_token: 'rotated-rt',
    token_type: 'Bearer',
    expires_in: 86400,
  };
}

function setup(opts: SetupOptions = {}) {
  const refreshSpy = vi.fn(
    opts.refresh ?? (() => of(defaultTokenResponse()))
  );
  const checkAuthSpy = vi.fn(() => of({ isAuthenticated: true }));
  const oidcStub = {
    isAuthenticated$: of({ isAuthenticated: true, allConfigsAuthenticated: [] }),
    getAccessToken: () => of(''),
    getRefreshToken: () => of('rt'),
    checkAuth: checkAuthSpy,
  };
  const eventsSubject = new Subject<{ type: EventTypes }>();
  const fireSpy = vi.fn();
  const vaultRead = vi.fn(
    opts.vaultRead ??
      (() => ({ refreshToken: 'rt-from-vault', expiresAt: 9_999_999_999 }))
  );
  const vaultWrite = vi.fn();
  const vaultStart = vi.fn();
  const bridgeApply = vi.fn();
  const bridgeReadRt = vi.fn(opts.bridgeRead ?? (() => null));

  TestBed.configureTestingModule({
    providers: [
      { provide: OidcSecurityService, useValue: oidcStub },
      {
        provide: PublicEventsService,
        useValue: { registerForEvents: () => eventsSubject.asObservable() },
      },
      { provide: TelemetryService, useValue: { fire: fireSpy } },
      {
        provide: RefreshTokenVault,
        useValue: {
          start: vaultStart,
          read: vaultRead,
          write: vaultWrite,
          clear: vi.fn(),
          hasFresh: () => vaultRead() !== null,
        },
      },
      {
        provide: DirectRefreshClient,
        useValue: { refresh: refreshSpy },
      },
      {
        provide: LibraryStorageBridge,
        useValue: {
          applyTokenResponse: bridgeApply,
          readRefreshToken: bridgeReadRt,
          read: () => ({}),
        },
      },
    ],
  });

  return {
    watcher: TestBed.inject(SessionWatcher),
    fireSpy,
    refreshSpy,
    checkAuthSpy,
    vaultRead,
    vaultWrite,
    bridgeApply,
    bridgeReadRt,
    eventsSubject,
  };
}

describe('SessionWatcher', () => {
  it('refreshOnce reads refresh token from vault and posts to DirectRefreshClient', () => {
    const { watcher, refreshSpy, bridgeApply, vaultWrite, checkAuthSpy } =
      setup();
    let result: unknown = null;
    watcher.refreshOnce('visibility').subscribe({
      next: (v) => (result = v),
    });
    expect(refreshSpy).toHaveBeenCalledWith('rt-from-vault');
    // Tokens written back to library storage
    expect(bridgeApply).toHaveBeenCalledTimes(1);
    // Rotated refresh token persisted to vault
    expect(vaultWrite).toHaveBeenCalledWith(
      'rotated-rt',
      expect.any(Number)
    );
    // Library auth state re-synced
    expect(checkAuthSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ isAuthenticated: true });
  });

  it('falls back to library storage when vault is empty', () => {
    const { refreshSpy } = setup({
      vaultRead: () => null,
      bridgeRead: () => 'rt-from-library',
    });
    const watcher = TestBed.inject(SessionWatcher);
    watcher.refreshOnce('focus').subscribe({ error: () => undefined });
    expect(refreshSpy).toHaveBeenCalledWith('rt-from-library');
  });

  it('fails synchronously when no refresh token is available anywhere', () => {
    const { watcher, refreshSpy, fireSpy } = setup({
      vaultRead: () => null,
      bridgeRead: () => null,
    });
    let captured: unknown = null;
    watcher.refreshOnce('focus').subscribe({
      error: (e) => (captured = e),
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(captured).toBeInstanceOf(Error);
    const failedCall = fireSpy.mock.calls.find(
      (c) => c[0] === 'auth_renew_failed'
    );
    expect(failedCall?.[1]?.extra?.reason).toBe('no_refresh_token');
  });

  it('returns the same in-flight observable for concurrent callers', () => {
    const subj = new Subject<CognitoTokenResponse>();
    const { watcher, refreshSpy } = setup({ refresh: () => subj.asObservable() });
    let a = 0;
    let b = 0;
    watcher.refreshOnce('interceptor').subscribe(() => (a += 1));
    watcher.refreshOnce('interceptor').subscribe(() => (b += 1));
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    subj.next(defaultTokenResponse());
    subj.complete();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('debounces a second refresh within the cooldown window', () => {
    const { watcher, refreshSpy } = setup();
    watcher.refreshOnce('visibility').subscribe();
    watcher.refreshOnce('visibility').subscribe();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('triggers a refresh on TokenExpired / SilentRenewFailed events', () => {
    const { watcher, refreshSpy, eventsSubject } = setup();
    watcher.start();
    eventsSubject.next({ type: EventTypes.TokenExpired });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated OIDC events', () => {
    const { watcher, refreshSpy, eventsSubject } = setup();
    watcher.start();
    eventsSubject.next({ type: EventTypes.UserDataChanged });
    eventsSubject.next({ type: EventTypes.CheckSessionReceived });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('fires auth_renew_started + auth_renew_succeeded telemetry on success', () => {
    const { watcher, fireSpy } = setup();
    watcher.refreshOnce('visibility').subscribe();
    const events = fireSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('auth_renew_started');
    expect(events).toContain('auth_renew_succeeded');
    const succeededCall = fireSpy.mock.calls.find(
      (c) => c[0] === 'auth_renew_succeeded'
    );
    expect(succeededCall?.[1]?.extra?.source).toBe('visibility');
  });

  it('fires auth_renew_failed telemetry on refresh error from DirectRefreshClient', () => {
    const err: Error & { status?: number } = Object.assign(new Error('boom'), {
      status: 502,
    });
    const { watcher, fireSpy } = setup({ refresh: () => throwError(() => err) });
    watcher.refreshOnce('interceptor').subscribe({ error: () => undefined });
    const events = fireSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('auth_renew_started');
    expect(events).toContain('auth_renew_failed');
    const failedCall = fireSpy.mock.calls.find(
      (c) => c[0] === 'auth_renew_failed'
    );
    expect(failedCall?.[1]?.extra?.status).toBe(502);
  });

  it('skips the library-storage write when DirectRefreshClient errors', () => {
    const err = new Error('cognito 5xx');
    const { watcher, bridgeApply, vaultWrite } = setup({
      refresh: () => throwError(() => err),
    });
    watcher.refreshOnce('focus').subscribe({ error: () => undefined });
    expect(bridgeApply).not.toHaveBeenCalled();
    expect(vaultWrite).not.toHaveBeenCalled();
  });
});
