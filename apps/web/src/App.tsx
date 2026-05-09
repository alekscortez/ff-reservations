import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthHealthBanner } from '@/components/auth-health-banner';
import { RequireStaffOrAdmin } from '@/components/route-guards';
import { Login } from '@/features/auth/login';
import { AuthCallback } from '@/features/auth/auth-callback';
import { Unauthorized } from '@/features/auth/unauthorized';
import { StaffDashboard } from '@/features/staff/dashboard';
import { StaffEvents } from '@/features/staff/events';
import { EventForm } from '@/features/staff/event-form';
import { StaffFrequentClients } from '@/features/staff/frequent-clients';
import { FrequentClientForm } from '@/features/staff/frequent-client-form';
import { StaffReservations } from '@/features/staff/reservations';
import { StaffPackages } from '@/features/staff/packages';
import { PackageForm } from '@/features/staff/package-form';
import { StaffHolds } from '@/features/staff/holds';

export function App() {
  return (
    <>
      <AuthHealthBanner />
      <Routes>
        <Route path="/" element={<Navigate to="/staff/dashboard" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/unauthorized" element={<Unauthorized />} />
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
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </>
  );
}
