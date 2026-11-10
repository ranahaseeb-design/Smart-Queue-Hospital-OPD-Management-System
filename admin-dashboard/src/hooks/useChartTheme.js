// Recharts colours from the design tokens. Values are read from the computed style of <html> at
// runtime and re-read when the theme changes (data-theme attribute or the OS colour scheme), so
// charts follow light and dark mode without hardcoded colours.
import { useEffect, useState } from 'react';
import { readChartTheme } from '../utils/chartTheme.js';

export function useChartTheme() {
  const [theme, setTheme] = useState(readChartTheme);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const update = () => setTheme(readChartTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', update);
    update();
    return () => {
      observer.disconnect();
      mq?.removeEventListener?.('change', update);
    };
  }, []);

  return theme;
}
