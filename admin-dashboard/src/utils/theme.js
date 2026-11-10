// Theme preference (System -> Light -> Dark). The choice is stored in localStorage under
// `smartopd.theme` and applied as <html data-theme="light|dark">; "system" removes the attribute
// so tokens.css follows prefers-color-scheme. Every storage access is wrapped in try/catch
// (private mode, blocked storage). index.html applies the stored theme before React renders.

export const THEME_KEY = 'smartopd.theme';
export const THEMES = ['system', 'light', 'dark'];
export const THEME_LABELS = { system: 'system', light: 'light', dark: 'dark' };

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The next theme in the cycle System -> Light -> Dark -> System. */
export function nextTheme(theme) {
  const i = THEMES.indexOf(theme);
  return THEMES[(i + 1) % THEMES.length] || 'system';
}

/** Stored preference, or 'system' when nothing (or something invalid) is stored. */
export function readTheme(storage = defaultStorage()) {
  try {
    const v = storage?.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function storeTheme(theme, storage = defaultStorage()) {
  try {
    if (theme === 'light' || theme === 'dark') storage?.setItem(THEME_KEY, theme);
    else storage?.removeItem(THEME_KEY);
  } catch {
    /* storage unavailable: the choice lasts for this page view only */
  }
}

export function applyTheme(theme, root = globalThis.document?.documentElement) {
  if (!root) return;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}
