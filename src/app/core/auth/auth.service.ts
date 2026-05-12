import { Injectable } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { buildCognitoLogoutUrl } from '../config/app-config';
import { decodeJwt, normalizeGroupsClaim, JwtClaims } from './jwt';
import { Observable, combineLatest, distinctUntilChanged, map } from 'rxjs';

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
      map(claims => normalizeGroupsClaim(claims?.['cognito:groups'])),
      // Silent renew re-emits the same group list every ~14 min. Without
      // distinctUntilChanged, every consumer (topbar context loader,
      // sidebar role gate, etc.) re-fires its side effects on every
      // renew — duplicate API calls and visible flicker.
      distinctUntilChanged(
        (a, b) => a.length === b.length && a.every((g, i) => g === b[i])
      )
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

  /**
   * Best-effort email from ID token. Returns `null` if Cognito didn't
   * include the `email` claim in the access/ID token scopes.
   */
  email$(): Observable<string | null> {
    return this.idTokenClaims$().pipe(
      map(claims => {
        const e = claims?.['email'];
        return typeof e === 'string' && e.length > 0 ? e : null;
      })
    );
  }

  /**
   * Profile-picture URL from the ID token's `picture` claim. Returns
   * `null` today — Cognito doesn't surface `picture` unless the user
   * pool schema is extended and the scope is mapped through OIDC.
   * Wired now so the sidebar chip + future profile UI can light up
   * without a template change the day photos arrive.
   */
  photoUrl$(): Observable<string | null> {
    return this.idTokenClaims$().pipe(
      map(claims => {
        const p = claims?.['picture'];
        return typeof p === 'string' && p.length > 0 ? p : null;
      })
    );
  }

  /**
   * Subtitle line for the user chip. Prefers the email claim; falls
   * back to the role label when the token has no email (so staff still
   * see "Admin" instead of an empty second line).
   */
  subtitle$(): Observable<string> {
    return combineLatest([this.email$(), this.roleLabel$()]).pipe(
      map(([email, role]) => email ?? role)
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
    // Revoke the refresh token at Cognito so a stolen copy can't mint new
    // access tokens for the remaining ~30 days of its lifetime. The
    // revocation endpoint is auto-discovered from Cognito's
    // .well-known/openid-configuration. Cognito only accepts refresh
    // tokens for revocation (not access tokens), so we don't bother with
    // revokeAccessToken — the access token expires in ~60 min anyway.
    //
    // Best-effort: even if revocation fails (network error, token already
    // expired, etc.), we still proceed with local cleanup + Hosted UI
    // logout so the user isn't stuck.
    this.oidc.revokeRefreshToken().subscribe({
      next: () => this.completeLogout(),
      error: (err) => {
        console.warn('refresh_token_revoke_failed_continuing_logout', err);
        this.completeLogout();
      },
    });
  }

  private completeLogout(): void {
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
