import { Injectable } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { buildCognitoLogoutUrl } from '../config/app-config';
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
  idTokenClaims$(): Observable<any> {
    return this.oidc.getIdToken().pipe(
      map(token => decodeJwt(token))
    );
  }

  /** Cognito groups */
  groups$(): Observable<string[]> {
    return this.idTokenClaims$().pipe(
      map(claims => claims?.['cognito:groups'] ?? [])
    );
  }

  /** Best-effort display name from ID token */
  displayName$(): Observable<string> {
    return this.idTokenClaims$().pipe(
      map(claims => claims?.name || claims?.email || claims?.['cognito:username'] || 'User')
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
    // Local cleanup
    this.oidc.logoffLocal();
    window.sessionStorage.clear();
    window.localStorage.clear();

    // Cognito Hosted UI logout
    const logoutUrl = buildCognitoLogoutUrl(window.location.origin);
    window.location.replace(logoutUrl);
  }
}

/* ---------- helper ---------- */
function decodeJwt(token: string | null | undefined): any {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(payload));
}
