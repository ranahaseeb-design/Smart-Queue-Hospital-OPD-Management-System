// Theme switcher (Upgrade 2026, Decision 5 "Clinical Night"): two states, Dark <-> Light.
// Dark is the default; the choice is stored under `smartopd.theme` ("dark" | "light") and applied as
// <html data-theme="…">. Anything else, a missing value or blocked storage means dark. The OS colour
// scheme is no longer followed. index.html applies the same rule before React renders (no flash).
import { useState } from 'react';
import Icon from './Icon.jsx';

export const THEME_KEY = 'smartopd.theme';
export const DEFAULT_THEME = 'dark';

/** The other theme: dark -> light, light -> dark (unknown values count as dark). */
export function nextTheme(mode) {
  return normalizeTheme(mode) === 'dark' ? 'light' : 'dark';
}

/** "light" stays light; everything else (missing, unknown, legacy "system") is dark. */
export function normalizeTheme(value) {
  return value === 'light' ? 'light' : DEFAULT_THEME;
}

export function readTheme() {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveTheme(mode) {
  try {
    window.localStorage.setItem(THEME_KEY, normalizeTheme(mode));
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

export function applyTheme(mode) {
  try {
    document.documentElement.dataset.theme = normalizeTheme(mode);
  } catch {
    /* no DOM (tests / SSR) */
  }
}

export default function ThemeToggle() {
  const [mode, setMode] = useState(readTheme);
  const next = nextTheme(mode);

  function toggle() {
    saveTheme(next);
    applyTheme(next);
    setMode(next);
  }

  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Theme: ${mode} (switch to ${next})`}
      data-theme-mode={mode}
    >
      {/* The icon shows the theme you switch to. */}
      <Icon name={next === 'light' ? 'sun' : 'moon'} />
    </button>
  );
}
