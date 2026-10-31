// Lightweight toast notifications for success / error / warning feedback.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../api/client.js';

const ToastContext = createContext(null);
const ICONS = { success: '✓', error: '!', warning: '▲', info: 'i' };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((type, message, { title, duration } = {}) => {
    const id = nextId.current++;
    const ttl = duration ?? (type === 'error' || type === 'warning' ? 7000 : 4000);
    setToasts((list) => [...list.slice(-4), { id, type, message, title }]);
    if (ttl > 0) setTimeout(() => dismiss(id), ttl);
    return id;
  }, [dismiss]);

  const toast = useMemo(() => ({
    success: (msg, opts) => push('success', msg, opts),
    info: (msg, opts) => push('info', msg, opts),
    warning: (msg, opts) => push('warning', msg, opts),
    error: (errOrMsg, opts) => push('error', typeof errOrMsg === 'string' ? errOrMsg : errorMessage(errOrMsg), opts),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
            <span className="toast-icon" aria-hidden="true">{ICONS[t.type]}</span>
            <div className="toast-body">
              {t.title && <strong className="toast-title">{t.title}</strong>}
              <span>{t.message}</span>
            </div>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
