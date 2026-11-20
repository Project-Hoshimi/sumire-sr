/**
 * Admin authentication core: roles, password/username validation, session
 * tokens, login rate limiting and session lookup. Every function takes the
 * store and an explicit `now` so tests can drive time deterministically.
 *
 * Cookies carry a 32-byte base64url token; the database stores only its
 * SHA-256 hex digest. The CSRF token is a separate 32-byte base64url value
 * kept on the session row.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from '../../auth/passwords.ts';
import {
  type AdminRole,
  type AdminSessionRow,
  type AdminStore,
  type AdminUserRow,
  isValidAdminUsername,
  normalizeAdminUsername,
} from './store.ts';

export const ADMIN_COOKIE_NAME = 'sumire_admin';
export const ADMIN_CSRF_HEADER = 'x-sumire-csrf';
export const ADMIN_CSRF_HEADER_DISPLAY = 'X-Sumire-CSRF';

/** 2 h idle timeout, 12 h absolute lifetime. */
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
/** `last_seen_at` is written at most once per minute. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 200;

const ROLE_RANK: Record<AdminRole, number> = {
  viewer: 1,
  editor: 2,
  publisher: 3,
  owner: 4,
};

/** True when `role` is at least `min`; unknown roles never satisfy a minimum. */
export function roleAtLeast(role: string, min: AdminRole): boolean {
  const value = ROLE_RANK[role as AdminRole];
  return value !== undefined && value >= ROLE_RANK[min];
}

export function isValidAdminPassword(password: unknown): password is string {
  return (
    typeof password === 'string' &&
    password.length >= ADMIN_PASSWORD_MIN_LENGTH &&
    password.length <= ADMIN_PASSWORD_MAX_LENGTH
  );
}

/** 32 random bytes base64url (session token or CSRF token). */
export function newAdminToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface SessionAuth {
  user: AdminUserRow;
  session: AdminSessionRow;
}

/**
 * Resolve a cookie token to a live user + session. Expired (idle or absolute)
 * and disabled-user sessions are deleted and treated as absent. A successful
 * lookup refreshes `last_seen_at` at most once per minute.
 */
export async function lookupSession(
  store: AdminStore,
  token: string,
  now: Date,
): Promise<SessionAuth | null> {
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const session = await store.getSessionByTokenHash(tokenHash);
  if (!session) return null;

  const absoluteExpired = session.expiresAt.getTime() <= now.getTime();
  const idleExpired = session.lastSeenAt.getTime() + SESSION_IDLE_MS <= now.getTime();
  if (absoluteExpired || idleExpired) {
    await store.deleteSession(tokenHash);
    return null;
  }

  const user = await store.getById(session.userId);
  if (!user || user.disabled) {
    await store.deleteSession(tokenHash);
    return null;
  }

  if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    await store.touchSession(tokenHash, now);
    session.lastSeenAt = now;
  }
  return { user, session };
}

