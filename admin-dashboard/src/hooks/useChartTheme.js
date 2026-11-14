// Recharts colours from the design tokens. Values are read from the computed style of <html> at
// runtime and re-read whenever the theme toggle changes <html data-theme> (Decision 5: the OS
// colour scheme is no longer followed, so the attribute is the only trigger).
import { useEffect, useState } from 'react';
import { readChartTheme } from '../utils/chartTheme.js';

export function useChartTheme() {
  const [theme, setTheme] = useState(readChartTheme);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
    const update = () => setTheme(readChartTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    update();
    return () => observer.disconnect();
  }, []);

  return theme;
}
