// Admin auth + user management tests. Unit-level: the memory store and
// `fastify.inject`, so no Postgres or listener is needed.
//
//   node --test src/services/admin/admin.test.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { adminRoutes } from '../../routes/admin.ts';
import { registerInviteRoutes } from '../../routes/invites.ts';
import { LOGIN_LIMITER_MAX_KEYS, LoginLimiter, hashAdminPassword } from './auth.ts';
import {
  LastOwnerError,
  UsernameTakenError,
  memoryAdminStore,
  type AdminRole,
  type AdminStore,
} from './store.ts';

const PASSWORD = 'correct horse battery';
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const HOUR = HOUR_MS;

interface TestApp {
  app: FastifyInstance;
  store: AdminStore;
  clock: { current: Date };
}

function makeApp(opts: { invites?: boolean; store?: AdminStore } = {}): TestApp {
  const store = opts.store ?? memoryAdminStore();
  const clock = { current: new Date('2026-01-01T00:00:00.000Z') };
  const now = () => clock.current;
  const app = Fastify();
  app.register(cookie);
  app.register(adminRoutes, { store, limiter: new LoginLimiter(), now });
  if (opts.invites) registerInviteRoutes(app, { store, now });
  return { app, store, clock };
}

function seedUser(
  store: AdminStore,
  username: string,
  role: AdminRole,
  password = PASSWORD,
  disabled = false,
): Promise<{ id: string; username: string }> {
  return store.create({
    id: randomUUID(),
    username,
    passwordHash: hashAdminPassword(password),
    role,
    disabled,
  });
}

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const header = setCookies(res).find((value) => value.startsWith('sumire_admin='));
  assert.ok(header, 'expected a sumire_admin cookie');
  return header.split(';')[0];
}

interface Session {
  cookie: string;
  csrfToken: string;
  userId: string;
}

async function loginAs(
  app: FastifyInstance,
  username: string,
  password = PASSWORD,
  remoteAddress = '127.0.0.1',
): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username, password },
    remoteAddress,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { csrfToken: string; user: { id: string } };
  return { cookie: sessionCookie(res), csrfToken: body.csrfToken, userId: body.user.id };
}

function withCsrf(session: Session): Record<string, string> {
  return { cookie: session.cookie, 'x-sumire-csrf': session.csrfToken };
}

test('bootstrap creates the first owner once, then 409', async (t) => {
  process.env.SUMIRE_ADMIN_TOKEN = 'boot-token';
  const { app } = makeApp();
  t.after(() => app.close());

  const first = await app.inject({
    method: 'POST',
    url: '/sumire/admin/bootstrap',
    headers: { authorization: 'Bearer boot-token' },
    payload: { username: 'Admin', password: PASSWORD },
  });
  assert.equal(first.statusCode, 201, first.body);
  const created = first.json() as { user: Record<string, unknown> };
  assert.equal(created.user.username, 'admin');
  assert.equal(created.user.role, 'owner');
  assert.equal(created.user.disabled, false);
  assert.equal(created.user.passwordHash, undefined);

  const second = await app.inject({
    method: 'POST',
    url: '/sumire/admin/bootstrap',
    headers: { authorization: 'Bearer boot-token' },
    payload: { username: 'second', password: PASSWORD },
  });
  assert.equal(second.statusCode, 409);
});

test('bootstrap answers 404 without the env token and 401/403 with a bad token', async (t) => {
  const { app } = makeApp();
  t.after(() => app.close());

  delete process.env.SUMIRE_ADMIN_TOKEN;
  const disabled = await app.inject({
    method: 'POST',
    url: '/sumire/admin/bootstrap',
    headers: { authorization: 'Bearer anything' },
    payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(disabled.statusCode, 404);

  process.env.SUMIRE_ADMIN_TOKEN = 'right-token';
  const missing = await app.inject({
    method: 'POST',
    url: '/sumire/admin/bootstrap',
    payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(missing.statusCode, 401);

  const wrong = await app.inject({
    method: 'POST',
    url: '/sumire/admin/bootstrap',
    headers: { authorization: 'Bearer wrong-token' },
    payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(wrong.statusCode, 403);
});

test('login sets a hardened cookie and returns the CSRF token', async (t) => {
  const { app, store } = makeApp();
  t.after(() => app.close());
  await seedUser(store, 'owner', 'owner');

  const res = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username: 'OWNER', password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { csrfToken: string; user: { username: string; role: string; passwordHash?: string } };
  assert.equal(body.user.username, 'owner');
  assert.equal(body.user.role, 'owner');
  assert.equal(body.user.passwordHash, undefined);
  assert.ok(body.csrfToken.length >= 40);

  const header = setCookies(res).find((value) => value.startsWith('sumire_admin='));
  assert.ok(header);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\/sumire\/admin/);
  assert.match(header, /Max-Age=43200/);
});

test('wrong password and unknown user share the generic 401', async (t) => {
  const { app, store } = makeApp();
  t.after(() => app.close());
  await seedUser(store, 'owner', 'owner');

  const wrong = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username: 'owner', password: 'wrong password!!' },
  });
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(wrong.json(), { error: 'invalid credentials' });

  const unknown = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username: 'nobody', password: PASSWORD },
  });
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(unknown.json(), { error: 'invalid credentials' });
});

