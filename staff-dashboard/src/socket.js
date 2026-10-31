// Live queue channel (FR-05, NFR-01). The server pushes `queue:updated` to room `sp:<id>`;
// the client simply re-fetches the queue over REST when it arrives.
import { io } from 'socket.io-client';
import { SOCKET_URL } from './config.js';

/**
 * Connect, subscribe to one service point room and report connection status.
 * @param {{ token: string, servicePointId: number|string,
 *           onQueueUpdated: (payload: object) => void,
 *           onStatusChange: (status: 'connecting'|'connected'|'disconnected') => void,
 *           onAuthError?: (err: Error) => void }} options
 * @returns {() => void} cleanup that unsubscribes and disconnects
 */
export function connectQueueSocket({ token, servicePointId, onQueueUpdated, onStatusChange, onAuthError }) {
  const room = `sp:${servicePointId}`;
  const socket = io(SOCKET_URL, {
    auth: { token },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 8000,
  });

  onStatusChange('connecting');

  // `connect` also fires after every automatic reconnection, so the room is re-joined each time.
  socket.on('connect', () => {
    socket.emit('subscribe', { room });
    onStatusChange('connected');
  });

  socket.on('disconnect', () => onStatusChange('disconnected'));

  socket.on('connect_error', (err) => {
    onStatusChange('disconnected');
    const msg = String((err && err.message) || '');
    if (onAuthError && /auth|token|jwt|unauthori[sz]ed/i.test(msg)) onAuthError(err);
  });

  // Reconnection attempts deliberately do not report 'connecting': the status stays 'disconnected'
  // until the socket is back, so the indicator does not flicker and the 15 s polling fallback
  // (useQueue) keeps running instead of being restarted on every attempt.

  socket.on('queue:updated', (payload) => {
    // Ignore events for other points (e.g. if the server also forwards admin-room traffic).
    if (payload && payload.servicePointId != null && String(payload.servicePointId) !== String(servicePointId)) {
      return;
    }
    onQueueUpdated(payload || {});
  });

  return () => {
    if (socket.connected) socket.emit('unsubscribe', { room });
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
  };
}
