/**
 * Minimal JSON API client for the admin console.
 *
 * - same-origin cookies (the API sets an HttpOnly session cookie);
 * - the session CSRF token is kept in memory and sent as `X-Sumire-CSRF` on
 *   every non-GET request;
 * - a 401 clears the in-memory session state, notifies subscribers and sends
 *   the user to the login route, then throws `ApiError`.
 */
import type { LoginResponse, SessionResponse } from './types.ts';

export const API_BASE = '/sumire/admin';
export const CSRF_HEADER = 'X-Sumire-CSRF';

let csrfToken: string | null = null;
/** Hash to return to after a successful login; set by a 401 outside the login form. */
let postLoginHash: string | null = null;

const unauthorizedHandlers = new Set<() => void>();

/** Non-2xx response; `body` is the parsed JSON (or text) error payload. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

/**
 * The hash to navigate to after a successful login: a deep link remembered from
 * the last 401, or `#/events`. Consumes the remembered value.
 */
export function takePostLoginHash(): string {
  const hash = postLoginHash ?? '#/events';
  postLoginHash = null;
  return hash;
}

/** Clear the remembered post-login hash (tests). */
export function resetPostLoginHashForTests(): void {
  postLoginHash = null;
}

/** Subscribe to session loss; returns the unsubscribe function. */
export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandlers.add(handler);
  return () => {
    unauthorizedHandlers.delete(handler);
  };
}

/** Drop the in-memory session state and notify subscribers (no navigation). */
export function clearSessionState(): void {
  csrfToken = null;
  for (const handler of [...unauthorizedHandlers]) handler();
}

async function parseResponseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  const text = await res.text();
  return text === '' ? undefined : text;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const upper = method.toUpperCase();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (upper !== 'GET' && csrfToken !== null) headers[CSRF_HEADER] = csrfToken;

  const res = await fetch(`${API_BASE}${path}`, {
    method: upper,
    credentials: 'same-origin',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const parsed = await parseResponseBody(res);

  if (res.status === 401) {
    // A rejected login is a form-level error: stay on the form so it can show
    // the server's error and keep any remembered deep link.
    const isLoginRequest = upper === 'POST' && path === '/login';
    if (!isLoginRequest) {
      if (typeof window !== 'undefined') {
        const hash = window.location.hash;
        if (hash !== '' && hash !== '#/login') postLoginHash = hash;
        clearSessionState();
        window.location.hash = '#/login';
      } else {
        clearSessionState();
      }
    }
    throw new ApiError(401, parsed);
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

export function get<T>(path: string): Promise<T> {
  return api<T>('GET', path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>('POST', path, body);
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return api<T>('PUT', path, body);
}

/** DELETE has no body; 204 resolves to `undefined`. */
export function del<T = void>(path: string): Promise<T> {
  return api<T>('DELETE', path);
}

/** Log in and remember the new CSRF token. */
export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await post<LoginResponse>('/login', { username, password });
  csrfToken = res.csrfToken;
  return res;
}

/** Resolve the current session (also refreshes the CSRF token). */
export async function session(): Promise<SessionResponse> {
  const res = await get<SessionResponse>('/session');
  csrfToken = res.csrfToken;
  return res;
}

export async function logout(): Promise<void> {
  try {
    await post<void>('/logout');
  } finally {
    csrfToken = null;
  }
}