test('five failures lock the username for 15 minutes even with the right password', async (t) => {
  const { app, store, clock } = makeApp();
  t.after(() => app.close());
  await seedUser(store, 'owner', 'owner');

  for (let i = 0; i < 5; i += 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/sumire/admin/login',
      payload: { username: 'owner', password: 'nope nope nope' },
    });
    assert.equal(res.statusCode, 401);
  }

  const locked = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username: 'owner', password: PASSWORD },
  });
  assert.equal(locked.statusCode, 429);
  assert.deepEqual(locked.json(), { error: 'account locked' });

  clock.current = new Date(clock.current.getTime() + 15 * MINUTE_MS + 1);
  const unlocked = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username: 'owner', password: PASSWORD },
  });
  assert.equal(unlocked.statusCode, 200, unlocked.body);
});

test('twenty failures from one IP trigger the IP limit', async (t) => {
  const { app } = makeApp();
  t.after(() => app.close());

  for (let i = 0; i < 20; i += 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/sumire/admin/login',
      payload: { username: `user${i}`, password: 'definitely wrong' },
      remoteAddress: '203.0.113.9',
    });
    assert.equal(res.statusCode, 401);
  }

  const limited = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username: 'someone-else', password: 'definitely wrong' },
    remoteAddress: '203.0.113.9',
  });
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.json(), { error: 'too many attempts' });

  const otherIp = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username: 'someone-else', password: 'definitely wrong' },
    remoteAddress: '203.0.113.10',
  });
  assert.equal(otherIp.statusCode, 401);
});

test('session idles out after two hours', async (t) => {
  const { app, store, clock } = makeApp();
  t.after(() => app.close());
  await seedUser(store, 'viewer', 'viewer');
  const session = await loginAs(app, 'viewer');

  const live = await app.inject({
    method: 'GET',
    url: '/sumire/admin/session',
    headers: { cookie: session.cookie },
  });
  assert.equal(live.statusCode, 200);

  clock.current = new Date(clock.current.getTime() + 2 * HOUR_MS + 1);
  const expired = await app.inject({
    method: 'GET',
    url: '/sumire/admin/session',
    headers: { cookie: session.cookie },
  });
  assert.equal(expired.statusCode, 401);
});

test('session dies at the absolute 12 hour expiry even while active', async (t) => {
  const { app, store, clock } = makeApp();
  t.after(() => app.close());
  await seedUser(store, 'viewer', 'viewer');
  const session = await loginAs(app, 'viewer');

  for (let hour = 1; hour <= 11; hour += 1) {
    clock.current = new Date(clock.current.getTime() + HOUR);
    const res = await app.inject({
      method: 'GET',
      url: '/sumire/admin/session',
      headers: { cookie: session.cookie },
    });
    assert.equal(res.statusCode, 200, `hour ${hour}: ${res.body}`);
  }

  clock.current = new Date(clock.current.getTime() + HOUR + 1);
  const expired = await app.inject({
    method: 'GET',
    url: '/sumire/admin/session',
    headers: { cookie: session.cookie },
  });
  assert.equal(expired.statusCode, 401);
});

test('CSRF header is required for session-authenticated writes', async (t) => {
  const { app, store } = makeApp();
  t.after(() => app.close());
  await seedUser(store, 'owner', 'owner');
  const session = await loginAs(app, 'owner');

  const missing = await app.inject({
    method: 'POST',
    url: '/sumire/admin/logout',
    headers: { cookie: session.cookie },
  });
  assert.equal(missing.statusCode, 403);

  const wrong = await app.inject({
    method: 'POST',
    url: '/sumire/admin/logout',
    headers: { cookie: session.cookie, 'x-sumire-csrf': 'not-the-token' },
  });
  assert.equal(wrong.statusCode, 403);

  const ok = await app.inject({
    method: 'POST',
    url: '/sumire/admin/logout',
    headers: withCsrf(session),
  });
  assert.equal(ok.statusCode, 204);

  const after = await app.inject({
    method: 'GET',
    url: '/sumire/admin/session',
    headers: { cookie: session.cookie },
  });
  assert.equal(after.statusCode, 401);
});

