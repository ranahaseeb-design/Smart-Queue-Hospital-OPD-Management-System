// Navigation helpers.

const DEFAULT_PATH = '/overview';

/**
 * Where to go after signing in. Only same-app paths are allowed: the value must start with a
 * single "/" (not "//" or "/\", which browsers treat as another host) and must not be the login
 * page itself. Anything else falls back to the live overview, so a crafted link cannot turn the
 * login page into an open redirect.
 */
export function safeReturnPath(from) {
  if (typeof from !== 'string' || !from.startsWith('/')) return DEFAULT_PATH;
  if (/^\/[/\\]/.test(from) || /[\u0000-\u001f]/.test(from)) return DEFAULT_PATH;
  if (from === '/login' || from.startsWith('/login?') || from.startsWith('/login/')) return DEFAULT_PATH;
  return from;
}
