// Admin NPC roster API tests. Unit-level: memory admin + roster stores and
// `fastify.inject`, so no Postgres or listener is needed.
//
//   node --test src/routes/adminRosters.test.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { beforeEach } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { npcRosters } from '../live/data/npcRosters.ts';
import { hashAdminPassword, LoginLimiter } from '../services/admin/auth.ts';
import {
  memoryAdminStore,
  type AdminRole,
  type AdminStore,
} from '../services/admin/store.ts';
import {
  initEventRegistry,
  resetEventRegistryForTests,
} from '../services/events/registry.ts';
import { memoryEventStore } from '../services/events/store.ts';
import {
  initRosterCache,
  resetRosterCacheForTests,
} from '../services/rosters/cache.ts';
import { memoryRosterStore, type RosterStore } from '../services/rosters/store.ts';
import { adminRoutes } from './admin.ts';
import { adminRosterRoutes } from './adminRosters.ts';

const PASSWORD = 'correct horse battery';
// Authored in the checked-in constant, so `rosterUsage` reports a main-story
// quest reference and the roster counts as shared.
const ROSTER_ID = 'qt-main-1-007-04';

const ROLES: AdminRole[] = ['viewer', 'editor', 'publisher', 'owner'];
const RANK: Record<AdminRole, number> = { viewer: 1, editor: 2, publisher: 3, owner: 4 };

interface TestApp {
  app: FastifyInstance;
  adminStore: AdminStore;
  rosterStore: RosterStore;
}

// Stubbed quest ids keep the routes off the master DB. The authored roster id
// is itself a main-story quest id, so existing usage expectations hold.
function makeApp(
  rosterStore: RosterStore = memoryRosterStore(),
  questIds: () => Promise<Set<string>> = async () => new Set([ROSTER_ID]),
): TestApp {
  const adminStore = memoryAdminStore();
  const app = Fastify();
  app.register(cookie);
  app.register(adminRoutes, { store: adminStore, limiter: new LoginLimiter() });
  app.register(adminRosterRoutes, { admin: { store: adminStore }, questIds });
  return { app, adminStore, rosterStore };
}

function seedUser(
  store: AdminStore,
  username: string,
  role: AdminRole,
  password = PASSWORD,
): Promise<{ id: string; username: string }> {
  return store.create({
    id: randomUUID(),
    username,
    passwordHash: hashAdminPassword(password),
    role,
    disabled: false,
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
  return header.split(';')[0] as string;
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
): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { csrfToken: string; user: { id: string } };
  return { cookie: sessionCookie(res), csrfToken: body.csrfToken, userId: body.user.id };
}

function withCsrf(session: Session): Record<string, string> {
  return { cookie: session.cookie, 'x-sumire-csrf': session.csrfToken };
}

function call(
  app: FastifyInstance,
  session: Session,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: withCsrf(session),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function loginRole(
  app: FastifyInstance,
  store: AdminStore,
  role: AdminRole,
): Promise<Session> {
  const username = `role-${role}`;
  await seedUser(store, username, role);
  return loginAs(app, username);
}

/** A valid roster in the API's camelCase shape. */
function rosterBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '対戦アイドル',
    managerLevel: 31,
    cards: [
      { CardId: 'card-a', Position: 1, Level: 31, Rarity: 5, LightFanAmount: 100, MiddleFanAmount: 10, HeavyFanAmount: 1, EvolutionLevel: 0 },
      { CardId: 'card-b', Position: 2, Level: 31, Rarity: 5, LightFanAmount: 100, MiddleFanAmount: 10, HeavyFanAmount: 1, EvolutionLevel: 0 },
      { CardId: 'card-c', Position: 3, Level: 31, Rarity: 5, LightFanAmount: 100, MiddleFanAmount: 10, HeavyFanAmount: 1, EvolutionLevel: 0 },
      { CardId: 'card-d', Position: 4, Level: 31, Rarity: 5, LightFanAmount: 100, MiddleFanAmount: 10, HeavyFanAmount: 1, EvolutionLevel: 0 },
      { CardId: 'card-e', Position: 5, Level: 31, Rarity: 5, LightFanAmount: 100, MiddleFanAmount: 10, HeavyFanAmount: 1, EvolutionLevel: 0 },
    ],
    ...overrides,
  };
}

async function seedRosters(store: RosterStore): Promise<void> {
  await initRosterCache({ store });
}

beforeEach(() => {
  resetRosterCacheForTests();
  resetEventRegistryForTests();
});

