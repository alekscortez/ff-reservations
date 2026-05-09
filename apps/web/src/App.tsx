import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthHealthBanner } from '@/components/auth-health-banner';
import { RequireStaffOrAdmin } from '@/components/route-guards';
import { Login } from '@/features/auth/login';
import { AuthCallback } from '@/features/auth/auth-callback';
import { Unauthorized } from '@/features/auth/unauthorized';
import { StaffDashboard } from '@/features/staff/dashboard';
import { StaffEvents } from '@/features/staff/events';

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
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </>
  );
}
