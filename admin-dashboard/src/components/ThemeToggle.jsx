// Theme switch for the top bar and the login page: Dark <-> Light (Decision 5, dark default).
// The icon shows the current theme; the accessible name says what the next click does.
import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { applyTheme, nextTheme, readTheme, storeTheme, THEME_LABELS } from '../utils/theme.js';

const ICON = { dark: 'moon', light: 'sun' };

export default function ThemeToggle({ className = '' }) {
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const next = nextTheme(theme);
  const toggle = () => {
    storeTheme(next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      className={`btn btn-ghost btn-icon theme-toggle ${className}`}
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`${THEME_LABELS[theme]} theme — switch to ${next}`}
      data-theme-current={theme}
    >
      <Icon name={ICON[theme]} size={18} />
    </button>
  );
}