// Role matrix

interface Probe {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  min: AdminRole;
  body?: (role: AdminRole) => Record<string, unknown>;
}

const PROBES: Probe[] = [
  { method: 'GET', url: '/sumire/admin/rosters', min: 'viewer' },
  { method: 'GET', url: `/sumire/admin/rosters/${ROSTER_ID}`, min: 'viewer' },
  {
    method: 'PUT',
    url: `/sumire/admin/rosters/${ROSTER_ID}`,
    min: 'editor',
    body: () => rosterBody({ confirmShared: true }),
  },
  {
    method: 'POST',
    url: '/sumire/admin/rosters',
    min: 'editor',
    body: (role) => ({ id: `matrix-create-${role}`, ...rosterBody() }),
  },
  {
    method: 'POST',
    url: `/sumire/admin/rosters/${ROSTER_ID}/duplicate`,
    min: 'editor',
    body: (role) => ({ newId: `matrix-copy-${role}` }),
  },
];

test('role matrix: every roster route enforces its minimum role', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);

  const sessions = {} as Record<AdminRole, Session>;
  for (const role of ROLES) {
    sessions[role] = await loginRole(app, adminStore, role);
  }

  for (const role of ROLES) {
    for (const probe of PROBES) {
      const payload = probe.body?.(role);
      const res = await call(app, sessions[role], probe.method, probe.url, payload);
      const label = `${role} ${probe.method} ${probe.url}`;
      if (RANK[role] >= RANK[probe.min]) {
        assert.ok(
          res.statusCode !== 401 && res.statusCode !== 403,
          `${label} should be allowed, got ${res.statusCode}: ${res.body}`,
        );
      } else {
        assert.equal(res.statusCode, 403, `${label}: ${res.body}`);
      }
    }
  }

  for (const probe of PROBES) {
    const res = await app.inject({
      method: probe.method,
      url: probe.url,
      ...(probe.body === undefined
        ? {}
        : { payload: probe.body('owner') as Record<string, unknown> }),
    });
    assert.equal(res.statusCode, 401, `no session ${probe.method} ${probe.url}: ${res.body}`);
  }

  for (const probe of PROBES) {
    if (probe.method === 'GET') continue;
    const res = await app.inject({
      method: probe.method,
      url: probe.url,
      headers: { cookie: sessions.owner.cookie },
      ...(probe.body === undefined
        ? {}
        : { payload: probe.body('owner') as Record<string, unknown> }),
    });
    assert.equal(res.statusCode, 403, `missing csrf ${probe.method} ${probe.url}: ${res.body}`);
    assert.equal((res.json() as { error?: string }).error, 'invalid csrf token');
  }
});

// Reads

test('GET / lists rosters with usage counts and GET /:id includes usage', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);
  const viewer = await loginRole(app, adminStore, 'viewer');

  const list = await call(app, viewer, 'GET', '/sumire/admin/rosters');
  assert.equal(list.statusCode, 200, list.body);
  const rows = list.json() as {
    id: string;
    name: string;
    managerLevel: number;
    usageCount: number;
  }[];
  assert.equal(rows.length, Object.keys(npcRosters).length);
  const row = rows.find((entry) => entry.id === ROSTER_ID);
  assert.ok(row);
  assert.equal(row.usageCount, 1);

  const detail = await call(app, viewer, 'GET', `/sumire/admin/rosters/${ROSTER_ID}`);
  assert.equal(detail.statusCode, 200, detail.body);
  const body = detail.json() as {
    id: string;
    name: string;
    managerLevel: number;
    cards: unknown[];
    usage: { quests: string[]; events: unknown[] };
  };
  assert.equal(body.id, ROSTER_ID);
  assert.equal(body.managerLevel, npcRosters[ROSTER_ID]?.ManagerLevel);
  assert.equal(body.cards.length, npcRosters[ROSTER_ID]?.Cards.length);
  assert.deepEqual(body.usage.quests, [ROSTER_ID]);
  assert.deepEqual(body.usage.events, []);

  const missing = await call(app, viewer, 'GET', '/sumire/admin/rosters/nope');
  assert.equal(missing.statusCode, 404, missing.body);
});

// Writes

