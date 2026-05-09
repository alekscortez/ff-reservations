import { Injectable } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { buildCognitoLogoutUrl } from '../config/app-config';
import { decodeJwt, normalizeGroupsClaim, JwtClaims } from './jwt';
import { Observable, map } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(private oidc: OidcSecurityService) {}

  /** Auth status */
  isAuthenticated$(): Observable<boolean> {
    return this.oidc.isAuthenticated$.pipe(
      map(result => result.isAuthenticated)
    );
  }

  /** Decoded ID token claims */
  idTokenClaims$(): Observable<JwtClaims | null> {
    return this.oidc.getIdToken().pipe(
      map(token => decodeJwt(token))
    );
  }

  /** Cognito groups (parsed defensively — array or JSON-string array) */
  groups$(): Observable<string[]> {
    return this.idTokenClaims$().pipe(
      map(claims => normalizeGroupsClaim(claims?.['cognito:groups']))
    );
  }

  /** Best-effort display name from ID token */
  displayName$(): Observable<string> {
    return this.idTokenClaims$().pipe(
      map(claims =>
        String(
          claims?.['name'] ??
            claims?.['email'] ??
            claims?.['cognito:username'] ??
            'User'
        )
      )
    );
  }

  /** Role label for UI (Admin > Staff > User) */
  roleLabel$(): Observable<string> {
    return this.groups$().pipe(
      map(groups => (groups.includes('Admin') ? 'Admin' : groups.includes('Staff') ? 'Staff' : 'User'))
    );
  }

  /** Role check helper */
  hasGroup$(group: string): Observable<boolean> {
    return this.groups$().pipe(
      map(groups => groups.includes(group))
    );
  }

  login(): void {
    this.oidc.authorize();
  }

  logout(): void {
    // Local cleanup. Be selective so we don't nuke unrelated app state
    // (e.g. ff_new_res_active_hold_v1, saved filters). The OIDC library's
    // own keys live under "<authority>_…" prefixes; logoffLocal handles
    // those. We only clear our own ff_*/oidc.* scratch.
    this.oidc.logoffLocal();
    clearAppLocalStorage();

    // Cognito Hosted UI logout
    const logoutUrl = buildCognitoLogoutUrl(window.location.origin);
    window.location.replace(logoutUrl);
  }
}

function clearAppLocalStorage(): void {
  try {
    const ls = window.localStorage;
    const ss = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (k && (k.startsWith('ff_') || k.startsWith('oidc.'))) keys.push(k);
    }
    for (const k of keys) ls.removeItem(k);
    const sKeys: string[] = [];
    for (let i = 0; i < ss.length; i += 1) {
      const k = ss.key(i);
      if (k && (k.startsWith('ff_') || k.startsWith('oidc.'))) sKeys.push(k);
    }
    for (const k of sKeys) ss.removeItem(k);
  } catch {
    // Storage may be unavailable in some environments; logoffLocal already ran.
  }
}