test('owner-only user routes enforce the role matrix', async (t) => {
  const { app, store } = makeApp();
  t.after(() => app.close());
  await seedUser(store, 'owner', 'owner');
  await seedUser(store, 'viewer', 'viewer');
  await seedUser(store, 'editor', 'editor');
  await seedUser(store, 'publisher', 'publisher');

  for (const role of ['viewer', 'editor', 'publisher'] as const) {
    const session = await loginAs(app, role);
    const res = await app.inject({
      method: 'GET',
      url: '/sumire/admin/users',
      headers: { cookie: session.cookie },
    });
    assert.equal(res.statusCode, 403, `${role} must be forbidden`);
  }

  const owner = await loginAs(app, 'owner');
  const allowed = await app.inject({
    method: 'GET',
    url: '/sumire/admin/users',
    headers: { cookie: owner.cookie },
  });
  assert.equal(allowed.statusCode, 200);
  const users = allowed.json() as Array<Record<string, unknown>>;
  assert.equal(users.length, 4);
  assert.ok(users.every((user) => user.passwordHash === undefined));
});

test('an owner cannot disable or demote themselves, and the last owner stays enabled', async (t) => {
  const { app, store } = makeApp();
  t.after(() => app.close());
  const owner = await seedUser(store, 'owner', 'owner');
  const second = await seedUser(store, 'second', 'owner');
  const session = await loginAs(app, 'owner');

  const selfDisable = await app.inject({
    method: 'POST',
    url: `/sumire/admin/users/${owner.id}/disable`,
    headers: withCsrf(session),
  });
  assert.equal(selfDisable.statusCode, 409);

  const selfDemote = await app.inject({
    method: 'PUT',
    url: `/sumire/admin/users/${owner.id}/role`,
    headers: withCsrf(session),
    payload: { role: 'viewer' },
  });
  assert.equal(selfDemote.statusCode, 409);

  // Disabling the other owner is fine: the actor remains an enabled owner.
  const disableSecond = await app.inject({
    method: 'POST',
    url: `/sumire/admin/users/${second.id}/disable`,
    headers: withCsrf(session),
  });
  assert.equal(disableSecond.statusCode, 200, disableSecond.body);

  // Re-enable it, then verify the last-owner guard on a fresh single-owner app.
  const enableSecond = await app.inject({
    method: 'POST',
    url: `/sumire/admin/users/${second.id}/enable`,
    headers: withCsrf(session),
  });
  assert.equal(enableSecond.statusCode, 200);

  const solo = makeApp();
  t.after(() => solo.app.close());
  const only = await seedUser(solo.store, 'only', 'owner');
  const onlySession = await loginAs(solo.app, 'only');
  const disableOnly = await solo.app.inject({
    method: 'POST',
    url: `/sumire/admin/users/${only.id}/disable`,
    headers: withCsrf(onlySession),
  });
  assert.equal(disableOnly.statusCode, 409);
});

test('password reset revokes the target session and changes the password', async (t) => {
  const { app, store } = makeApp();
  t.after(() => app.close());
  const viewer = await seedUser(store, 'viewer', 'viewer');
  await seedUser(store, 'owner', 'owner');
  const viewerSession = await loginAs(app, 'viewer');
  const ownerSession = await loginAs(app, 'owner');

  const reset = await app.inject({
    method: 'POST',
    url: `/sumire/admin/users/${viewer.id}/password`,
    headers: withCsrf(ownerSession),
    payload: { password: 'a brand new password' },
  });
  assert.equal(reset.statusCode, 204, reset.body);

  const stale = await app.inject({
    method: 'GET',
    url: '/sumire/admin/session',
    headers: { cookie: viewerSession.cookie },
  });
  assert.equal(stale.statusCode, 401);

  const oldPassword = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username: 'viewer', password: PASSWORD },
  });
  assert.equal(oldPassword.statusCode, 401);

  const newPassword = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username: 'viewer', password: 'a brand new password' },
  });
  assert.equal(newPassword.statusCode, 200, newPassword.body);
});