/** Constant-time compare for the CSRF header (length-independent). */
export function csrfMatches(headerValue: string | string[] | undefined, expected: string): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof value !== 'string' || value.length === 0) return false;
  const left = Buffer.from(value, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Bound on each tracking map; beyond this the oldest/stalest keys are dropped. */
export const LOGIN_LIMITER_MAX_KEYS = 10000;

/**
 * In-memory failure tracker: 5 failures per username within 15 min lock that
 * username for 15 min; 20 failures per IP within 15 min refuse that IP. A
 * successful login clears the username's failure count (the IP window is
 * left alone, matching the spec).
 *
 * Both maps are bounded: past `LOGIN_LIMITER_MAX_KEYS` entries, stale unlocked
 * entries are swept and then the oldest (Map insertion order) are dropped.
 */
export class LoginLimiter {
  private readonly usernameFailures = new Map<string, number[]>();
  private readonly ipFailures = new Map<string, number[]>();
  private readonly lockedUntil = new Map<string, number>();

  private readonly usernameMax: number;
  private readonly ipMax: number;
  private readonly windowMs: number;
  private readonly lockMs: number;

  constructor(
    usernameMax = 5,
    ipMax = 20,
    windowMs = 15 * 60 * 1000,
    lockMs = 15 * 60 * 1000,
  ) {
    this.usernameMax = usernameMax;
    this.ipMax = ipMax;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
  }

  private prune(map: Map<string, number[]>, key: string, nowMs: number): void {
    const times = map.get(key);
    if (!times) return;
    const recent = times.filter((t) => nowMs - t < this.windowMs);
    if (recent.length === 0) map.delete(key);
    else map.set(key, recent);
  }

  /**
   * Keep `map` at or below `LOGIN_LIMITER_MAX_KEYS`: first drop entries whose
   * failures have all aged out (unless the username is currently locked), then
   * drop the oldest entries (Map insertion order) until within the bound.
   */
  private sweep(map: Map<string, number[]>, nowMs: number, honorLocks: boolean): void {
    if (map.size <= LOGIN_LIMITER_MAX_KEYS) return;
    for (const [key, times] of [...map]) {
      const lockedUntil = honorLocks ? this.lockedUntil.get(key) : undefined;
      const locked = lockedUntil !== undefined && lockedUntil > nowMs;
      if (locked) continue;
      if (times.every((t) => nowMs - t >= this.windowMs)) map.delete(key);
    }
    for (const key of [...map.keys()]) {
      if (map.size <= LOGIN_LIMITER_MAX_KEYS) break;
      map.delete(key);
    }
  }

  /** Tracked distinct usernames (exposed for tests/observability). */
  get usernameEntryCount(): number {
    return this.usernameFailures.size;
  }

  /** Tracked distinct IPs (exposed for tests/observability). */
  get ipEntryCount(): number {
    return this.ipFailures.size;
  }

  /** `locked` before generic IP limiting: a locked username always gets its distinct 429. */
  check(username: string, ip: string, nowMs: number): 'ok' | 'locked' | 'ip_limited' {
    const lockedAt = this.lockedUntil.get(username);
    if (lockedAt !== undefined) {
      if (lockedAt > nowMs) return 'locked';
      this.lockedUntil.delete(username);
    }
    this.prune(this.usernameFailures, username, nowMs);
    this.prune(this.ipFailures, ip, nowMs);
    if ((this.ipFailures.get(ip)?.length ?? 0) >= this.ipMax) return 'ip_limited';
    return 'ok';
  }

  recordFailure(username: string, ip: string, nowMs: number): void {
    const userTimes = this.usernameFailures.get(username) ?? [];
    userTimes.push(nowMs);
    this.usernameFailures.set(username, userTimes);
    this.prune(this.usernameFailures, username, nowMs);
    this.sweep(this.usernameFailures, nowMs, true);
    if ((this.usernameFailures.get(username)?.length ?? 0) >= this.usernameMax) {
      this.lockedUntil.set(username, nowMs + this.lockMs);
    }

    const ipTimes = this.ipFailures.get(ip) ?? [];
    ipTimes.push(nowMs);
    this.ipFailures.set(ip, ipTimes);
    this.prune(this.ipFailures, ip, nowMs);
    this.sweep(this.ipFailures, nowMs, false);
  }

  recordSuccess(username: string): void {
    this.usernameFailures.delete(username);
    this.lockedUntil.delete(username);
  }
}

export interface LoginInput {
  username: string;
  password: string;
  ip: string;
}

export type LoginOutcome =
  | { ok: true; token: string; csrfToken: string; user: AdminUserRow }
  | { ok: false; reason: 'invalid' | 'locked' | 'ip_limited' };

/** Verify credentials and, on success, create a session. */
export async function login(
  store: AdminStore,
  limiter: LoginLimiter,
  input: LoginInput,
  now: Date,
): Promise<LoginOutcome> {
  const username = normalizeAdminUsername(input.username ?? '');
  const gate = limiter.check(username, input.ip, now.getTime());
  if (gate !== 'ok') return { ok: false, reason: gate };

  const user = isValidAdminUsername(username) ? await store.getByUsername(username) : undefined;
  // Always spend one scrypt verification so a missing user is indistinguishable
  // from a wrong password.
  const passwordOk = verifyPassword(
    typeof input.password === 'string' ? input.password : '',
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  if (!user || !passwordOk || user.disabled) {
    limiter.recordFailure(username, input.ip, now.getTime());
    return { ok: false, reason: 'invalid' };
  }

  limiter.recordSuccess(username);
  // Opportunistic cleanup; correctness does not depend on it.
  await store.deleteExpiredSessions(now);

  const token = newAdminToken();
  const csrfToken = newAdminToken();
  await store.createSession({
    tokenHash: sha256Hex(token),
    userId: user.id,
    csrfToken,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
  });
  await store.touchLogin(user.id, now);

  return { ok: true, token, csrfToken, user: { ...user, lastLoginAt: now } };
}

/** Hash a validated admin password with the shared scrypt helper. */
export function hashAdminPassword(password: string): string {
  return hashPassword(password);
}
