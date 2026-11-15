// Doctor / staff screens (FR-04, FR-12, FR-13) of the Smart OPD Dashboard, for STAFF accounts.
// The code lives in staff-dashboard/src (alias @staff, see vite.config.js); loaded on demand by
// RootApp together with the staff stylesheet, so the two sections' styles never mix.
import '@staff/styles/index.css';
import App from '@staff/App.jsx';
import { AuthProvider } from '@staff/auth/AuthContext.jsx';
import { ServicePointsProvider } from '@staff/auth/ServicePointsContext.jsx';
import { ToastProvider } from '@staff/components/Toast.jsx';

export default function StaffSection() {
  return (
    <ToastProvider>
      <AuthProvider>
        <ServicePointsProvider>
          <App />
        </ServicePointsProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
