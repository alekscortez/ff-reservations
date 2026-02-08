import { Injectable } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';
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
    this.oidc.logoff();
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