test('PUT requires confirmShared for a shared roster, then saves', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const blocked = await call(app, editor, 'PUT', `/sumire/admin/rosters/${ROSTER_ID}`, rosterBody());
  assert.equal(blocked.statusCode, 409, blocked.body);
  const conflict = blocked.json() as {
    code: string;
    usage: { quests: string[]; events: unknown[] };
  };
  assert.equal(conflict.code, 'shared-roster');
  assert.deepEqual(conflict.usage.quests, [ROSTER_ID]);

  const saved = await call(
    app,
    editor,
    'PUT',
    `/sumire/admin/rosters/${ROSTER_ID}`,
    rosterBody({ name: 'Renamed roster', confirmShared: true }),
  );
  assert.equal(saved.statusCode, 200, saved.body);
  const body = saved.json() as { id: string; name: string; updatedBy: string };
  assert.equal(body.id, ROSTER_ID);
  assert.equal(body.name, 'Renamed roster');
  assert.equal(body.updatedBy, editor.userId);

  const detail = await call(app, editor, 'GET', `/sumire/admin/rosters/${ROSTER_ID}`);
  assert.equal((detail.json() as { name: string }).name, 'Renamed roster');
});

test('PUT saves when the quest id is not master data and one event stage uses the roster', async (t) => {
  const { app, adminStore, rosterStore } = makeApp(memoryRosterStore(), async () => new Set());
  t.after(() => app.close());
  await seedRosters(rosterStore);
  // One marathon stage maps its quest id to the roster; the quest id is absent
  // from the stubbed master set, so only the single stage counts as usage.
  await initEventRegistry({
    store: memoryEventStore(),
    drafts: [
      {
        kind: 'marathon',
        draft: {
          id: 'marathon-single-stage',
          name: 'Single stage event',
          type: 1,
          boxGachas: {},
          npcRosters: { 'quest-event-only': ROSTER_ID },
        },
      },
    ],
  });
  const editor = await loginRole(app, adminStore, 'editor');

  const detail = await call(app, editor, 'GET', `/sumire/admin/rosters/${ROSTER_ID}`);
  assert.equal(detail.statusCode, 200, detail.body);
  const usage = (detail.json() as { usage: { quests: string[]; events: unknown[] } }).usage;
  assert.deepEqual(usage.quests, []);
  assert.equal(usage.events.length, 1);

  const saved = await call(
    app,
    editor,
    'PUT',
    `/sumire/admin/rosters/${ROSTER_ID}`,
    rosterBody({ name: 'Event-only rename' }),
  );
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((saved.json() as { name: string }).name, 'Event-only rename');
});

test('PUT requires confirmShared when the roster quest id is in master data', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const blocked = await call(app, editor, 'PUT', `/sumire/admin/rosters/${ROSTER_ID}`, rosterBody());
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.deepEqual(
    (blocked.json() as { usage: { quests: string[] } }).usage.quests,
    [ROSTER_ID],
  );

  const saved = await call(
    app,
    editor,
    'PUT',
    `/sumire/admin/rosters/${ROSTER_ID}`,
    rosterBody({ confirmShared: true }),
  );
  assert.equal(saved.statusCode, 200, saved.body);
});

test('PUT rejects an invalid roster with 400 and unknown ids with 404', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const invalid = await call(
    app,
    editor,
    'PUT',
    `/sumire/admin/rosters/${ROSTER_ID}`,
    rosterBody({ name: '', confirmShared: true }),
  );
  assert.equal(invalid.statusCode, 400, invalid.body);
  const errors = (invalid.json() as { errors: string[] }).errors;
  assert.ok(errors.some((error) => error.includes('Name must not be empty')));

  const unknown = await call(
    app,
    editor,
    'PUT',
    '/sumire/admin/rosters/no-such-roster',
    rosterBody({ confirmShared: true }),
  );
  assert.equal(unknown.statusCode, 404, unknown.body);
});

