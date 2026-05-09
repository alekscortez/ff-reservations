import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { Login } from '@/features/auth/login';
import { TestAuthProvider } from './test-auth-provider';

function renderLogin(overrides = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <TestAuthProvider value={overrides}>
        <MemoryRouter initialEntries={['/login']}>
          <Login />
        </MemoryRouter>
      </TestAuthProvider>
    </I18nextProvider>
  );
}

describe('Login', () => {
  it('renders sign-in button when unauthenticated', () => {
    renderLogin({ isAuthenticated: false, isLoading: false });
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('triggers signinRedirect on click', () => {
    const signinRedirect = vi.fn();
    renderLogin({ isAuthenticated: false, isLoading: false, signinRedirect });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(signinRedirect).toHaveBeenCalledOnce();
  });

  it('disables button while loading', () => {
    renderLogin({ isAuthenticated: false, isLoading: true });
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
