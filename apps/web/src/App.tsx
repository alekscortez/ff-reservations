import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthHealthBanner } from '@/components/auth-health-banner';
import { RequireAdmin, RequireStaffOrAdmin } from '@/components/route-guards';
import { StaffLayout } from '@/components/staff-layout';
import { Login } from '@/features/auth/login';
import { AuthCallback } from '@/features/auth/auth-callback';
import { Unauthorized } from '@/features/auth/unauthorized';
import { PublicMap } from '@/features/public/map';
import { StaffDashboard } from '@/features/staff/dashboard';
import { StaffEvents } from '@/features/staff/events';
import { EventForm } from '@/features/staff/event-form';
import { StaffFrequentClients } from '@/features/staff/frequent-clients';
import { FrequentClientForm } from '@/features/staff/frequent-client-form';
import { StaffReservations } from '@/features/staff/reservations';
import { ReservationDetail } from '@/features/staff/reservation-detail';
import { StaffPackages } from '@/features/staff/packages';
import { PackageForm } from '@/features/staff/package-form';
import { StaffHolds } from '@/features/staff/holds';
import { AdminUsers } from '@/features/admin/users';
import { AdminUserForm } from '@/features/admin/user-form';
import { AdminSettings } from '@/features/admin/settings';

function StaffShell() {
  return (
    <RequireStaffOrAdmin>
      <StaffLayout>
        <Outlet />
      </StaffLayout>
    </RequireStaffOrAdmin>
  );
}

function AdminShell() {
  return (
    <RequireAdmin>
      <StaffLayout>
        <Outlet />
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
          <Route
            path="/staff/reservations/:eventDate/:reservationId"
            element={<ReservationDetail />}
          />
          <Route path="/staff/packages" element={<StaffPackages />} />
          <Route path="/staff/packages/new" element={<PackageForm />} />
          <Route path="/staff/packages/:packageId/edit" element={<PackageForm />} />
          <Route path="/staff/holds" element={<StaffHolds />} />
        </Route>

        <Route element={<AdminShell />}>
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/users/new" element={<AdminUserForm />} />
          <Route path="/admin/settings" element={<AdminSettings />} />
        </Route>

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </>
  );
}
