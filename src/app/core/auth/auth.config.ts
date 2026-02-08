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
    silentRenew: true,
    useRefreshToken: true,
    renewTimeBeforeTokenExpiresInSeconds: 30,
  },
};
