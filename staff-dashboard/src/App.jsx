// Routes of the Staff Dashboard (Table 4.19): Login -> (service-point picker) -> My Queue.
import { Navigate, Route, Routes } from 'react-router-dom';
import RequireAuth from './auth/RequireAuth.jsx';
import LoginPage from './pages/LoginPage.jsx';
import QueuePage from './pages/QueuePage.jsx';
import SelectServicePointPage from './pages/SelectServicePointPage.jsx';
import StartPage from './pages/StartPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <StartPage />
          </RequireAuth>
        }
      />
      <Route
        path="/select"
        element={
          <RequireAuth>
            <SelectServicePointPage />
          </RequireAuth>
        }
      />
      <Route
        path="/queue/:servicePointId"
        element={
          <RequireAuth>
            <QueuePage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
