import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthHealthBanner } from '@/components/auth-health-banner';
import { RequireAdmin, RequireStaffOrAdmin } from '@/components/route-guards';
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
          path="/staff/dashboard"
          element={
            <RequireStaffOrAdmin>
              <StaffDashboard />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/events"
          element={
            <RequireStaffOrAdmin>
              <StaffEvents />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/events/new"
          element={
            <RequireStaffOrAdmin>
              <EventForm />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/events/:eventId/edit"
          element={
            <RequireStaffOrAdmin>
              <EventForm />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/frequent-clients"
          element={
            <RequireStaffOrAdmin>
              <StaffFrequentClients />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/frequent-clients/new"
          element={
            <RequireStaffOrAdmin>
              <FrequentClientForm />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/frequent-clients/:clientId/edit"
          element={
            <RequireStaffOrAdmin>
              <FrequentClientForm />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/reservations"
          element={
            <RequireStaffOrAdmin>
              <StaffReservations />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/reservations/:eventDate/:reservationId"
          element={
            <RequireStaffOrAdmin>
              <ReservationDetail />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/packages"
          element={
            <RequireStaffOrAdmin>
              <StaffPackages />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/packages/new"
          element={
            <RequireStaffOrAdmin>
              <PackageForm />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/packages/:packageId/edit"
          element={
            <RequireStaffOrAdmin>
              <PackageForm />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/staff/holds"
          element={
            <RequireStaffOrAdmin>
              <StaffHolds />
            </RequireStaffOrAdmin>
          }
        />
        <Route
          path="/admin/users"
          element={
            <RequireAdmin>
              <AdminUsers />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/users/new"
          element={
            <RequireAdmin>
              <AdminUserForm />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </>
  );
}