test('duplicate creates a copy, then 409s on the same id', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const created = await call(app, editor, 'POST', `/sumire/admin/rosters/${ROSTER_ID}/duplicate`, {
    newId: 'copy-of-roster',
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json() as { id: string; cards: unknown[]; name: string };
  assert.equal(body.id, 'copy-of-roster');
  assert.equal(body.cards.length, npcRosters[ROSTER_ID]?.Cards.length);
  assert.equal(body.name, npcRosters[ROSTER_ID]?.Name);

  const again = await call(app, editor, 'POST', `/sumire/admin/rosters/${ROSTER_ID}/duplicate`, {
    newId: 'copy-of-roster',
  });
  assert.equal(again.statusCode, 409, again.body);

  const missing = await call(app, editor, 'POST', '/sumire/admin/rosters/nope/duplicate', {
    newId: 'another-copy',
  });
  assert.equal(missing.statusCode, 404, missing.body);

  const invalidId = await call(app, editor, 'POST', `/sumire/admin/rosters/${ROSTER_ID}/duplicate`, {
    newId: 'bad id!',
  });
  assert.equal(invalidId.statusCode, 400, invalidId.body);
});

test('POST / creates a roster and it shows up in the list and detail', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const created = await call(app, editor, 'POST', '/sumire/admin/rosters', {
    id: 'new-roster',
    ...rosterBody({ name: 'New roster' }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json() as {
    id: string;
    name: string;
    managerLevel: number;
    cards: unknown[];
    updatedBy: string;
  };
  assert.equal(body.id, 'new-roster');
  assert.equal(body.name, 'New roster');
  assert.equal(body.managerLevel, 31);
  assert.equal(body.cards.length, 5);
  assert.equal(body.updatedBy, editor.userId);

  const detail = await call(app, editor, 'GET', '/sumire/admin/rosters/new-roster');
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal((detail.json() as { name: string }).name, 'New roster');

  const list = await call(app, editor, 'GET', '/sumire/admin/rosters');
  const row = (list.json() as { id: string; usageCount: number }[]).find(
    (entry) => entry.id === 'new-roster',
  );
  assert.ok(row);
  assert.equal(row.usageCount, 0);
});

test('POST / rejects an invalid roster id with 400', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const res = await call(app, editor, 'POST', '/sumire/admin/rosters', {
    id: 'bad id!',
    ...rosterBody(),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal((res.json() as { error?: string }).error, 'invalid roster id');
});

test('POST / rejects an existing DB roster and an existing seed roster with 409', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const first = await call(app, editor, 'POST', '/sumire/admin/rosters', {
    id: 'existing-roster',
    ...rosterBody(),
  });
  assert.equal(first.statusCode, 201, first.body);

  // Written by the previous create, so it is a DB roster.
  const duplicateDb = await call(app, editor, 'POST', '/sumire/admin/rosters', {
    id: 'existing-roster',
    ...rosterBody(),
  });
  assert.equal(duplicateDb.statusCode, 409, duplicateDb.body);
  assert.equal((duplicateDb.json() as { error?: string }).error, 'roster already exists');

  // Seeded from the checked-in constant by `initRosterCache`.
  const duplicateSeed = await call(app, editor, 'POST', '/sumire/admin/rosters', {
    id: ROSTER_ID,
    ...rosterBody(),
  });
  assert.equal(duplicateSeed.statusCode, 409, duplicateSeed.body);
  assert.equal((duplicateSeed.json() as { error?: string }).error, 'roster already exists');
});

test('POST / rejects an invalid roster with 400 and its validation errors', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const res = await call(app, editor, 'POST', '/sumire/admin/rosters', {
    id: 'invalid-roster',
    ...rosterBody({ name: '' }),
  });
  assert.equal(res.statusCode, 400, res.body);
  const errors = (res.json() as { errors: string[] }).errors;
  assert.ok(errors.some((error) => error.includes('Name must not be empty')));
  const missing = await call(app, editor, 'GET', '/sumire/admin/rosters/invalid-roster');
  assert.equal(missing.statusCode, 404, missing.body);
});

test('concurrent POSTs for one id produce one 201 and one 409', async (t) => {
  const { app, adminStore, rosterStore } = makeApp();
  t.after(() => app.close());
  await seedRosters(rosterStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const attempt = () =>
    call(app, editor, 'POST', '/sumire/admin/rosters', {
      id: 'racing-roster',
      ...rosterBody(),
    });
  const [a, b] = await Promise.all([attempt(), attempt()]);
  const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
  assert.deepEqual(statuses, [201, 409]);
});

test('duplicate maps a unique violation from a concurrent insert to 409', async (t) => {
  const base = memoryRosterStore();
  const racing: RosterStore = {
    ...base,
    async upsertRoster(id, roster, updatedBy) {
      if (id === 'race-copy') {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        });
      }
      return base.upsertRoster(id, roster, updatedBy);
    },
  };
  const { app, adminStore } = makeApp(racing);
  t.after(() => app.close());
  await seedRosters(racing);
  const editor = await loginRole(app, adminStore, 'editor');

  const created = await call(app, editor, 'POST', `/sumire/admin/rosters/${ROSTER_ID}/duplicate`, {
    newId: 'race-copy',
  });
  assert.equal(created.statusCode, 409, created.body);
  assert.equal((created.json() as { error?: string }).error, 'roster already exists');
});
