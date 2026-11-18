/**
 * Admin console API: login/logout/session, bootstrap and owner-only user
 * management, all under `/sumire/admin`.
 *
 * Sessions live in a `sumire_admin` cookie (HttpOnly, Secure, SameSite=Strict,
 * Path=/sumire/admin). Session-authenticated non-GET requests must send
 * `X-Sumire-CSRF` matching the session's CSRF token.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import { sha256Hex } from '../auth/passwords.ts';
import { drizzleAdminStore } from '../services/admin/store.drizzle.ts';
import {
  ADMIN_COOKIE_NAME,
  ADMIN_CSRF_HEADER,
  SESSION_ABSOLUTE_MS,
  csrfMatches,
  hashAdminPassword,
  isValidAdminPassword,
  LoginLimiter,
  login,
  lookupSession,
  roleAtLeast,
} from '../services/admin/auth.ts';
import {
  type AdminRole,
  type AdminSessionRow,
  type AdminStore,
  type AdminUserRow,
  LastOwnerError,
  UsernameTakenError,
  isAdminRole,
  isValidAdminUsername,
  normalizeAdminUsername,
} from '../services/admin/store.ts';

/** The subset of the user attached to `request.adminUser`. */
export interface AdminRequestUser {
  id: string;
  username: string;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: AdminRequestUser;
    adminSession?: AdminSessionRow;
  }
}

export interface AdminRouteDeps {
  store: AdminStore;
  limiter?: LoginLimiter;
  now?: () => Date;
}

export interface AdminPluginOptions extends AdminRouteDeps {}

const COOKIE_PATH = '/sumire/admin';
const COOKIE_MAX_AGE_SECONDS = SESSION_ABSOLUTE_MS / 1000;

function defaultStore(): AdminStore {
  return drizzleAdminStore();
}

function publicUser(user: AdminUserRow): {
  id: string;
  username: string;
  role: string;
  disabled: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
} {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

/** Body may arrive as an object (Fastify JSON parser) or a raw Buffer. */
export function readJsonBody(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return body as Record<string, unknown>;
  }
  let text: string;
  if (Buffer.isBuffer(body)) text = body.toString('utf8');
  else if (typeof body === 'string') text = body;
  else return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match ? match[1] : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** Read at request time so tests can set/unset the token in one process. */
function configuredAdminToken(): string {
  return process.env.SUMIRE_ADMIN_TOKEN ?? '';
}

function sessionCookie(req: FastifyRequest): string | undefined {
  return req.cookies?.[ADMIN_COOKIE_NAME];
}

/**
 * Reusable preHandler factory for admin routes. Resolves the cookie session,
 * enforces the minimum role and (on non-GET) the CSRF header, and exposes
 * `request.adminUser` / `request.adminSession`.
 *
 * Parts 6–7 register event/roster routes with this; the store/time default to
 * the production Drizzle store and wall clock when not supplied.
 */
export function requireAdmin(minRole: AdminRole, deps: Partial<AdminRouteDeps> = {}): preHandlerHookHandler {
  const store = deps.store ?? defaultStore();
  const now = deps.now ?? (() => new Date());
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = sessionCookie(req);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const auth = await lookupSession(store, token, now());
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!roleAtLeast(auth.user.role, minRole)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (req.method !== 'GET' && !csrfMatches(req.headers[ADMIN_CSRF_HEADER], auth.session.csrfToken)) {
      return reply.code(403).send({ error: 'invalid csrf token' });
    }
    req.adminUser = { id: auth.user.id, username: auth.user.username, role: auth.user.role };
    req.adminSession = auth.session;
  };
}

