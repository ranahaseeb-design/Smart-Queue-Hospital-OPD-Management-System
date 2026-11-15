// Optional audio chime when the patient's token is called. Browsers only allow sound after a user
// gesture, so the AudioContext is created when the patient switches the chime on.
const KEY = 'smartopd.patient.chime';
let ctx = null;

export function chimeEnabled() {
  try {
    return window.localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function setChimeEnabled(on) {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked: the toggle still works for this page */
  }
  if (on) unlock();
}

function unlock() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!ctx) ctx = new AudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Two-tone "ding-dong" (about 0.9 s). Silent when audio is unavailable. */
export function playChime() {
  const audio = unlock();
  if (!audio) return;
  const now = audio.currentTime;
  [
    [880, 0],
    [660, 0.38],
  ].forEach(([freq, start]) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(0.25, now + start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.5);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + start);
    osc.stop(now + start + 0.55);
  });
}
