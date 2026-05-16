import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';
import { roleGuard } from './core/guards/role.guard';
import { unsavedChangesGuard } from './core/guards/unsaved-changes.guard';
import { Shell } from './core/layout/shell/shell';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  // /home is referenced by topbar; alias to /login rather than loading the
  // Login component a second time.
  { path: 'home', pathMatch: 'full', redirectTo: 'login' },

  // Public
  {
    path: 'login',
    title: 'Iniciar sesión — Famoso Fuego',
    loadComponent: () =>
      import('./features/public/login/login').then((m) => m.Login),
  },
  {
    path: 'auth/callback',
    title: 'Famoso Fuego',
    loadComponent: () =>
      import('./features/public/auth-callback/auth-callback').then(
        (m) => m.AuthCallback
      ),
  },
  {
    path: 'unauthorized',
    title: 'Acceso restringido — Famoso Fuego',
    loadComponent: () =>
      import('./features/public/unauthorized/unauthorized').then(
        (m) => m.Unauthorized
      ),
  },
  {
    path: 'check-in/pass',
    title: 'Tu pase — Famoso Fuego',
    loadComponent: () =>
      import('./features/public/check-in-pass/check-in-pass').then(
        (m) => m.CheckInPassPage
      ),
  },
  {
    path: 'reserva',
    title: 'Famoso Fuego — Reserva tu mesa',
    loadComponent: () =>
      import('./features/public/availability/availability').then(
        (m) => m.PublicAvailability
      ),
  },
  // Legacy slug — keep indefinitely so old SMS receipts, Apple Wallet
  // back-fields, and shared links resolve. Query string is preserved.
  { path: 'map', pathMatch: 'full', redirectTo: 'reserva' },
  {
    path: 'pay',
    title: 'Pago — Famoso Fuego',
    loadComponent: () =>
      import('./features/public/pay/pay').then((m) => m.PublicPayPage),
  },
  {
    // Token-gated reservation status page. URL: /r/{reservationId}?t={token}.
    // The anonymous public-booking flow redirects here from Square after
    // checkout; the page polls /public/reservations/{id} until PAID and
    // hands off Apple Wallet download.
    path: 'r/:id',
    title: 'Tu reserva — Famoso Fuego',
    loadComponent: () =>
      import('./features/public/reservation-status/reservation-status').then(
        (m) => m.ReservationStatus
      ),
  },

  // ✅ Staff (must be logged in)
  {
    path: 'staff',
    component: Shell,
    canMatch: [authGuard, roleGuard(['Staff', 'Admin'])],
    children: [
      {
        path: 'dashboard',
        title: 'Dashboard | Famoso Fuego',
        loadComponent: () =>
          import('./features/staff/dashboard/dashboard').then(
            (m) => m.Dashboard
          ),
      },
      {
        path: 'reservations',
        title: 'Reservations | Famoso Fuego',
        loadComponent: () =>
          import('./features/staff/reservations/reservations').then(
            (m) => m.Reservations
          ),
      },
      {
        path: 'reservations/new',
        title: 'Hold & Reserve | Famoso Fuego',
        loadComponent: () =>
          import('./features/staff/reservations-new/reservations-new').then(
            (m) => m.ReservationsNew
          ),
      },
      {
        path: 'check-in',
        title: 'Check-in | Famoso Fuego',
        loadComponent: () =>
          import('./features/staff/check-in/check-in').then((m) => m.CheckIn),
      },
      {
        path: 'events',
        title: 'Events | Famoso Fuego',
        loadComponent: () =>
          import('./features/staff/events/events').then((m) => m.StaffEvents),
      },
    ],
  },

  // ✅ Admin (must be logged in AND in Admin group)
  {
    path: 'admin',
    component: Shell,
    canMatch: [authGuard, adminGuard],
    children: [
      {
        path: '',
        pathMatch: 'full',
        redirectTo: '/staff/dashboard',
      },
      {
        path: 'dashboard',
        pathMatch: 'full',
        redirectTo: '/staff/dashboard',
      },
      {
        path: 'financials',
        title: 'Financials | Famoso Fuego',
        loadComponent: () =>
          import('./features/admin/financials/financials').then(
            (m) => m.Financials
          ),
      },
      {
        path: 'analytics',
        title: 'Marketing Analytics | Famoso Fuego',
        loadComponent: () =>
          import('./features/admin/analytics/analytics').then(
            (m) => m.AdminAnalytics
          ),
      },
      {
        path: 'users',
        title: 'Users | Famoso Fuego',
        loadComponent: () =>
          import('./features/admin/users/users').then((m) => m.Users),
      },
      {
        path: 'events',
        title: 'Events | Famoso Fuego',
        loadComponent: () =>
          import('./features/admin/events/events').then((m) => m.Events),
      },
      {
        path: 'settings',
        title: 'Settings | Famoso Fuego',
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () =>
          import('./features/admin/settings/settings').then(
            (m) => m.AdminSettings
          ),
      },
      {
        path: 'frequent-clients',
        title: 'Frequent clients | Famoso Fuego',
        loadComponent: () =>
          import('./features/admin/frequent-clients/frequent-clients').then(
            (m) => m.FrequentClients
          ),
      },
      {
        path: 'clients',
        title: 'Clients | Famoso Fuego',
        loadComponent: () =>
          import('./features/admin/clients/clients').then((m) => m.Clients),
      },
    ],
  },

  // 404
  {
    path: '**',
    title: 'Página no encontrada — Famoso Fuego',
    loadComponent: () =>
      import('./features/public/not-found/not-found').then((m) => m.NotFound),
  },
];
