/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import '../test/dom.js';
import ThemeToggle from './ThemeToggle.jsx';
import { useChartTheme } from '../hooks/useChartTheme.js';

describe('<ThemeToggle>', () => {
  it('starts dark when nothing is stored and toggles Dark <-> Light, persisting the choice', () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button', { name: 'Switch to light theme' });
    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('smartopd.theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('smartopd.theme')).toBe('dark');
  });

  it('restores a stored light theme', () => {
    localStorage.setItem('smartopd.theme', 'light');
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy();
  });
});

describe('useChartTheme', () => {
  it('re-reads the chart tokens when data-theme changes', async () => {
    document.documentElement.dataset.theme = 'dark';
    const { result } = renderHook(() => useChartTheme());
    expect(result.current.mode).toBe('dark');
    await act(async () => {
      document.documentElement.dataset.theme = 'light';
      await Promise.resolve();
    });
    expect(result.current.mode).toBe('light');
    expect(result.current.congestion).toHaveProperty('CRITICAL');
  });
});
