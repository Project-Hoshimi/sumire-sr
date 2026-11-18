import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  CSRF_HEADER,
  api,
  clearSessionState,
  get,
  getCsrfToken,
  login,
  logout,
  onUnauthorized,
  post,
  put,
  resetPostLoginHashForTests,
  session,
  setCsrfToken,
  takePostLoginHash,
} from './api.ts';

function mockResponse(
  body: unknown,
  status = 200,
  contentType = 'application/json',
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  init: RequestInit;
} {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return { url: String(call[0]), init: call[1] as RequestInit };
}

describe('api client', () => {
  beforeEach(() => {
    setCsrfToken(null);
    resetPostLoginHashForTests();
    window.location.hash = '#/events';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSessionState();
  });

  it('sends the CSRF header on POST and PUT but not on GET', async () => {
    const fetchMock = stubFetch(mockResponse({ ok: true }));
    setCsrfToken('csrf-123');

    await post('/events', { id: 'e1' });
    expect(lastRequest(fetchMock).init.headers).toMatchObject({ [CSRF_HEADER]: 'csrf-123' });

    await put('/events/e1/draft', { draft: {} });
    expect(lastRequest(fetchMock).init.headers).toMatchObject({ [CSRF_HEADER]: 'csrf-123' });

    await get('/events');
    const headers = lastRequest(fetchMock).init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBeUndefined();
  });

  it('uses same-origin credentials and the /sumire/admin base', async () => {
    const fetchMock = stubFetch(mockResponse([]));
    await get('/events');
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe('/sumire/admin/events');
    expect(init.credentials).toBe('same-origin');
    expect(init.method).toBe('GET');
  });

  it('clears the token and redirects to #/login on 401', async () => {
    stubFetch(mockResponse({ error: 'unauthorized' }, 401));
    setCsrfToken('csrf-123');

    await expect(get('/session')).rejects.toBeInstanceOf(ApiError);
    expect(getCsrfToken()).toBeNull();
    expect(window.location.hash).toBe('#/login');
  });

  it('remembers the current hash on a 401 and returns to it after login', async () => {
    window.location.hash = '#/events/event-1';
    stubFetch(mockResponse({ error: 'unauthorized' }, 401));

    await expect(session()).rejects.toBeInstanceOf(ApiError);
    expect(window.location.hash).toBe('#/login');
    expect(takePostLoginHash()).toBe('#/events/event-1');

    // The remembered hash is consumed, so the next login falls back to events.
    expect(takePostLoginHash()).toBe('#/events');
  });

  it('a 401 from POST /login does not navigate or forget the deep link', async () => {
    window.location.hash = '#/events/event-1';
    const fetchMock = stubFetch(mockResponse({ error: 'unauthorized' }, 401));
    const handler = vi.fn();
    const unsubscribe = onUnauthorized(handler);

    // First lose the session somewhere else to remember the deep link.
    await expect(session()).rejects.toBeInstanceOf(ApiError);
    expect(window.location.hash).toBe('#/login');
    expect(handler).toHaveBeenCalledTimes(1);

    // A rejected login stays on the form and leaves the remembered hash alone.
    window.location.hash = '#/login';
    await expect(login('admin', 'wrong')).rejects.toBeInstanceOf(ApiError);
    expect(window.location.hash).toBe('#/login');
    expect(handler).toHaveBeenCalledTimes(1);
    const loginAttempt = lastRequest(fetchMock);
    expect(loginAttempt.url).toBe('/sumire/admin/login');
    expect(loginAttempt.init.method).toBe('POST');
    expect(takePostLoginHash()).toBe('#/events/event-1');
    unsubscribe();
  });

  it('notifies unauthorized subscribers exactly once', async () => {
    stubFetch(mockResponse({ error: 'unauthorized' }, 401));
    const handler = vi.fn();
    const unsubscribe = onUnauthorized(handler);

    await expect(get('/session')).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    await expect(get('/session')).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError carrying status and body for other non-2xx responses', async () => {
    stubFetch(mockResponse({ error: 'invalid id' }, 400));

    const error = await get('/events/bad').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).body).toEqual({ error: 'invalid id' });
  });

  it('login stores the returned CSRF token', async () => {
    stubFetch(
      mockResponse({
        user: { id: 'u1', username: 'admin', role: 'owner', disabled: false },
        csrfToken: 'fresh-token',
      }),
    );

    const res = await login('admin', 'password');
    expect(res.csrfToken).toBe('fresh-token');
    expect(getCsrfToken()).toBe('fresh-token');
  });

  it('session refreshes the CSRF token', async () => {
    stubFetch(
      mockResponse({
        user: { id: 'u1', username: 'admin', role: 'owner' },
        csrfToken: 'session-token',
      }),
    );

    await session();
    expect(getCsrfToken()).toBe('session-token');
  });

  it('logout posts without a body, resolves on 204 and clears the token', async () => {
    const fetchMock = stubFetch(mockResponse(null, 204));
    setCsrfToken('csrf-123');

    await expect(logout()).resolves.toBeUndefined();
    const { init } = lastRequest(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(getCsrfToken()).toBeNull();
  });

  it('api serialises JSON bodies and sets the content type', async () => {
    const fetchMock = stubFetch(mockResponse({ saved: true }));
    await api('post', '/events/e1/draft', { draft: { a: 1 } });
    const { init } = lastRequest(fetchMock);
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"draft":{"a":1}}');
  });
});
