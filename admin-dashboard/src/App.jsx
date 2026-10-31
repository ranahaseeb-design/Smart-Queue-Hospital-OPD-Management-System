// Route table for the Admin Dashboard (screens of Table 4.19, Section 4.12).
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import { ScopeProvider } from './context/ScopeContext.jsx';
import { RealtimeProvider } from './context/RealtimeContext.jsx';
import Layout from './components/Layout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import BranchesPage from './pages/BranchesPage.jsx';
import DepartmentsPage from './pages/DepartmentsPage.jsx';
import DoctorsPage from './pages/DoctorsPage.jsx';
import SchedulesPage from './pages/SchedulesPage.jsx';
import ServicePointsPage from './pages/ServicePointsPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import ForecastsPage from './pages/ForecastsPage.jsx';
import WorkloadPage from './pages/WorkloadPage.jsx';
import FeedbackPage from './pages/FeedbackPage.jsx';
import ModelsPage from './pages/ModelsPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

/** Authenticated shell: scope (branch filter) + socket connection + layout. */
function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return (
    <ScopeProvider>
      <RealtimeProvider>
        <Layout />
      </RealtimeProvider>
    </ScopeProvider>
  );
}

/** Hospital-admin-only screens (Section 3.2: model retraining). Branch admins are redirected. */
function HospitalAdminOnly({ children }) {
  const { permissions } = useAuth();
  return permissions.manageModels ? children : <Navigate to="/overview" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="branches" element={<BranchesPage />} />
        <Route path="departments" element={<DepartmentsPage />} />
        <Route path="doctors" element={<DoctorsPage />} />
        <Route path="schedules" element={<SchedulesPage />} />
        <Route path="service-points" element={<ServicePointsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="forecasts" element={<ForecastsPage />} />
        <Route path="workload" element={<WorkloadPage />} />
        <Route path="feedback" element={<FeedbackPage />} />
        <Route path="models" element={<HospitalAdminOnly><ModelsPage /></HospitalAdminOnly>} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
