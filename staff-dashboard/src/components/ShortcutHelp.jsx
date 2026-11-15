// List of the console's keyboard shortcuts (opened with "?" or the Shortcuts button).
import Modal from './Modal.jsx';
import { SHORTCUTS } from '../utils/shortcuts.js';

export default function ShortcutHelp({ onClose }) {
  return (
    <Modal
      title="Keyboard shortcuts"
      description="Single keys, ignored while you type in a field or while a dialog is open."
      onClose={onClose}
      size="sm"
      footer={
        <button type="button" className="btn btn--primary" onClick={onClose} data-autofocus>
          Close
        </button>
      }
    >
      <dl className="shortcut-list">
        {SHORTCUTS.map((s) => (
          <div key={s.action} className="shortcut-row">
            <dt>
              <kbd>{s.keys}</kbd>
            </dt>
            <dd>{s.label}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
