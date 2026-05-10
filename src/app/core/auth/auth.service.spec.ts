import { TestBed } from '@angular/core/testing';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { Observable, lastValueFrom, of, throwError } from 'rxjs';

import { AuthService } from './auth.service';
import { JwtClaims } from './jwt';

// Build a base64url-encoded JWT body for the given claims (matches jwt.spec.ts).
function buildJwt(claims: JwtClaims): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const sig = b64url('signature-stub');
  return `${header}.${payload}.${sig}`;
}

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

interface OidcStub {
  isAuthenticated$: Observable<{ isAuthenticated: boolean; allConfigsAuthenticated: never[] }>;
  getIdToken: () => Observable<string>;
  authorize: ReturnType<typeof vi.fn>;
  revokeRefreshToken: ReturnType<typeof vi.fn>;
  logoffLocal: ReturnType<typeof vi.fn>;
}

function buildOidcStub(overrides: Partial<OidcStub> = {}): OidcStub {
  return {
    isAuthenticated$: of({ isAuthenticated: false, allConfigsAuthenticated: [] }),
    getIdToken: () => of(''),
    authorize: vi.fn(),
    revokeRefreshToken: vi.fn(() => of(null)),
    logoffLocal: vi.fn(),
    ...overrides,
  };
}

function makeAuth(stub: OidcStub): AuthService {
  TestBed.configureTestingModule({
    providers: [{ provide: OidcSecurityService, useValue: stub }],
  });
  return TestBed.inject(AuthService);
}

