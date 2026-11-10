// ThemeToggle: System -> Light -> Dark cycle, localStorage persistence and <html data-theme>.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ThemeToggle, { THEME_KEY, applyTheme, nextTheme, readTheme, saveTheme } from '../components/ThemeToggle.jsx';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

let storage;
let root;

beforeEach(() => {
  storage = fakeStorage();
  root = { dataset: {} };
  vi.stubGlobal('window', { localStorage: storage });
  vi.stubGlobal('document', { documentElement: root });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThemeToggle', () => {
  it('cycles System -> Light -> Dark -> System', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });

  it('stores the choice under smartopd.theme and removes it for System', () => {
    expect(THEME_KEY).toBe('smartopd.theme');
    expect(readTheme()).toBe('system');
    saveTheme('light');
    expect(storage.getItem(THEME_KEY)).toBe('light');
    expect(readTheme()).toBe('light');
    saveTheme('dark');
    expect(readTheme()).toBe('dark');
    saveTheme('system');
    expect(storage.map.has(THEME_KEY)).toBe(false);
    expect(readTheme()).toBe('system');
  });

  it('ignores unknown stored values and survives storage errors', () => {
    storage.setItem(THEME_KEY, 'purple');
    expect(readTheme()).toBe('system');
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('denied');
      },
    });
    expect(readTheme()).toBe('system');
    expect(() => saveTheme('dark')).not.toThrow();
  });

  it('applies data-theme for Light / Dark and removes it for System', () => {
    applyTheme('dark');
    expect(root.dataset.theme).toBe('dark');
    applyTheme('light');
    expect(root.dataset.theme).toBe('light');
    applyTheme('system');
    expect('theme' in root.dataset).toBe(false);
  });

  it('labels the button with the next theme', () => {
    expect(renderToStaticMarkup(<ThemeToggle />)).toContain('aria-label="Switch to light theme"');
    storage.setItem(THEME_KEY, 'light');
    expect(renderToStaticMarkup(<ThemeToggle />)).toContain('aria-label="Switch to dark theme"');
    storage.setItem(THEME_KEY, 'dark');
    expect(renderToStaticMarkup(<ThemeToggle />)).toContain('aria-label="Switch to system theme"');
  });
});
