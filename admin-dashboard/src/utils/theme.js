// Theme preference — "Clinical Night" (docs/UPGRADE_2026.md, Decision 5).
// Two states, Dark <-> Light. Dark is the default; the OS colour scheme is NOT followed.
// The choice is stored in localStorage["smartopd.theme"] ("dark" | "light"); anything else,
// nothing stored or blocked storage -> dark. It is applied as <html data-theme="dark|light">.
// index.html applies the stored theme with an inline script before the first paint (same rules),
// and every storage access is wrapped in try/catch (private mode, blocked storage).

export const THEME_KEY = 'smartopd.theme';
export const THEMES = ['dark', 'light'];
export const DEFAULT_THEME = 'dark';
export const THEME_LABELS = { dark: 'Dark', light: 'Light' };

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Normalises any value to a valid theme: 'light' stays light, everything else is dark. */
export function normaliseTheme(value) {
  return value === 'light' ? 'light' : DEFAULT_THEME;
}

/** The other theme (Dark <-> Light). Unknown input counts as dark, so the next one is light. */
export function nextTheme(theme) {
  return normaliseTheme(theme) === 'dark' ? 'light' : 'dark';
}

/** Stored preference; 'dark' when nothing valid is stored or storage is unavailable. */
export function readTheme(storage = defaultStorage()) {
  try {
    return normaliseTheme(storage?.getItem(THEME_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function storeTheme(theme, storage = defaultStorage()) {
  try {
    storage?.setItem(THEME_KEY, normaliseTheme(theme));
  } catch {
    /* storage unavailable: the choice lasts for this page view only */
  }
}

/** Sets <html data-theme> (always present, so CSS and the chart observer see every change). */
export function applyTheme(theme, root = globalThis.document?.documentElement) {
  if (!root) return;
  root.dataset.theme = normaliseTheme(theme);
}
