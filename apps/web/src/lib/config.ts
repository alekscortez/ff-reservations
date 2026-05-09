import { assertConfig, type FfRuntimeConfig } from '@ff/config';

const env = import.meta.env;

export const APP_CONFIG: FfRuntimeConfig = {
  apiBaseUrl: env.VITE_API_BASE_URL ?? 'https://api.famosofuego.com',
  cognito: {
    authority:
      env.VITE_COGNITO_AUTHORITY ??
      'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Upsi9Q2Tc',
    hostedUiDomain:
      env.VITE_COGNITO_HOSTED_UI_DOMAIN ??
      'https://us-east-1upsi9q2tc.auth.us-east-1.amazoncognito.com',
    staffClientId: env.VITE_COGNITO_STAFF_CLIENT_ID ?? '1kdkvis45qo915plp7lvj03u16',
    customerClientId: env.VITE_COGNITO_CUSTOMER_CLIENT_ID,
    scope: env.VITE_COGNITO_SCOPE ?? 'openid email profile',
    redirectPath: env.VITE_COGNITO_REDIRECT_PATH ?? '/auth/callback',
    postLogoutPath: env.VITE_COGNITO_POST_LOGOUT_PATH ?? '/login',
  },
};

assertConfig(APP_CONFIG);

export function buildRedirectUrl(path: string): string {
  return `${window.location.origin}${path}`;
}
