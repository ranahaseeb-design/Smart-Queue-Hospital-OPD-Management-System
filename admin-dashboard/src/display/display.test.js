// Waiting-room board logic: which counters just called a new token (pulse + chime) and wait text.
import { describe, expect, it } from 'vitest';
import { newlyCalled, waitText } from './DisplayBoard.jsx';

const sp = (id, number, name = `Room ${id}`) => ({ id, name, nowServing: number ? { displayNumber: number } : null });

describe('display board', () => {
  it('flags only service points whose now-serving token changed since the last refresh', () => {
    const previous = { 1: 'OPD-004', 2: null, 3: 'OPD-007' };
    const calls = newlyCalled(previous, [sp(1, 'OPD-005'), sp(2, 'OPD-001'), sp(3, 'OPD-007'), sp(4, 'LAB-002', 'Lab Counter')]);
    expect(calls).toEqual([
      { id: 1, number: 'OPD-005', name: 'Room 1' },
      { id: 2, number: 'OPD-001', name: 'Room 2' },
    ]);
  });

  it('does not pulse on the first load or when a room becomes empty', () => {
    expect(newlyCalled({}, [sp(1, 'OPD-004')])).toEqual([]);
    expect(newlyCalled({ 1: 'OPD-004' }, [sp(1, null)])).toEqual([]);
  });

  it('formats estimated waits', () => {
    expect(waitText(3)).toBe('< 5 min');
    expect(waitText(41.4)).toBe('~41 min');
    expect(waitText(null)).toBeNull();
    expect(waitText(undefined)).toBeNull();
  });
});