/** `@fastify/cookie` must already be registered on the instance. */
export const adminRoutes: FastifyPluginAsync<AdminPluginOptions> = async (app, opts) => {
  const store = opts.store;
  const limiter = opts.limiter ?? new LoginLimiter();
  const now = opts.now ?? (() => new Date());
  const deps: AdminRouteDeps = { store, limiter, now };

  const anyRole = requireAdmin('viewer', deps);
  const ownerOnly = requireAdmin('owner', deps);

  function setSessionCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(ADMIN_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });
  }

  function clearSessionCookie(reply: FastifyReply): void {
    // Same attributes as the setter, otherwise browsers keep the stale cookie.
    reply.clearCookie(ADMIN_COOKIE_NAME, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: COOKIE_PATH,
    });
  }

  app.post('/sumire/admin/login', async (req, reply) => {
    const body = readJsonBody(req.body) ?? {};
    const username = typeof body.username === 'string' ? normalizeAdminUsername(body.username) : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const outcome = await login(store, limiter, { username, password, ip: req.ip }, now());
    if (!outcome.ok) {
      if (outcome.reason === 'locked') return reply.code(429).send({ error: 'account locked' });
      if (outcome.reason === 'ip_limited') return reply.code(429).send({ error: 'too many attempts' });
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    setSessionCookie(reply, outcome.token);
    return { user: publicUser(outcome.user), csrfToken: outcome.csrfToken };
  });

  app.post('/sumire/admin/logout', { preHandler: anyRole }, async (req, reply) => {
    const token = sessionCookie(req);
    if (token) await store.deleteSession(sha256Hex(token));
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/sumire/admin/session', { preHandler: anyRole }, async (req) => {
    return {
      user: req.adminUser!,
      csrfToken: req.adminSession!.csrfToken,
    };
  });

  app.post('/sumire/admin/bootstrap', async (req, reply) => {
    const expected = configuredAdminToken();
    if (!expected) return reply.code(404).send({ error: 'not found' });

    const bearer = bearerToken(req);
    if (!bearer) return reply.code(401).send({ error: 'unauthorized' });
    if (!constantTimeEqual(bearer, expected)) return reply.code(403).send({ error: 'forbidden' });

    const body = readJsonBody(req.body) ?? {};
    const username = typeof body.username === 'string' ? normalizeAdminUsername(body.username) : '';
    if (!isValidAdminUsername(username)) {
      return reply.code(400).send({ error: 'invalid username' });
    }
    if (!isValidAdminPassword(body.password)) {
      return reply.code(400).send({ error: 'invalid password' });
    }
    let user: AdminUserRow | null;
    try {
      user = await store.createFirstOwner({
        id: randomUUID(),
        username,
        passwordHash: hashAdminPassword(body.password),
        role: 'owner',
      });
    } catch (error) {
      if (error instanceof UsernameTakenError) {
        return reply.code(409).send({ error: 'username already exists' });
      }
      throw error;
    }
    if (!user) return reply.code(409).send({ error: 'admin already initialized' });
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.get('/sumire/admin/users', { preHandler: ownerOnly }, async () => {
    const users = await store.list();
    return users.map(publicUser);
  });

  app.post('/sumire/admin/users', { preHandler: ownerOnly }, async (req, reply) => {
    const body = readJsonBody(req.body) ?? {};
    const username = typeof body.username === 'string' ? normalizeAdminUsername(body.username) : '';
    const role = body.role;
    if (!isValidAdminUsername(username)) {
      return reply.code(400).send({ error: 'invalid username' });
    }
    if (!isAdminRole(role)) {
      return reply.code(400).send({ error: 'invalid role' });
    }
    if (!isValidAdminPassword(body.password)) {
      return reply.code(400).send({ error: 'invalid password' });
    }
    if (await store.getByUsername(username)) {
      return reply.code(409).send({ error: 'username already exists' });
    }

    let user: AdminUserRow;
    try {
      user = await store.create({
        id: randomUUID(),
        username,
        passwordHash: hashAdminPassword(body.password),
        role,
      });
    } catch (error) {
      if (error instanceof UsernameTakenError) {
        return reply.code(409).send({ error: 'username already exists' });
      }
      throw error;
    }
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.put('/sumire/admin/users/:id/role', { preHandler: ownerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = readJsonBody(req.body) ?? {};
    const role = body.role;
    if (!isAdminRole(role)) return reply.code(400).send({ error: 'invalid role' });

    const target = await store.getById(id);
    if (!target) return reply.code(404).send({ error: 'user not found' });
    if (target.id === req.adminUser!.id && role !== 'owner') {
      return reply.code(409).send({ error: 'cannot demote yourself' });
    }

    if (role !== target.role) {
      try {
        await store.setRole(id, role);
      } catch (error) {
        if (error instanceof LastOwnerError) {
          return reply.code(409).send({ error: 'cannot demote the last enabled owner' });
        }
        throw error;
      }
      await store.deleteSessionsForUser(id);
    }
    const updated = await store.getById(id);
    return { user: publicUser(updated ?? { ...target, role }) };
  });

  app.post('/sumire/admin/users/:id/disable', { preHandler: ownerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await store.getById(id);
    if (!target) return reply.code(404).send({ error: 'user not found' });
    if (target.id === req.adminUser!.id) {
      return reply.code(409).send({ error: 'cannot disable yourself' });
    }

    try {
      await store.setDisabled(id, true);
    } catch (error) {
      if (error instanceof LastOwnerError) {
        return reply.code(409).send({ error: 'cannot disable the last enabled owner' });
      }
      throw error;
    }
    await store.deleteSessionsForUser(id);
    return { user: publicUser({ ...target, disabled: true }) };
  });

  app.post('/sumire/admin/users/:id/enable', { preHandler: ownerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await store.getById(id);
    if (!target) return reply.code(404).send({ error: 'user not found' });
    await store.setDisabled(id, false);
    return { user: publicUser({ ...target, disabled: false }) };
  });

  app.post('/sumire/admin/users/:id/password', { preHandler: ownerOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = readJsonBody(req.body) ?? {};
    if (!isValidAdminPassword(body.password)) {
      return reply.code(400).send({ error: 'invalid password' });
    }
    const target = await store.getById(id);
    if (!target) return reply.code(404).send({ error: 'user not found' });

    await store.setPasswordHash(id, hashAdminPassword(body.password));
    await store.deleteSessionsForUser(id);
    return reply.code(204).send();
  });
};