test('a disabled user cannot log in and their existing session dies', async (t) => {
  const { app, store } = makeApp();
  t.after(() => app.close());
  const viewer = await seedUser(store, 'viewer', 'viewer');
  await seedUser(store, 'owner', 'owner');
  const viewerSession = await loginAs(app, 'viewer');
  const ownerSession = await loginAs(app, 'owner');

  const disabled = await app.inject({
    method: 'POST',
    url: `/sumire/admin/users/${viewer.id}/disable`,
    headers: withCsrf(ownerSession),
  });
  assert.equal(disabled.statusCode, 200, disabled.body);

  const deadSession = await app.inject({
    method: 'GET',
    url: '/sumire/admin/session',
    headers: { cookie: viewerSession.cookie },
  });
  assert.equal(deadSession.statusCode, 401);

  const attempt = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username: 'viewer', password: PASSWORD },
  });
  assert.equal(attempt.statusCode, 401);
  assert.deepEqual(attempt.json(), { error: 'invalid credentials' });
});

test('invite admin routes accept an owner session (with CSRF) and the bearer token', async (t) => {
  process.env.SUMIRE_ADMIN_TOKEN = 'invite-token';
  const { app, store } = makeApp({ invites: true });
  t.after(() => app.close());
  await seedUser(store, 'owner', 'owner');
  await seedUser(store, 'viewer', 'viewer');

  const unauthenticated = await app.inject({
    method: 'POST',
    url: '/sumire/admin/invites',
    payload: { uses: 0 },
  });
  assert.equal(unauthenticated.statusCode, 404);

  const bearer = await app.inject({
    method: 'POST',
    url: '/sumire/admin/invites',
    headers: { authorization: 'Bearer invite-token' },
    payload: { uses: 0 },
  });
  assert.equal(bearer.statusCode, 400, bearer.body);

  const wrongBearer = await app.inject({
    method: 'POST',
    url: '/sumire/admin/invites',
    headers: { authorization: 'Bearer nope' },
    payload: { uses: 0 },
  });
  assert.equal(wrongBearer.statusCode, 404);

  const owner = await loginAs(app, 'owner');
  const noCsrf = await app.inject({
    method: 'POST',
    url: '/sumire/admin/invites',
    headers: { cookie: owner.cookie },
    payload: { uses: 0 },
  });
  assert.equal(noCsrf.statusCode, 403);

  const ownerSession = await app.inject({
    method: 'POST',
    url: '/sumire/admin/invites',
    headers: withCsrf(owner),
    payload: { uses: 0 },
  });
  assert.equal(ownerSession.statusCode, 400, ownerSession.body);

  const viewer = await loginAs(app, 'viewer');
  const viewerSession = await app.inject({
    method: 'POST',
    url: '/sumire/admin/invites',
    headers: withCsrf(viewer),
    payload: { uses: 0 },
  });
  assert.equal(viewerSession.statusCode, 404);

  // Without SUMIRE_ADMIN_TOKEN the bearer path is gone, but owner sessions work.
  delete process.env.SUMIRE_ADMIN_TOKEN;
  const ownerWithoutToken = await app.inject({
    method: 'POST',
    url: '/sumire/admin/invites',
    headers: withCsrf(owner),
    payload: { uses: 0 },
  });
  assert.equal(ownerWithoutToken.statusCode, 400, ownerWithoutToken.body);
});

test('createFirstOwner only creates while the table is empty', async (t) => {
  const store = memoryAdminStore();
  const first = await store.createFirstOwner({
    id: randomUUID(),
    username: 'First',
    passwordHash: hashAdminPassword(PASSWORD),
    role: 'publisher',
  });
  assert.ok(first);
  assert.equal(first.username, 'first');
  assert.equal(first.role, 'owner');
  assert.equal(first.disabled, false);

  const second = await store.createFirstOwner({
    id: randomUUID(),
    username: 'second',
    passwordHash: hashAdminPassword(PASSWORD),
    role: 'owner',
  });
  assert.equal(second, null);
  assert.equal(await store.count(), 1);

  process.env.SUMIRE_ADMIN_TOKEN = 'boot-race-token';
  const { app } = makeApp({ store });
  t.after(() => app.close());
  const route = await app.inject({
    method: 'POST',
    url: '/sumire/admin/bootstrap',
    headers: { authorization: 'Bearer boot-race-token' },
    payload: { username: 'third', password: PASSWORD },
  });
  assert.equal(route.statusCode, 409);
  assert.deepEqual(route.json(), { error: 'admin already initialized' });
});

