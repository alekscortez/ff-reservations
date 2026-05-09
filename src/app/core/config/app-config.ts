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
