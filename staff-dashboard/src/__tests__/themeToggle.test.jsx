// ThemeToggle (Decision 5): Dark <-> Light, default dark, localStorage persistence and <html data-theme>.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import ThemeToggle, {
  DEFAULT_THEME,
  THEME_KEY,
  applyTheme,
  nextTheme,
  normalizeTheme,
  readTheme,
  saveTheme,
} from '../components/ThemeToggle.jsx';

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
  it('has two states: Dark <-> Light, dark by default', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('system')).toBe('light'); // legacy value counts as dark
  });

  it('stores the choice under smartopd.theme', () => {
    expect(THEME_KEY).toBe('smartopd.theme');
    expect(readTheme()).toBe('dark');
    saveTheme('light');
    expect(storage.getItem(THEME_KEY)).toBe('light');
    expect(readTheme()).toBe('light');
    saveTheme('dark');
    expect(storage.getItem(THEME_KEY)).toBe('dark');
    expect(readTheme()).toBe('dark');
  });

  it('treats unknown / missing values and storage errors as dark', () => {
    expect(normalizeTheme(undefined)).toBe('dark');
    storage.setItem(THEME_KEY, 'purple');
    expect(readTheme()).toBe('dark');
    storage.setItem(THEME_KEY, 'system');
    expect(readTheme()).toBe('dark');
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('denied');
      },
    });
    expect(readTheme()).toBe('dark');
    expect(() => saveTheme('light')).not.toThrow();
  });

  it('always applies data-theme (the OS scheme is not followed)', () => {
    applyTheme('light');
    expect(root.dataset.theme).toBe('light');
    applyTheme('dark');
    expect(root.dataset.theme).toBe('dark');
    applyTheme('nonsense');
    expect(root.dataset.theme).toBe('dark');
  });

  it('labels the button with the other theme', () => {
    expect(renderToStaticMarkup(<ThemeToggle />)).toContain('aria-label="Switch to light theme"');
    storage.setItem(THEME_KEY, 'light');
    expect(renderToStaticMarkup(<ThemeToggle />)).toContain('aria-label="Switch to dark theme"');
  });

  it('index.html applies the same rule before first paint', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain("localStorage.getItem('smartopd.theme') === 'light'");
    expect(html).toMatch(/var t = 'dark'/);
    expect(html).toMatch(/try \{/);
  });
});
