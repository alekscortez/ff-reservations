import type { User, UserManagerSettings } from 'oidc-client-ts';
import { WebStorageStateStore } from 'oidc-client-ts';
import { buildCognitoLogoutUrl } from '@ff/config';
import { APP_CONFIG, buildRedirectUrl } from './config';

export type CognitoGroup = 'Admin' | 'Staff';

export function buildStaffOidcConfig(): UserManagerSettings {
  return {
    authority: APP_CONFIG.cognito.authority,
    client_id: APP_CONFIG.cognito.staffClientId,
    redirect_uri: buildRedirectUrl(APP_CONFIG.cognito.redirectPath),
    post_logout_redirect_uri: buildRedirectUrl(APP_CONFIG.cognito.postLogoutPath),
    response_type: 'code',
    scope: APP_CONFIG.cognito.scope,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    monitorSession: false,
  };
}

export function getGroups(user: User | null | undefined): string[] {
  const raw = user?.profile?.['cognito:groups'];
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
  return [];
}

export function isAdmin(groups: readonly string[]): boolean {
  return groups.includes('Admin');
}

export function isStaffOrAdmin(groups: readonly string[]): boolean {
  return groups.includes('Admin') || groups.includes('Staff');
}

export function cognitoLogoutUrl(): string {
  return buildCognitoLogoutUrl({
    hostedUiDomain: APP_CONFIG.cognito.hostedUiDomain,
    clientId: APP_CONFIG.cognito.staffClientId,
    returnTo: buildRedirectUrl(APP_CONFIG.cognito.postLogoutPath),
  });
}
