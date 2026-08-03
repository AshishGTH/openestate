import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import ForceChangePassword from '../pages/ForceChangePassword';

export default function ProtectedRoute() {
  const { user, isLoading, logout } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-500">Loading…</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  // forceChangePassword revokes every session (including this one) on
  // success — there's no valid token to continue with afterward, so the
  // only correct move is to sign out and send them through a fresh login
  // with the new password, not try to silently resume.
  if (user.forcePasswordChange) {
    return <ForceChangePassword onDone={() => void logout()} />;
  }

  return <Outlet />;
}
