import type { PropsWithChildren } from 'react';
import { AuthContext, type AuthContextProps } from 'react-oidc-context';
import { vi } from 'vitest';

export type MockAuthState = Partial<AuthContextProps>;

const noop = () => undefined;
const noopAsync = async () => undefined;

export function buildMockAuth(overrides: MockAuthState = {}): AuthContextProps {
  return {
    isLoading: false,
    isAuthenticated: false,
    user: null,
    error: undefined,
    activeNavigator: undefined,
    settings: {} as AuthContextProps['settings'],
    events: {} as AuthContextProps['events'],
    signinPopup: vi.fn(noopAsync) as unknown as AuthContextProps['signinPopup'],
    signinSilent: vi.fn(noopAsync) as unknown as AuthContextProps['signinSilent'],
    signinRedirect: vi.fn(noopAsync),
    signinResourceOwnerCredentials: vi.fn(noopAsync) as unknown as AuthContextProps['signinResourceOwnerCredentials'],
    signoutRedirect: vi.fn(noopAsync),
    signoutPopup: vi.fn(noopAsync),
    signoutSilent: vi.fn(noopAsync),
    querySessionStatus: vi.fn(noopAsync) as unknown as AuthContextProps['querySessionStatus'],
    revokeTokens: vi.fn(noopAsync),
    removeUser: vi.fn(noopAsync),
    clearStaleState: vi.fn(noopAsync),
    startSilentRenew: vi.fn(noop),
    stopSilentRenew: vi.fn(noop),
    ...overrides,
  };
}

export function TestAuthProvider({
  value,
  children,
}: PropsWithChildren<{ value?: MockAuthState }>) {
  return <AuthContext.Provider value={buildMockAuth(value)}>{children}</AuthContext.Provider>;
}
