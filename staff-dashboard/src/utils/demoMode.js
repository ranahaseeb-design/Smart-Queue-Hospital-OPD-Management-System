// Presentation switch: "Demo tools" (per browser, localStorage). Off by default so everyday screens
// stay clean; turn it on for committee demos to show the demo-only controls: load demo data, peak
// congestion, reset demo data, the doctor / room switcher, "Live queue" and the patient load
// simulator. The server still decides whether the demo endpoints exist (DEMO_TOOLS).
import { useEffect, useState } from 'react';

export const DEMO_TOOLS_KEY = 'smartopd.demoTools';
const EVENT = 'smartopd:demotools';

export function demoToolsOn() {
  try {
    return window.localStorage.getItem(DEMO_TOOLS_KEY) === 'on';
  } catch {
    return false;
  }
}

export function setDemoTools(on) {
  try {
    window.localStorage.setItem(DEMO_TOOLS_KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked: the switch only lasts for this page */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** [on, setOn] that follows changes from this tab and from other tabs. */
export function useDemoTools() {
  const [on, setOn] = useState(demoToolsOn);
  useEffect(() => {
    const sync = () => setOn(demoToolsOn());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return [on, setDemoTools];
}
