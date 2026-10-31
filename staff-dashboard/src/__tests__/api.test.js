import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, request, setUnauthorizedHandler, toApiError } from '../api.js';
import { KEYS, removeItem, setItem } from '../utils/storage.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

describe('toApiError (contract error envelope)', () => {
  it('uses the server code and message', () => {
    const e = toApiError(409, { error: { code: 'CONFLICT', message: 'A token is still open here' } });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toBe('A token is still open here');
  });

  it('falls back to defaults when the body is empty or not JSON', () => {
    expect(toApiError(403, null).code).toBe('FORBIDDEN');
    expect(toApiError(404, { raw: '<html>' }).code).toBe('NOT_FOUND');
    expect(toApiError(500, null).code).toBe('SERVER_ERROR');
  });
});

describe('request()', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setItem(KEYS.token, 'jwt-123');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
    removeItem(KEYS.token);
  });

  it('calls /api on the configured origin with the bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { token: null }));
    await api.callNext(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4000/api/service-points/3/call-next');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer jwt-123');
  });

  it('returns parsed JSON on success', async () => {
    const queue = { servicePoint: { id: 3 }, nowServing: null, waiting: [], skipped: [], summary: {} };
    fetchMock.mockResolvedValue(jsonResponse(200, queue));
    await expect(api.queue(3)).resolves.toEqual(queue);
  });

  it('throws ApiError with the server message on 409', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: 'CONFLICT', message: 'Finish OPD-004 first' } }));
    await expect(api.callNext(3)).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'Finish OPD-004 first',
    });
  });

  it('reports a 401 on an authenticated call so the app can log out', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Token expired' } }));
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not treat a failed login (401) as an expired session', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } }),
    );
    await expect(api.login('doctor1@opd.test', 'wrong')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ identifier: 'doctor1@opd.test', password: 'wrong' });
  });

  it('maps a network failure to NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.servicePoints()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('times out a request that never answers', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    await expect(request('GET', '/staff/service-points', undefined, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('sends transfer, priority and linked-token bodies exactly as in the contract', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await api.transfer(42, 9, 2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4000/api/tokens/42/transfer');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ toServicePointId: 9, toDoctorId: 2 });

    await api.transfer(42, 20, null);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ toServicePointId: 20 });

    await api.issueLinkedToken(17, 'LAB');
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:4000/api/visits/17/linked-tokens');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ type: 'LAB' });

    await api.issueLinkedToken(17, 'PHARMACY', 20);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ type: 'PHARMACY', servicePointId: 20 });

    await api.setPriority(42, 2, 'Emergency case');
    expect(fetchMock.mock.calls[4][0]).toBe('http://localhost:4000/api/tokens/42/priority');
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toEqual({ level: 2, reason: 'Emergency case' });

    await api.transferTargets(3);
    expect(fetchMock.mock.calls[5][0]).toBe('http://localhost:4000/api/staff/transfer-targets?servicePointId=3');
  });
});
