export const APP_CONFIG = {
  apiBaseUrl: 'https://api.famosofuego.com',
  cognito: {
    authority: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Upsi9Q2Tc',
    hostedUiDomain: 'https://us-east-1upsi9q2tc.auth.us-east-1.amazoncognito.com',
    clientId: '1kdkvis45qo915plp7lvj03u16',
    scope: 'openid email profile',
    redirectPath: '/auth/callback',
    postLogoutPath: '/login',
  },
  // Meta Pixel ID from Events Manager. Empty = Pixel disabled entirely
  // (FE service no-ops, no fbevents.js loaded). The matching BE env
  // vars `META_PIXEL_ID` + `META_CAPI_TOKEN_SECRET_ARN` gate the CAPI
  // mirror — both halves can be configured independently.
  metaPixelId: '',
} as const;

export function buildRedirectUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

export function buildCognitoLogoutUrl(returnTo: string): string {
  const base = APP_CONFIG.cognito.hostedUiDomain.replace(/\/$/, '');
  const clientId = encodeURIComponent(APP_CONFIG.cognito.clientId);
  const logoutUri = encodeURIComponent(returnTo);
  return `${base}/logout?client_id=${clientId}&logout_uri=${logoutUri}`;
}
