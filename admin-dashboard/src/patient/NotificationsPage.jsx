// In-app notifications (FR-11): token issued, turn approaching, called, estimate changes,
// appointment confirmations and reminders. Opening the page marks them read; new ones arrive live.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePatient } from './PatientContext.jsx';
import { errorText, papi } from './patientApi.js';
import { slotText } from './explain.js';

export default function NotificationsPage() {
  const { onLive, refreshUnread } = usePatient();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const list = await papi.notifications();
      setRows(list);
      setError(null);
      if (list.some((n) => !n.isRead)) {
        await papi.readAllNotifications();
        refreshUnread();
      }
    } catch (err) {
      setError(errorText(err));
    }
  }, [refreshUnread]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onLive((event) => event === 'notification' && load()), [onLive, load]);

  return (
    <div className="pt-page">
      <section className="pt-card" aria-label="Notifications">
        <h2 className="pt-step-title">Notifications</h2>
        {error && <p className="pt-error" role="alert">{error}</p>}
        {!rows && !error && <div className="pt-skeleton pt-skeleton--cards" aria-label="Loading notifications" />}
        {rows && rows.length === 0 && <p className="pt-muted">No notifications yet. You will see your token updates and appointment reminders here.</p>}
        <ul className="pt-notes">
          {(rows || []).map((n) => (
            <li key={n.id} className={`pt-note${n.isRead ? '' : ' is-new'}`}>
              <span className="pt-note-dot" aria-hidden="true" />
              <div className="pt-list-main">
                <span>{n.message}</span>
                <span className="pt-muted pt-small">
                  {slotText(n.sentAt)}
                  {!n.isRead && ' · new'}
                  {n.tokenId ? <> · <Link className="pt-link" to={`/token/${n.tokenId}`}>View token</Link></> : null}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
