// Theme switch for the top bar: cycles System -> Light -> Dark. The icon shows the current mode;
// the accessible name says what the next click does.
import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { applyTheme, nextTheme, readTheme, storeTheme } from '../utils/theme.js';

const ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
const CURRENT = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };

export default function ThemeToggle({ className = '' }) {
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const next = nextTheme(theme);
  const cycle = () => {
    storeTheme(next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      className={`btn btn-ghost btn-icon theme-toggle ${className}`}
      onClick={cycle}
      aria-label={`Switch to ${next} theme`}
      title={`${CURRENT[theme]} — switch to ${next}`}
    >
      <Icon name={ICON[theme]} size={18} />
    </button>
  );
}
