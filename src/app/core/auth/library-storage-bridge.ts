import { Injectable } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';
import type { CognitoTokenResponse } from './direct-refresh-client';

// The OIDC library stores all auth state under ONE localStorage entry
// keyed by `configId`. The value is a JSON object containing many fields
// — authnResult (token bundle), authzData (raw access_token), authStateControl,
// authWellKnownEndPoints, etc. After our direct refresh, we merge the new
// tokens into authnResult + authzData without disturbing the rest, then
// the caller triggers oidc.checkAuth() so the library's in-memory state
// re-syncs from disk.
//
// configId is auto-generated when not provided: `${index}-${clientId}`
// per library source line 3616. Since we register one config, index=0.
@Injectable({ providedIn: 'root' })
export class LibraryStorageBridge {
  private readonly configKey = `0-${APP_CONFIG.cognito.clientId}`;

  /**
   * Read the full library auth-state blob from localStorage. Returns an
   * empty object if missing/corrupt — never throws.
   */
  read(): Record<string, unknown> {
    try {
      const raw = window.localStorage.getItem(this.configKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * Merge a fresh Cognito token response into the library's storage,
   * preserving any other auth-state fields (discovery doc, nonce, etc.).
   */
  applyTokenResponse(resp: CognitoTokenResponse): void {
    const existing = this.read();
    const authnResult = {
      ...((existing['authnResult'] as Record<string, unknown> | undefined) ?? {}),
      access_token: resp.access_token,
      id_token: resp.id_token,
      // Cognito normally echoes the same refresh_token; if rotation is
      // ever enabled we'll have a fresh one here.
      refresh_token:
        resp.refresh_token ??
        (existing['authnResult'] as { refresh_token?: string } | undefined)
          ?.refresh_token,
      token_type: resp.token_type ?? 'Bearer',
      expires_in: resp.expires_in ?? 86_400,
    };
    const next = {
      ...existing,
      authnResult,
      authzData: resp.access_token,
    };
    try {
      window.localStorage.setItem(this.configKey, JSON.stringify(next));
    } catch {
      // Storage may be unavailable — best-effort.
    }
  }

  /**
   * Best-effort read of the refresh token currently in library storage.
   * Used as a fallback when the shadow vault is empty.
   */
  readRefreshToken(): string | null {
    const blob = this.read();
    const authnResult = blob['authnResult'] as
      | { refresh_token?: unknown }
      | undefined;
    const rt = authnResult?.refresh_token;
    return typeof rt === 'string' && rt.length > 0 ? rt : null;
  }
}
