// Shared set-up for component tests (files with a `@vitest-environment jsdom` docblock).
// jsdom lacks a few browser APIs the dashboard uses; these stubs are test-only.
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: Boolean(window.__reducedMotion) && query.includes('reduce'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
}

afterEach(() => {
  cleanup();
  try { window.localStorage.clear(); } catch { /* ignore */ }
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
});

/** Same future flags as main.jsx, so MemoryRouter in tests does not warn. */
export const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true };

/** Minimal useScope() value for pages under test. */
export function scopeValue(overrides = {}) {
  return {
    branches: [],
    branchesLoading: false,
    reloadBranches: () => {},
    branchId: null,
    branch: null,
    branchName: 'All branches',
    locked: false,
    setBranchId: () => {},
    scopeQuery: {},
    branchNameById: (id) => `Branch #${id}`,
    ...overrides,
  };
}
