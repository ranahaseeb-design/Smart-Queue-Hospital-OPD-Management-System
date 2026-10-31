import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import Spinner from '../components/Spinner.jsx';

/** Route guard: renders children only for a signed-in STAFF user. */
export default function RequireAuth({ children }) {
  const { token, user, checking } = useAuth();
  const location = useLocation();

  if (!token || !user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (checking) return <Spinner fullPage label="Checking your session…" />;
  return children;
}
