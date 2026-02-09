import { PassedInitialConfig } from 'angular-auth-oidc-client';
import { APP_CONFIG, buildRedirectUrl } from '../config/app-config';

export const authConfig: PassedInitialConfig = {
  config: {
    authority: APP_CONFIG.cognito.authority,
    redirectUrl: buildRedirectUrl(APP_CONFIG.cognito.redirectPath),
    postLogoutRedirectUri: buildRedirectUrl(APP_CONFIG.cognito.postLogoutPath),
    clientId: APP_CONFIG.cognito.clientId,
    scope: APP_CONFIG.cognito.scope,
    responseType: 'code',
    // Keep the user on the callback route after the OIDC library processes login,
    // so our AuthCallback component can route based on Cognito groups.
    postLoginRoute: '/auth/callback',
    silentRenew: true,
    useRefreshToken: true,
    renewTimeBeforeTokenExpiresInSeconds: 30,
  },
};
