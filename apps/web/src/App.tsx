import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthHealthBanner } from '@/components/auth-health-banner';
import { RequireAdmin, RequireStaffOrAdmin } from '@/components/route-guards';
import { StaffLayout } from '@/components/staff-layout';
import { Login } from '@/features/auth/login';
import { AuthCallback } from '@/features/auth/auth-callback';
import { Unauthorized } from '@/features/auth/unauthorized';
import { PublicMap } from '@/features/public/map';

// Lazy-loaded — heavy QR / camera deps shouldn't be in the main bundle.
const CheckInPassPage = lazy(() =>
  import('@/features/public/check-in-pass').then((m) => ({ default: m.CheckInPassPage }))
);
const StaffCheckIn = lazy(() =>
  import('@/features/staff/check-in').then((m) => ({ default: m.StaffCheckIn }))
);
import { StaffDashboard } from '@/features/staff/dashboard';
import { StaffEvents } from '@/features/staff/events';
import { EventForm } from '@/features/staff/event-form';
import { StaffFrequentClients } from '@/features/staff/frequent-clients';
import { FrequentClientForm } from '@/features/staff/frequent-client-form';
import { StaffReservations } from '@/features/staff/reservations';
import { ReservationDetail } from '@/features/staff/reservation-detail';
import { ReservationNew } from '@/features/staff/reservation-new';
import { StaffPackages } from '@/features/staff/packages';
import { PackageForm } from '@/features/staff/package-form';
import { StaffHolds } from '@/features/staff/holds';
import { StaffClients } from '@/features/staff/clients';
import { AdminUsers } from '@/features/admin/users';
import { AdminUserForm } from '@/features/admin/user-form';
import { AdminSettings } from '@/features/admin/settings';
import { AdminFinancials } from '@/features/admin/financials';

function LazyFallback() {
  const { t } = useTranslation();
  return (
    <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>
  );
}

function StaffShell() {
  return (
    <RequireStaffOrAdmin>
      <StaffLayout>
        <Suspense fallback={<LazyFallback />}>
          <Outlet />
        </Suspense>
      </StaffLayout>
    </RequireStaffOrAdmin>
  );
}

function AdminShell() {
  return (
    <RequireAdmin>
      <StaffLayout>
        <Suspense fallback={<LazyFallback />}>
          <Outlet />
        </Suspense>
      </StaffLayout>
    </RequireAdmin>
  );
}

export function App() {
  return (
    <>
      <AuthHealthBanner />
      <Routes>
        <Route path="/" element={<Navigate to="/staff/dashboard" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/unauthorized" element={<Unauthorized />} />
        <Route path="/map" element={<PublicMap />} />
        <Route path="/availability" element={<PublicMap />} />
        <Route
          path="/check-in/pass"
          element={
            <Suspense fallback={<LazyFallback />}>
              <CheckInPassPage />
            </Suspense>
          }
        />

        <Route element={<StaffShell />}>
          <Route path="/staff/dashboard" element={<StaffDashboard />} />
          <Route path="/staff/events" element={<StaffEvents />} />
          <Route path="/staff/events/new" element={<EventForm />} />
          <Route path="/staff/events/:eventId/edit" element={<EventForm />} />
          <Route path="/staff/frequent-clients" element={<StaffFrequentClients />} />
          <Route path="/staff/frequent-clients/new" element={<FrequentClientForm />} />
          <Route
            path="/staff/frequent-clients/:clientId/edit"
            element={<FrequentClientForm />}
          />
          <Route path="/staff/reservations" element={<StaffReservations />} />
          <Route path="/staff/reservations/new" element={<ReservationNew />} />
          <Route
            path="/staff/reservations/:eventDate/:reservationId"
            element={<ReservationDetail />}
          />
          <Route path="/staff/packages" element={<StaffPackages />} />
          <Route path="/staff/packages/new" element={<PackageForm />} />
          <Route path="/staff/packages/:packageId/edit" element={<PackageForm />} />
          <Route path="/staff/holds" element={<StaffHolds />} />
          <Route path="/staff/clients" element={<StaffClients />} />
          <Route path="/staff/check-in" element={<StaffCheckIn />} />
        </Route>

        <Route element={<AdminShell />}>
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/users/new" element={<AdminUserForm />} />
          <Route path="/admin/settings" element={<AdminSettings />} />
          <Route path="/admin/financials" element={<AdminFinancials />} />
        </Route>

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </>
  );
}
