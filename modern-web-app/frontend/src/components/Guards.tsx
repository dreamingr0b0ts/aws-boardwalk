import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Spinner } from './Ui';

export function RequireAuth() {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) return <Spinner label="Checking session…" />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <Outlet />;
}

export function RequireAdmin() {
  const { user, ready } = useAuth();

  if (!ready) return <Spinner label="Checking session…" />;
  if (!user) return <Navigate to="/login" state={{ from: '/admin' }} replace />;
  if (!user.isAdmin) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}
