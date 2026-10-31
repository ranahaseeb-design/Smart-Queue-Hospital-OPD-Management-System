// Live channel wiring (FR-05, NFR-01) with socket.io-client replaced by a tiny fake.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const make = () => {
    const handlers = {};
    const managerHandlers = {};
    return {
      handlers,
      managerHandlers,
      emitted: [],
      connected: false,
      on(event, fn) {
        handlers[event] = fn;
      },
      emit(event, payload) {
        this.emitted.push([event, payload]);
      },
      io: {
        on(event, fn) {
          managerHandlers[event] = fn;
        },
        removeAllListeners() {},
      },
      removeAllListeners() {},
      disconnect: vi.fn(),
    };
  };
  return { make, current: null, options: null };
});

vi.mock('socket.io-client', () => ({
  io: (url, options) => {
    fake.current = fake.make();
    fake.options = options;
    return fake.current;
  },
}));

const { connectQueueSocket } = await import('../socket.js');

describe('connectQueueSocket', () => {
  let statuses;
  let updates;

  beforeEach(() => {
    statuses = [];
    updates = [];
  });

  const connect = (extra = {}) =>
    connectQueueSocket({
      token: 'jwt-abc',
      servicePointId: 3,
      onStatusChange: (s) => statuses.push(s),
      onQueueUpdated: (p) => updates.push(p),
      ...extra,
    });

  it('authenticates with the JWT and joins sp:<id> on every (re)connect', () => {
    connect();
    expect(fake.options.auth).toEqual({ token: 'jwt-abc' });
    expect(statuses).toEqual(['connecting']);
    fake.current.handlers.connect();
    fake.current.handlers.connect(); // automatic reconnection
    expect(fake.current.emitted).toEqual([
      ['subscribe', { room: 'sp:3' }],
      ['subscribe', { room: 'sp:3' }],
    ]);
    expect(statuses.at(-1)).toBe('connected');
  });

  it('stays "disconnected" during reconnection attempts so the polling fallback is not restarted', () => {
    connect();
    fake.current.handlers.connect();
    fake.current.handlers.disconnect('transport close');
    fake.current.handlers.connect_error(new Error('xhr poll error'));
    if (fake.current.managerHandlers.reconnect_attempt) fake.current.managerHandlers.reconnect_attempt(1);
    fake.current.handlers.connect_error(new Error('xhr poll error'));
    expect(statuses.slice(2)).toEqual(['disconnected', 'disconnected', 'disconnected']);
    fake.current.handlers.connect();
    expect(statuses.at(-1)).toBe('connected');
  });

  it('forwards queue:updated for this point only and reports auth failures', () => {
    const onAuthError = vi.fn();
    connect({ onAuthError });
    fake.current.handlers['queue:updated']({ servicePointId: 3, branchId: 1 });
    fake.current.handlers['queue:updated']({ servicePointId: 9, branchId: 1 });
    expect(updates).toEqual([{ servicePointId: 3, branchId: 1 }]);
    fake.current.handlers.connect_error(new Error('Unauthorized: invalid token'));
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });
});
