// Application shell: sidebar navigation + top bar (branch filter, live status, user menu).
// Navigation entries the current role cannot use are hidden (Section 3.2, Table 3.2).
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import Icon from './Icon.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useRealtime } from '../context/RealtimeContext.jsx';
import { ROLE_LABELS } from '../utils/roles.js';

const NAV = [
  {
    group: 'Monitoring',
    items: [
      { to: '/overview', label: 'Live Overview & Alerts', icon: 'overview' },
      { to: '/forecasts', label: 'Forecasts', icon: 'forecast' },
      { to: '/workload', label: 'Workload & Recommendations', icon: 'workload' },
      { to: '/reports', label: 'Reports', icon: 'reports' },
      { to: '/feedback', label: 'Feedback', icon: 'feedback' },
    ],
  },
  {
    group: 'Master data',
    items: [
      { to: '/branches', label: 'Branches', icon: 'branches' },
      { to: '/departments', label: 'Departments', icon: 'departments' },
      { to: '/doctors', label: 'Doctors', icon: 'doctors' },
      { to: '/schedules', label: 'Schedules', icon: 'schedules' },
      { to: '/service-points', label: 'Service Points', icon: 'servicePoints' },
      { to: '/users', label: 'Staff & Users', icon: 'users' },
    ],
  },
  {
    group: 'System',
    items: [
      { to: '/models', label: 'Model Management', icon: 'models', requires: 'manageModels' },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

const STATUS_TEXT = {
  live: { label: 'Live', title: 'Connected to the real-time channel' },
  connecting: { label: 'Connecting', title: 'Connecting to the real-time channel' },
  offline: { label: 'Polling', title: 'Real-time channel unavailable - refreshing every 20 seconds' },
};

function BranchFilter() {
  const { branches, branchId, setBranchId, locked, branchName, branchesLoading } = useScope();
  if (locked) {
    return (
      <div className="branch-filter locked" title="Branch administrators are limited to their own branch">
        <span className="branch-filter-label">Branch</span>
        <strong>{branchName}</strong>
      </div>
    );
  }
  return (
    <label className="branch-filter">
      <span className="branch-filter-label">Branch</span>
      <select
        value={branchId ?? ''}
        onChange={(e) => setBranchId(e.target.value || null)}
        disabled={branchesLoading}
        aria-label="Branch filter"
      >
        <option value="">All branches</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}{b.status === 'INACTIVE' ? ' (inactive)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function Layout() {
  const { user, permissions, logout } = useAuth();
  const { status } = useRealtime();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer after navigating.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  const st = STATUS_TEXT[status] || STATUS_TEXT.offline;
  const initials = (user?.fullName || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">+</span>
          <div className="brand-text">
            <strong>Smart OPD</strong>
            <span>Admin Dashboard</span>
          </div>
          <button type="button" className="icon-btn sidebar-close" onClick={() => setNavOpen(false)} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>
        <nav>
          {NAV.map((section) => {
            const items = section.items.filter((i) => !i.requires || permissions[i.requires]);
            if (!items.length) return null;
            return (
              <div className="nav-group" key={section.group}>
                <span className="nav-group-label">{section.group}</span>
                {items.map((item) => (
                  <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <span className="muted small">Smart Digital Queue Management System for Hospital OPD</span>
        </div>
      </aside>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <div className="main-col">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <Icon name="menu" />
          </button>
          <BranchFilter />
          <div className="topbar-spacer" />
          <span className={`live-chip live-${status}`} title={st.title}>
            <span className="live-dot" aria-hidden="true" />
            {st.label}
          </span>
          <div className="user-chip">
            <span className="avatar" aria-hidden="true">{initials}</span>
            <div className="user-meta">
              <strong>{user?.fullName}</strong>
              <span>{ROLE_LABELS[user?.role] || user?.role}</span>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => logout(false)} title="Sign out">
            <Icon name="logout" size={16} />
            <span className="hide-sm">Sign out</span>
          </button>
        </header>
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
