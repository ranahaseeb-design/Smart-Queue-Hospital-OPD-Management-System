// Theme switcher (design system "Theming"): cycles System -> Light -> Dark.
// The choice is stored under `smartopd.theme` and applied as <html data-theme>; System removes the
// attribute so tokens.css follows prefers-color-scheme. index.html applies it before React renders.
import { useState } from 'react';
import Icon from './Icon.jsx';

export const THEME_KEY = 'smartopd.theme';
const ORDER = ['system', 'light', 'dark'];
const LABELS = { system: 'system', light: 'light', dark: 'dark' };
const ICONS = { system: 'monitor', light: 'sun', dark: 'moon' };

export function nextTheme(mode) {
  const i = ORDER.indexOf(mode);
  return ORDER[(i + 1) % ORDER.length];
}

export function readTheme() {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(mode) {
  try {
    if (mode === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

export function applyTheme(mode) {
  try {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
    else delete root.dataset.theme;
  } catch {
    /* no DOM (tests / SSR) */
  }
}

export default function ThemeToggle() {
  const [mode, setMode] = useState(readTheme);
  const next = nextTheme(mode);

  function cycle() {
    saveTheme(next);
    applyTheme(next);
    setMode(next);
  }

  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon theme-toggle"
      onClick={cycle}
      aria-label={`Switch to ${LABELS[next]} theme`}
      title={`Theme: ${LABELS[mode]} (switch to ${LABELS[next]})`}
      data-theme-mode={mode}
    >
      <Icon name={ICONS[mode]} />
    </button>
  );
}
