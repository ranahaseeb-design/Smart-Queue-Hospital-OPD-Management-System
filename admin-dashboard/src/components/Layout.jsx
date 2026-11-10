// Application shell: sidebar navigation + top bar (page title, branch filter, live status, theme,
// user menu). Navigation entries the current role cannot use are hidden (Section 3.2, Table 3.2).
// Under 960px the sidebar becomes an off-canvas drawer.
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import Icon from './Icon.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useRealtime } from '../context/RealtimeContext.jsx';
import { ROLE_LABELS } from '../utils/roles.js';

const NAV = [
  {
    group: 'Operations',
    items: [
      { to: '/overview', label: 'Overview', icon: 'overview' },
      { to: '/forecasts', label: 'Forecasts', icon: 'forecast' },
      { to: '/workload', label: 'Workload', icon: 'workload' },
    ],
  },
  {
    group: 'Master data',
    items: [
      { to: '/branches', label: 'Branches', icon: 'branches' },
      { to: '/departments', label: 'Departments', icon: 'departments' },
      { to: '/doctors', label: 'Doctors', icon: 'doctors' },
      { to: '/schedules', label: 'Schedules', icon: 'schedules' },
      { to: '/service-points', label: 'Service points', icon: 'servicePoints' },
      { to: '/users', label: 'Staff & users', icon: 'users' },
    ],
  },
  {
    group: 'Insights',
    items: [
      { to: '/reports', label: 'Reports', icon: 'reports' },
      { to: '/feedback', label: 'Feedback', icon: 'feedback' },
    ],
  },
  {
    group: 'System',
    items: [
      { to: '/models', label: 'Model management', icon: 'models', requires: 'manageModels' },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

const STATUS_TEXT = {
  live: { label: 'Live', title: 'Connected to the real-time channel' },
  connecting: { label: 'Reconnecting', title: 'Connecting to the real-time channel' },
  offline: { label: 'Offline', title: 'Real-time channel unavailable - refreshing every 20 seconds' },
};

function currentPage(pathname) {
  for (const section of NAV) {
    const item = section.items.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
    if (item) return { group: section.group, label: item.label };
  }
  return null;
}

function BranchFilter() {
  const { branches, branchId, setBranchId, locked, branchName, branchesLoading } = useScope();
  if (locked) {
    return (
      <div className="branch-filter locked" title="Branch administrators are limited to their own branch">
        <Icon name="branches" size={16} />
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

function UserMenu({ user, onSignOut }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const initials = (user?.fullName || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const role = ROLE_LABELS[user?.role] || user?.role;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="avatar" aria-hidden="true">{initials}</span>
        <span className="user-meta">
          <strong>{user?.fullName}</strong>
          <span>{role}</span>
        </span>
        <Icon name="chevronDown" size={14} className="user-chevron" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <strong>{user?.fullName}</strong>
            <span>{user?.email || role}</span>
            <span className="badge badge-primary">{role}</span>
          </div>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onSignOut(); }}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, permissions, logout } = useAuth();
  const { status } = useRealtime();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer after navigating.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const st = STATUS_TEXT[status] || STATUS_TEXT.offline;
  const page = currentPage(location.pathname);

  return (
    <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <div className="brand-text">
            <strong>Smart OPD</strong>
            <span>Admin Dashboard</span>
          </div>
          <button type="button" className="btn btn-ghost btn-icon btn-sm sidebar-close" onClick={() => setNavOpen(false)} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>
        <nav className="nav">
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
          Smart Digital Queue Management System for Hospital OPD
        </div>
      </aside>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <div className="main-col">
        <header className="topbar">
          <button type="button" className="btn btn-ghost btn-icon menu-btn" onClick={() => setNavOpen(true)} aria-label="Open menu" aria-expanded={navOpen}>
            <Icon name="menu" />
          </button>
          {page && (
            <div className="topbar-title">
              <span className="topbar-group">{page.group}</span>
              <Icon name="chevronRight" size={14} className="topbar-sep" />
              <strong>{page.label}</strong>
            </div>
          )}
          <div className="topbar-spacer" />
          <BranchFilter />
          <span className={`live-chip live-${status}`} title={st.title} role="status">
            <span className="live-dot" aria-hidden="true" />
            <span className="live-label">{st.label}</span>
          </span>
          <ThemeToggle />
          <UserMenu user={user} onSignOut={() => logout(false)} />
        </header>
        <main className="content" id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
