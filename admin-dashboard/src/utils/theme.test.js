import { describe, expect, it } from 'vitest';
import { applyTheme, nextTheme, readTheme, storeTheme, THEME_KEY } from './theme.js';
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

describe('ThemeToggle cycle and storage', () => {
  it('cycles System -> Light -> Dark -> System', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
    expect(nextTheme('bogus')).toBe('system');
  });

  it('stores light/dark under smartopd.theme and removes the key for system', () => {
    const storage = memoryStorage();
    expect(THEME_KEY).toBe('smartopd.theme');
    storeTheme('light', storage);
    expect(storage.data[THEME_KEY]).toBe('light');
    expect(readTheme(storage)).toBe('light');
    storeTheme('dark', storage);
    expect(readTheme(storage)).toBe('dark');
    storeTheme('system', storage);
    expect(THEME_KEY in storage.data).toBe(false);
    expect(readTheme(storage)).toBe('system');
  });

  it('a full toggle round trip ends back on system with nothing stored', () => {
    const storage = memoryStorage();
    let theme = readTheme(storage);
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      theme = nextTheme(theme);
      storeTheme(theme, storage);
      seen.push(readTheme(storage));
    }
    expect(seen).toEqual(['light', 'dark', 'system']);
    expect(storage.data).toEqual({});
  });

  it('ignores invalid stored values and survives blocked storage', () => {
    expect(readTheme(memoryStorage({ [THEME_KEY]: 'purple' }))).toBe('system');
    expect(readTheme(throwingStorage)).toBe('system');
    expect(() => storeTheme('dark', throwingStorage)).not.toThrow();
    expect(readTheme(undefined)).toBe('system');
  });

  it('applies the theme as data-theme and removes it for system', () => {
    const root = { dataset: {} };
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('light', root);
    expect(root.dataset.theme).toBe('light');
    applyTheme('system', root);
    expect('theme' in root.dataset).toBe(false);
  });
});

describe('forecast peak bands', () => {
  it('groups consecutive peak hours into one band', () => {
    const points = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00'].map((hour, i) => ({ hour, isPeak: [1, 2, 4].includes(i) }));
    expect(peakRanges(points)).toEqual([{ x1: '09:00', x2: '10:00' }, { x1: '12:00', x2: '12:00' }]);
    expect(peakRanges([])).toEqual([]);
  });
});
