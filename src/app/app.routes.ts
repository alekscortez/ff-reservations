import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { roleGuard } from './core/guards/role.guard';
import { Shell } from './core/layout/shell/shell';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },

  // Public
  {
    path: 'home',
    loadComponent: () =>
      import('./features/public/home/home').then((m) => m.Home),
  },
  {
    path: 'unauthorized',
    loadComponent: () =>
      import('./features/public/unauthorized/unauthorized').then(
        (m) => m.Unauthorized
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
    ],
  },

  // ✅ Admin (must be logged in AND in Admin group)
  {
    path: 'admin',
    component: Shell,
    canMatch: [authGuard, roleGuard(['Admin'])],
    children: [
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/admin/admin-dashboard/admin-dashboard').then(
            (m) => m.AdminDashboard
          ),
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
    ],
  },

  // 404
  {
    path: '**',
    loadComponent: () =>
      import('./features/public/not-found/not-found').then((m) => m.NotFound),
  },
];