describe('AuthService', () => {
  describe('isAuthenticated$', () => {
    it('emits true when OIDC reports authenticated', async () => {
      const stub = buildOidcStub({
        isAuthenticated$: of({ isAuthenticated: true, allConfigsAuthenticated: [] }),
      });
      expect(await lastValueFrom(makeAuth(stub).isAuthenticated$())).toBe(true);
    });

    it('emits false when OIDC reports not authenticated', async () => {
      expect(await lastValueFrom(makeAuth(buildOidcStub()).isAuthenticated$())).toBe(false);
    });
  });

  describe('idTokenClaims$', () => {
    it('returns null for empty token', async () => {
      const stub = buildOidcStub({ getIdToken: () => of('') });
      expect(await lastValueFrom(makeAuth(stub).idTokenClaims$())).toBeNull();
    });

    it('decodes valid token', async () => {
      const token = buildJwt({ sub: 'abc', email: 'a@x.com' });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      const claims = await lastValueFrom(makeAuth(stub).idTokenClaims$());
      expect(claims).toEqual({ sub: 'abc', email: 'a@x.com' });
    });

    it('returns null for malformed token', async () => {
      const stub = buildOidcStub({ getIdToken: () => of('not-a-jwt') });
      expect(await lastValueFrom(makeAuth(stub).idTokenClaims$())).toBeNull();
    });
  });

  describe('groups$', () => {
    it('returns parsed array from a real array claim', async () => {
      const token = buildJwt({ 'cognito:groups': ['Admin', 'Staff'] });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).groups$())).toEqual(['Admin', 'Staff']);
    });

    it('returns parsed array from a JSON-stringified claim (Pre Token Gen v2 access token shape)', async () => {
      const token = buildJwt({ 'cognito:groups': '["Admin","Staff"]' });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).groups$())).toEqual(['Admin', 'Staff']);
    });

    it('returns [] when groups claim is missing', async () => {
      const token = buildJwt({ sub: 'no-groups' });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).groups$())).toEqual([]);
    });

    it('returns [] when token is missing entirely', async () => {
      expect(await lastValueFrom(makeAuth(buildOidcStub()).groups$())).toEqual([]);
    });

    it('distinctUntilChanged: identical arrays in sequence collapse to one emission', async () => {
      // Cognito silent renew re-emits the same group list every ~14 min;
      // distinctUntilChanged prevents duplicate side-effect re-fires in subscribers.
      const token = buildJwt({ 'cognito:groups': ['Admin'] });
      const stub = buildOidcStub({
        getIdToken: () =>
          new Observable<string>((sub) => {
            sub.next(token);
            sub.next(token);
            sub.next(token);
            sub.complete();
          }),
      });
      const seen: string[][] = [];
      makeAuth(stub).groups$().subscribe((g) => seen.push(g));
      expect(seen).toEqual([['Admin']]);
    });

    it('distinctUntilChanged: differing groups DO emit separately', async () => {
      const a = buildJwt({ 'cognito:groups': ['Admin'] });
      const b = buildJwt({ 'cognito:groups': ['Staff'] });
      const stub = buildOidcStub({
        getIdToken: () =>
          new Observable<string>((sub) => {
            sub.next(a);
            sub.next(b);
            sub.complete();
          }),
      });
      const seen: string[][] = [];
      makeAuth(stub).groups$().subscribe((g) => seen.push(g));
      expect(seen).toEqual([['Admin'], ['Staff']]);
    });

    it('distinctUntilChanged: same length but different members DO emit separately', async () => {
      // distinctUntilChanged compares length + index-by-index. A swap from
      // ['Admin'] to ['Staff'] (same length) must NOT be deduped.
      const a = buildJwt({ 'cognito:groups': ['Admin', 'Staff'] });
      const b = buildJwt({ 'cognito:groups': ['Admin', 'Other'] });
      const stub = buildOidcStub({
        getIdToken: () =>
          new Observable<string>((sub) => {
            sub.next(a);
            sub.next(b);
            sub.complete();
          }),
      });
      const seen: string[][] = [];
      makeAuth(stub).groups$().subscribe((g) => seen.push(g));
      expect(seen).toEqual([['Admin', 'Staff'], ['Admin', 'Other']]);
    });
  });

  describe('displayName$', () => {
    it('prefers `name` claim', async () => {
      const token = buildJwt({ name: 'Aleks', email: 'a@x.com', 'cognito:username': 'u' });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).displayName$())).toBe('Aleks');
    });

    it('falls back to `email` when name missing', async () => {
      const token = buildJwt({ email: 'a@x.com', 'cognito:username': 'u' });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).displayName$())).toBe('a@x.com');
    });

    it('falls back to `cognito:username` when name + email missing', async () => {
      const token = buildJwt({ 'cognito:username': 'u' });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).displayName$())).toBe('u');
    });

    it('falls back to literal "User" when claims are absent entirely', async () => {
      expect(await lastValueFrom(makeAuth(buildOidcStub()).displayName$())).toBe('User');
    });
  });

  describe('roleLabel$', () => {
    it('returns "Admin" when user is in Admin group (even alongside Staff)', async () => {
      const token = buildJwt({ 'cognito:groups': ['Admin', 'Staff'] });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).roleLabel$())).toBe('Admin');
    });

    it('returns "Staff" when only in Staff', async () => {
      const token = buildJwt({ 'cognito:groups': ['Staff'] });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).roleLabel$())).toBe('Staff');
    });

    it('returns "User" otherwise', async () => {
      const token = buildJwt({ 'cognito:groups': [] });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).roleLabel$())).toBe('User');
    });
  });

  describe('hasGroup$', () => {
    it('returns true when group is present', async () => {
      const token = buildJwt({ 'cognito:groups': ['Admin'] });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).hasGroup$('Admin'))).toBe(true);
    });

    it('returns false when group is absent', async () => {
      const token = buildJwt({ 'cognito:groups': ['Staff'] });
      const stub = buildOidcStub({ getIdToken: () => of(token) });
      expect(await lastValueFrom(makeAuth(stub).hasGroup$('Admin'))).toBe(false);
    });
  });

  describe('login', () => {
    it('delegates to OIDC.authorize()', () => {
      const stub = buildOidcStub();
      makeAuth(stub).login();
      expect(stub.authorize).toHaveBeenCalledOnce();
    });
  });

  describe('logout', () => {
    let originalLocation: Location;
    let replaceSpy: ReturnType<typeof vi.fn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // jsdom's Location is non-configurable in modern versions; replace the
      // whole `window.location` object via Object.defineProperty on `window`.
      originalLocation = window.location;
      replaceSpy = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: { ...originalLocation, replace: replaceSpy, origin: originalLocation.origin },
      });
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
      warnSpy.mockRestore();
      window.localStorage.clear();
      window.sessionStorage.clear();
    });

    it('happy path: revokes refresh token, then completes local logout + Cognito redirect', () => {
      const stub = buildOidcStub();
      makeAuth(stub).logout();
      expect(stub.revokeRefreshToken).toHaveBeenCalledOnce();
      expect(stub.logoffLocal).toHaveBeenCalledOnce();
      expect(replaceSpy).toHaveBeenCalledOnce();
      const url = replaceSpy.mock.calls[0][0] as string;
      expect(url).toContain('/logout?client_id=');
      expect(url).toContain('logout_uri=');
    });

    it('error path: still completes local logout even when refresh-token revocation fails', () => {
      const stub = buildOidcStub({
        revokeRefreshToken: vi.fn(() => throwError(() => new Error('network down'))),
      });
      makeAuth(stub).logout();
      expect(stub.logoffLocal).toHaveBeenCalledOnce();
      expect(replaceSpy).toHaveBeenCalledOnce();
      // Error is logged but not re-thrown.
      expect(warnSpy).toHaveBeenCalledWith(
        'refresh_token_revoke_failed_continuing_logout',
        expect.any(Error)
      );
    });

    it('clears ff_*/oidc.* keys from localStorage; preserves unrelated keys', () => {
      window.localStorage.setItem('ff_new_res_active_hold_v1', JSON.stringify({ a: 1 }));
      window.localStorage.setItem('oidc.user:something', 'token');
      window.localStorage.setItem('unrelated_app_pref', 'keep-me');
      const stub = buildOidcStub();
      makeAuth(stub).logout();
      expect(window.localStorage.getItem('ff_new_res_active_hold_v1')).toBeNull();
      expect(window.localStorage.getItem('oidc.user:something')).toBeNull();
      expect(window.localStorage.getItem('unrelated_app_pref')).toBe('keep-me');
    });

    it('clears ff_*/oidc.* keys from sessionStorage; preserves unrelated keys', () => {
      window.sessionStorage.setItem('ff_temp', 'x');
      window.sessionStorage.setItem('oidc.state', 'y');
      window.sessionStorage.setItem('other_app', 'keep');
      const stub = buildOidcStub();
      makeAuth(stub).logout();
      expect(window.sessionStorage.getItem('ff_temp')).toBeNull();
      expect(window.sessionStorage.getItem('oidc.state')).toBeNull();
      expect(window.sessionStorage.getItem('other_app')).toBe('keep');
    });

    it('Cognito logout URL embeds the current origin as logout_uri', () => {
      const stub = buildOidcStub();
      makeAuth(stub).logout();
      const url = replaceSpy.mock.calls[0][0] as string;
      // jsdom's default origin is http://localhost:3000
      expect(url).toContain(encodeURIComponent(window.location.origin));
    });
  });
});
