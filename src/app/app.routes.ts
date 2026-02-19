import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { roleGuard } from './core/guards/role.guard';
import { Shell } from './core/layout/shell/shell';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },

  // Public
  {
    path: 'login',
    loadComponent: () =>
      import('./features/public/login/login').then((m) => m.Login),
  },
  {
    path: 'auth/callback',
    loadComponent: () =>
      import('./features/public/auth-callback/auth-callback').then(
        (m) => m.AuthCallback
      ),
  },
  {
    path: 'unauthorized',
    loadComponent: () =>
      import('./features/public/unauthorized/unauthorized').then(
        (m) => m.Unauthorized
      ),
  },
  {
    path: 'home',
    loadComponent: () =>
      import('./features/public/login/login').then((m) => m.Login),
  },
  {
    path: 'check-in/pass',
    loadComponent: () =>
      import('./features/public/check-in-pass/check-in-pass').then(
        (m) => m.CheckInPassPage
      ),
  },
  {
    path: 'map',
    loadComponent: () =>
      import('./features/public/availability/availability').then(
        (m) => m.PublicAvailability
      ),
  },
  {
    path: 'availability',
    loadComponent: () =>
      import('./features/public/availability/availability').then(
        (m) => m.PublicAvailability
      ),
  },
  {
    path: 'pay',
    loadComponent: () =>
      import('./features/public/pay/pay').then((m) => m.PublicPayPage),
  },
  {
    path: 'public/pay',
    loadComponent: () =>
      import('./features/public/pay/pay').then((m) => m.PublicPayPage),
  },

  // ✅ Staff (must be logged in)
  {
    path: 'staff',
    component: Shell,
    canMatch: [authGuard, roleGuard(['Staff', 'Admin'])],
    children: [
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/staff/dashboard/dashboard').then(
            (m) => m.Dashboard
          ),
      },
      {
        path: 'reservations',
        loadComponent: () =>
          import('./features/staff/reservations/reservations').then(
            (m) => m.Reservations
          ),
      },
      {
        path: 'reservations/new',
        loadComponent: () =>
          import('./features/staff/reservations-new/reservations-new').then(
            (m) => m.ReservationsNew
          ),
      },
      {
        path: 'check-in',
        loadComponent: () =>
          import('./features/staff/check-in/check-in').then((m) => m.CheckIn),
      },
      {
        path: 'events',
        loadComponent: () =>
          import('./features/staff/events/events').then((m) => m.StaffEvents),
      },
    ],
  },

  // ✅ Admin (must be logged in AND in Admin group)
  {
    path: 'admin',
    component: Shell,
    canMatch: [authGuard, roleGuard(['Admin'])],
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
        loadComponent: () =>
          import('./features/admin/financials/financials').then(
            (m) => m.Financials
          ),
      },
      {
        path: 'users',
        loadComponent: () =>
          import('./features/admin/users/users').then((m) => m.Users),
      },
      {
        path: 'events',
        loadComponent: () =>
          import('./features/admin/events/events').then((m) => m.Events),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/admin/settings/settings').then(
            (m) => m.AdminSettings
          ),
      },
      {
        path: 'frequent-clients',
        loadComponent: () =>
          import('./features/admin/frequent-clients/frequent-clients').then(
            (m) => m.FrequentClients
          ),
      },
      {
        path: 'clients',
        loadComponent: () =>
          import('./features/admin/clients/clients').then((m) => m.Clients),
      },
    ],
  },

  // 404
  {
    path: '**',
    loadComponent: () =>
      import('./features/public/not-found/not-found').then((m) => m.NotFound),
  },
];