test('the store refuses to demote or disable the only enabled owner', async () => {
  const solo = memoryAdminStore();
  const only = await seedUser(solo, 'only', 'owner');
  await assert.rejects(solo.setRole(only.id, 'viewer'), LastOwnerError);
  await assert.rejects(solo.setDisabled(only.id, true), LastOwnerError);
  const unchanged = await solo.getById(only.id);
  assert.equal(unchanged?.role, 'owner');
  assert.equal(unchanged?.disabled, false);

  // A disabled owner is not an enabled owner.
  const two = memoryAdminStore();
  const first = await seedUser(two, 'first', 'owner');
  const second = await seedUser(two, 'second', 'owner');
  assert.equal(await two.setDisabled(first.id, true), true);
  await assert.rejects(two.setDisabled(second.id, true), LastOwnerError);
  await assert.rejects(two.setRole(second.id, 'viewer'), LastOwnerError);
  // Re-enabling restores headroom for the remaining owner.
  assert.equal(await two.setDisabled(first.id, false), true);
  assert.equal(await two.setDisabled(second.id, true), true);
  // Unknown ids still report "not found" rather than throwing.
  assert.equal(await two.setRole('missing', 'viewer'), false);
  assert.equal(await two.setDisabled('missing', true), false);
});

test('user routes map LastOwnerError to 409', async (t) => {
  const base = memoryAdminStore();
  await seedUser(base, 'owner', 'owner');
  const target = await seedUser(base, 'target', 'publisher');
  const store: AdminStore = {
    ...base,
    async setRole() {
      throw new LastOwnerError();
    },
    async setDisabled() {
      throw new LastOwnerError();
    },
  };
  const { app } = makeApp({ store });
  t.after(() => app.close());
  const session = await loginAs(app, 'owner');

  const demote = await app.inject({
    method: 'PUT',
    url: `/sumire/admin/users/${target.id}/role`,
    headers: withCsrf(session),
    payload: { role: 'viewer' },
  });
  assert.equal(demote.statusCode, 409, demote.body);
  assert.deepEqual(demote.json(), { error: 'cannot demote the last enabled owner' });

  const disable = await app.inject({
    method: 'POST',
    url: `/sumire/admin/users/${target.id}/disable`,
    headers: withCsrf(session),
  });
  assert.equal(disable.statusCode, 409, disable.body);
  assert.deepEqual(disable.json(), { error: 'cannot disable the last enabled owner' });
});

test('duplicate usernames throw UsernameTakenError and POST /users answers 409', async (t) => {
  const store = memoryAdminStore();
  await seedUser(store, 'dup', 'viewer');
  await assert.rejects(
    store.create({
      id: randomUUID(),
      username: 'DUP',
      passwordHash: hashAdminPassword(PASSWORD),
      role: 'viewer',
    }),
    UsernameTakenError,
  );
  await seedUser(store, 'owner', 'owner');

  const { app } = makeApp({ store });
  t.after(() => app.close());
  const session = await loginAs(app, 'owner');
  const duplicate = await app.inject({
    method: 'POST',
    url: '/sumire/admin/users',
    headers: withCsrf(session),
    payload: { username: 'Dup', password: PASSWORD, role: 'viewer' },
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.deepEqual(duplicate.json(), { error: 'username already exists' });
});

test('logout clears the admin cookie with the same hardened attributes', async (t) => {
  const { app, store } = makeApp();
  t.after(() => app.close());
  await seedUser(store, 'owner', 'owner');
  const session = await loginAs(app, 'owner');

  const res = await app.inject({
    method: 'POST',
    url: '/sumire/admin/logout',
    headers: withCsrf(session),
  });
  assert.equal(res.statusCode, 204);
  const header = setCookies(res).find((value) => value.startsWith('sumire_admin='));
  assert.ok(header);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\/sumire\/admin/);
});

test('the login limiter keeps its maps bounded and preserves active locks', () => {
  const limiter = new LoginLimiter();
  const start = Date.UTC(2026, 0, 1);
  const ip = '203.0.113.7';

  for (let i = 0; i < 10050; i += 1) limiter.recordFailure(`user${i}`, ip, start);
  assert.ok(
    limiter.usernameEntryCount <= LOGIN_LIMITER_MAX_KEYS,
    `username map: ${limiter.usernameEntryCount}`,
  );
  assert.ok(limiter.ipEntryCount <= LOGIN_LIMITER_MAX_KEYS);

  // A username locked after the sweep keeps its lock through the next sweep.
  for (let i = 0; i < 5; i += 1) limiter.recordFailure('locked-user', ip, start);
  assert.equal(limiter.check('locked-user', '198.51.100.1', start), 'locked');
  assert.ok(limiter.usernameEntryCount <= LOGIN_LIMITER_MAX_KEYS);

  // Failures outside the window are swept, not merely evicted.
  const later = start + 16 * MINUTE_MS;
  limiter.recordFailure('after-window', ip, later);
  assert.ok(limiter.usernameEntryCount <= 1, `username map: ${limiter.usernameEntryCount}`);
});
