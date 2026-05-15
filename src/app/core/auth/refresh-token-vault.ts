import { Injectable, inject } from '@angular/core';
import { EventTypes, OidcSecurityService, PublicEventsService } from 'angular-auth-oidc-client';
import { filter, take } from 'rxjs';

// Phase 1: shadow refresh-token storage. The OIDC library's
// resetAuthorizationData() wipes the refresh token from its own storage
// key on any failure (validation error, failed renew, even some 5xx paths).
// Once that happens, every subsequent renew throws "no refresh token
// found, please login" synchronously — no HTTP call, no recovery.
//
// We keep our own copy in a dedicated localStorage key the library never
// touches. On every NewAuthenticationResult event we capture the current
// refresh token. SessionWatcher + bootstrap recovery read from here when
// the library's storage is empty.
//
// Cleared ONLY on intentional logout. The default expiry follows Cognito's
// 30d refresh-token TTL — the vault never trusts a refresh token past
// that absolute deadline, even if the library would have.
@Injectable({ providedIn: 'root' })
export class RefreshTokenVault {
  private oidc = inject(OidcSecurityService);
  private events = inject(PublicEventsService);

  private readonly KEY = 'ff_oidc_rt_shadow_v1';
  // Cognito staff app client RefreshTokenValidity = 30 days.
  private readonly DEFAULT_TTL_SEC = 30 * 24 * 60 * 60;

  private started = false;

  /** Wire library-event subscription. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.events
      .registerForEvents()
      .pipe(
        filter(
          (evt) =>
            evt?.type === EventTypes.NewAuthenticationResult ||
            evt?.type === EventTypes.UserDataChanged
        )
      )
      .subscribe(() => this.captureFromLibrary());

    // Capture immediately if a refresh token is already present (e.g.
    // bootstrap loaded persisted state before our subscription wired).
    this.captureFromLibrary();
  }

  /** Returns the cached refresh token + absolute expiry, or null. */
  read(): { refreshToken: string; expiresAt: number } | null {
    try {
      const raw = window.localStorage.getItem(this.KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        refreshToken?: unknown;
        expiresAt?: unknown;
      };
      const refreshToken = typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '';
      const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0;
      if (!refreshToken || !expiresAt) return null;
      return { refreshToken, expiresAt };
    } catch {
      return null;
    }
  }

  /** Persist with an absolute epoch-second expiry. */
  write(refreshToken: string, expiresAt: number): void {
    if (!refreshToken) return;
    try {
      window.localStorage.setItem(
        this.KEY,
        JSON.stringify({ refreshToken, expiresAt })
      );
    } catch {
      // Storage may be unavailable in some private-browsing modes.
    }
  }

  /** Wipe the shadow. Called from AuthService.logout(). */
  clear(): void {
    try {
      window.localStorage.removeItem(this.KEY);
    } catch {
      // Storage may be unavailable.
    }
  }

  /** True iff a refresh token is present AND its absolute expiry is in the future. */
  hasFresh(): boolean {
    const r = this.read();
    if (!r) return false;
    return r.expiresAt > Math.floor(Date.now() / 1000);
  }

  private captureFromLibrary(): void {
    this.oidc
      .getRefreshToken()
      .pipe(take(1))
      .subscribe((rt) => {
        if (typeof rt !== 'string' || rt.length === 0) return;
        const expiresAt = Math.floor(Date.now() / 1000) + this.DEFAULT_TTL_SEC;
        this.write(rt, expiresAt);
      });
  }
}
