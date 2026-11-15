// Admin screens (FR-14 … FR-22) of the Smart OPD Dashboard, for BRANCH_ADMIN / HOSPITAL_ADMIN.
// Loaded on demand by RootApp, together with the admin stylesheet.
import '../styles/index.css';
import '../styles/upgrade.css';
import App from '../App.jsx';
import { AuthProvider } from '../context/AuthContext.jsx';
import { ToastProvider } from '../context/ToastContext.jsx';

export default function AdminSection() {
  return (
    <ToastProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ToastProvider>
  );
}
