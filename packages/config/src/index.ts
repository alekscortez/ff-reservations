export interface FfRuntimeConfig {
  apiBaseUrl: string;
  cognito: {
    authority: string;
    hostedUiDomain: string;
    staffClientId: string;
    customerClientId?: string;
    scope: string;
    redirectPath: string;
    postLogoutPath: string;
  };
}

export interface BuildCognitoLogoutUrlInput {
  hostedUiDomain: string;
  clientId: string;
  returnTo: string;
}

export function buildCognitoLogoutUrl(input: BuildCognitoLogoutUrlInput): string {
  const base = input.hostedUiDomain.replace(/\/$/, '');
  const clientId = encodeURIComponent(input.clientId);
  const logoutUri = encodeURIComponent(input.returnTo);
  return `${base}/logout?client_id=${clientId}&logout_uri=${logoutUri}`;
}

export function assertConfig(config: FfRuntimeConfig): void {
  if (!config.apiBaseUrl) throw new Error('FF config: apiBaseUrl is required');
  if (!config.cognito.authority) throw new Error('FF config: cognito.authority is required');
  if (!config.cognito.hostedUiDomain) throw new Error('FF config: cognito.hostedUiDomain is required');
  if (!config.cognito.staffClientId) throw new Error('FF config: cognito.staffClientId is required');
}
