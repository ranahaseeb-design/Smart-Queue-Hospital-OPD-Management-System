import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyTheme, DEFAULT_THEME, nextTheme, normaliseTheme, readTheme, storeTheme, THEME_KEY, THEMES,
} from './theme.js';
import { peakRanges } from './chartTheme.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

const throwingStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};

describe('theme toggle: Dark <-> Light, dark default (Decision 5)', () => {
  it('has exactly two themes and dark is the default', () => {
    expect(THEMES).toEqual(['dark', 'light']);
    expect(DEFAULT_THEME).toBe('dark');
    expect(THEME_KEY).toBe('smartopd.theme');
  });

  it('toggles Dark -> Light -> Dark; unknown values count as dark', () => {
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme(undefined)).toBe('light');
  });

  it('normalises anything that is not "light" to dark', () => {
    expect(normaliseTheme('light')).toBe('light');
    ['dark', 'system', 'purple', '', null, undefined, 1].forEach((v) => expect(normaliseTheme(v)).toBe('dark'));
  });

  it('stores the choice under smartopd.theme and reads it back', () => {
    const storage = memoryStorage();
    expect(readTheme(storage)).toBe('dark');
    storeTheme('light', storage);
    expect(storage.data[THEME_KEY]).toBe('light');
    expect(readTheme(storage)).toBe('light');
    storeTheme('dark', storage);
    expect(storage.data[THEME_KEY]).toBe('dark');
    expect(readTheme(storage)).toBe('dark');
  });

  it('a toggle round trip alternates light and dark', () => {
    const storage = memoryStorage();
    let theme = readTheme(storage);
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      theme = nextTheme(theme);
      storeTheme(theme, storage);
      seen.push(readTheme(storage));
    }
    expect(seen).toEqual(['light', 'dark', 'light']);
  });

  it('falls back to dark for invalid or legacy values and survives blocked storage', () => {
    expect(readTheme(memoryStorage({ [THEME_KEY]: 'purple' }))).toBe('dark');
    expect(readTheme(memoryStorage({ [THEME_KEY]: 'system' }))).toBe('dark');
    expect(readTheme(throwingStorage)).toBe('dark');
    expect(() => storeTheme('light', throwingStorage)).not.toThrow();
    expect(readTheme(undefined)).toBe('dark');
  });

  it('always sets data-theme on the root', () => {
    const root = { dataset: {} };
    applyTheme('light', root);
    expect(root.dataset.theme).toBe('light');
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('bogus', root);
    expect(root.dataset.theme).toBe('dark');
    expect(() => applyTheme('dark', null)).not.toThrow();
  });
});

describe('index.html theme boot script (before first paint)', () => {
  const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
  const script = /<script id="theme-boot">([\s\S]*?)<\/script>/.exec(html)?.[1];

  function boot(localStorage) {
    const attrs = {};
    const document = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
    // eslint-disable-next-line no-new-func
    new Function('localStorage', 'document', script)(localStorage, document);
    return attrs['data-theme'];
  }

  it('is inline in <head> and defaults the root to dark', () => {
    expect(script).toBeTruthy();
    expect(html).toMatch(/<html lang="en" data-theme="dark">/);
    expect(html.indexOf('theme-boot')).toBeLessThan(html.indexOf('</head>'));
  });

  it('applies light only when light is stored, dark otherwise, and tolerates blocked storage', () => {
    expect(boot(memoryStorage({ [THEME_KEY]: 'light' }))).toBe('light');
    expect(boot(memoryStorage({ [THEME_KEY]: 'dark' }))).toBe('dark');
    expect(boot(memoryStorage({ [THEME_KEY]: 'system' }))).toBe('dark');
    expect(boot(memoryStorage())).toBe('dark');
    expect(boot(throwingStorage)).toBe('dark');
  });
});

describe('forecast peak bands', () => {
  it('groups consecutive peak hours into one band', () => {
    const points = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00'].map((hour, i) => ({ hour, isPeak: [1, 2, 4].includes(i) }));
    expect(peakRanges(points)).toEqual([{ x1: '09:00', x2: '10:00' }, { x1: '12:00', x2: '12:00' }]);
    expect(peakRanges([])).toEqual([]);
  });

  it('accepts a custom marker (peak or shortfall hours)', () => {
    const points = [{ hour: '08:00', s: 0 }, { hour: '09:00', s: 1 }, { hour: '10:00', s: 2 }];
    expect(peakRanges(points, (p) => p.s > 0)).toEqual([{ x1: '09:00', x2: '10:00' }]);
  });
});
