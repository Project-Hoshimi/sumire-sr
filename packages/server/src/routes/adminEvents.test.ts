// Admin event/schedule API tests. Unit-level: memory admin + event stores and
// `fastify.inject`, so no listener is needed. The route's master importer is
// injected, so import-from-master stays off Postgres; the pool is only closed
// here for the files that share it.
//
//   node --test src/routes/adminEvents.test.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, beforeEach } from 'node:test';
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
import { registerEventPlugin } from '../services/events/plugin.ts';
import { memoryMarathonPlayerStateReader } from '../services/events/preview.ts';
import { deriveMarathonDraft } from '../services/marathon/importDraft.ts';
import { memoryEventStore, type EventStore } from '../services/events/store.ts';
import { client as dbClient } from '../db/client.ts';
import { catalogDrafts as moshikoiCatalogDrafts } from '../services/moshikoi/catalog.ts';
import { adminRoutes } from './admin.ts';
import { adminEventRoutes } from './adminEvents.ts';

const PASSWORD = 'correct horse battery';
const EVENT_ID = 'marathon-admin';
const QUEST_A = 'quest-a';
const QUEST_B = 'quest-b';
const ROSTER_A = Object.keys(npcRosters)[0] as string;
const ROSTER_B = Object.keys(npcRosters)[1] as string;

const ROLES: AdminRole[] = ['viewer', 'editor', 'publisher', 'owner'];
const RANK: Record<AdminRole, number> = { viewer: 1, editor: 2, publisher: 3, owner: 4 };

interface TestApp {
  app: FastifyInstance;
  adminStore: AdminStore;
  eventStore: EventStore & { reset(): void };
}

function makeApp(store: EventStore & { reset(): void } = memoryEventStore()): TestApp {
  const adminStore = memoryAdminStore();
  const eventStore = store;
  const app = Fastify();
  app.register(cookie);
  app.register(adminRoutes, { store: adminStore, limiter: new LoginLimiter() });
  // An empty in-memory player-state reader keeps publish/preview off Postgres.
  app.register(adminEventRoutes, {
    admin: { store: adminStore },
    players: memoryMarathonPlayerStateReader([]),
    // An in-memory master importer keeps import-from-master off Postgres.
    importFromMaster: async (kind, eventId) => {
      if (kind !== 'marathon') throw new Error(`no test importer for kind ${kind}`);
      return deriveMarathonDraft(eventId, {
        eventStoryAssetIdExists: false,
        eventMission: null,
        raidQuestName: null,
        boxGachaGroupId: '',
        existingItemIds: [],
      });
    },
  });
  return { app, adminStore, eventStore };
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

type WriteMethod = 'POST' | 'PUT' | 'DELETE';

function call(
  app: FastifyInstance,
  session: Session,
  method: 'GET' | WriteMethod,
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

function item(order: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order,
    itemKey: String(order),
    itemType: 1,
    rewardId: `reward-${order}`,
    initialStock: 3,
    isLimited: true,
    ...extra,
  };
}

/** A valid marathon draft with two boxes and two authored stages. */
function draft(id = EVENT_ID, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: 'Admin event',
    type: 1,
    assetId: '',
    bannerAssetId: '',
    boxGachaGroupId: '',
    initialStamina: 10,
    staminaRecoveryMinutes: 5,
    staminaRecoveryItemId: 'stamina-item',
    questUnlockItemId: 'unlock-item',
    eventMissionId: 'mission',
    order: 1,
    boxGachas: {
      box1: { items: [item(1), item(2)] },
      box2: { items: [item(1)] },
    },
    npcRosters: {
      [QUEST_A]: ROSTER_A,
      [QUEST_B]: { rosterId: ROSTER_B, levelOffset: 2 },
    },
    ...overrides,
  };
}

function boxesOf(source: Record<string, unknown>): Record<string, unknown> {
  return source.boxGachas as Record<string, unknown>;
}

async function seed(
  eventStore: EventStore,
  sources: Record<string, unknown>[] = [draft()],
): Promise<void> {
  await initEventRegistry({
    store: eventStore,
    drafts: sources.map((source) => ({ kind: 'marathon', draft: source })),
  });
}

async function loginRole(
  app: FastifyInstance,
  store: AdminStore,
  role: AdminRole,
): Promise<Session> {
  const username = `role-${role}`;
  await seedUser(store, username, role);
  return loginAs(app, username, PASSWORD);
}

beforeEach(() => {
  resetEventRegistryForTests();
});

// The admin stores are in memory, but `import-from-master` reads master rows
// through the shared Drizzle pool (`src/db/client.ts`). End it after the file so
// `node --test` has no open sockets and exits on its own.
after(() => dbClient.end({ timeout: 5 }));

// Role matrix

interface Probe {
  method: 'GET' | WriteMethod;
  url: string;
  min: AdminRole;
  /** Body per acting role, so created ids never collide between rounds. */
  body?: (role: AdminRole) => Record<string, unknown>;
}

const PROBES: Probe[] = [
  { method: 'GET', url: '/sumire/admin/events', min: 'viewer' },
  { method: 'GET', url: `/sumire/admin/events/${EVENT_ID}`, min: 'viewer' },
  { method: 'GET', url: `/sumire/admin/events/${EVENT_ID}/history/1`, min: 'viewer' },
  {
    method: 'POST',
    url: '/sumire/admin/events',
    min: 'editor',
    body: (role) => ({ id: `matrix-${role}`, kind: 'marathon', title: 'Matrix', draft: draft(`matrix-${role}`) }),
  },
  {
    method: 'PUT',
    url: `/sumire/admin/events/${EVENT_ID}/draft`,
    min: 'editor',
    body: () => ({ draft: draft(EVENT_ID, { initialStamina: 11 }) }),
  },
  {
    method: 'POST',
    url: `/sumire/admin/events/${EVENT_ID}/validate`,
    min: 'editor',
    body: () => ({}),
  },
  { method: 'GET', url: `/sumire/admin/events/${EVENT_ID}/preview`, min: 'viewer' },
  { method: 'POST', url: `/sumire/admin/events/${EVENT_ID}/publish`, min: 'publisher' },
  {
    method: 'POST',
    url: `/sumire/admin/events/${EVENT_ID}/rollback`,
    min: 'publisher',
    body: () => ({ version: 1 }),
  },
  {
    method: 'POST',
    url: '/sumire/admin/events/import-from-master',
    min: 'editor',
    body: (role) => ({ kind: 'marathon', eventId: `matrix-import-${role}` }),
  },
  { method: 'GET', url: `/sumire/admin/events/${EVENT_ID}/export`, min: 'viewer' },
  {
    method: 'PUT',
    url: `/sumire/admin/events/${EVENT_ID}/schedule`,
    min: 'publisher',
    body: () => ({
      schedules: [
        {
          startsAt: '2026-02-01T00:00:00Z',
          endsAt: '2026-02-02T00:00:00Z',
          exchangeEndsAt: '2026-02-03T00:00:00Z',
          enabled: true,
        },
      ],
    }),
  },
  { method: 'DELETE', url: `/sumire/admin/events/${EVENT_ID}`, min: 'publisher' },
];

test('role matrix: every event route enforces its minimum role', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);

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

// Drafts

test('PUT draft saves an invalid draft but reports its validation errors', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const invalid = draft(EVENT_ID, { boxInfiniteRate: 2 });
  const saved = await call(app, editor, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: invalid,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const body = saved.json() as {
    saved: boolean;
    validation: { ok: boolean; errors: { path: string; severity: string }[] };
  };
  assert.equal(body.saved, true);
  assert.equal(body.validation.ok, false);
  assert.ok(body.validation.errors.some((error) => error.path === 'boxInfiniteRate'));

  const detail = await call(app, editor, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  assert.equal(detail.statusCode, 200, detail.body);
  const stored = detail.json() as { draft: { boxInfiniteRate: number } };
  assert.equal(stored.draft.boxInfiniteRate, 2);

  const validate = await call(app, editor, 'POST', `/sumire/admin/events/${EVENT_ID}/validate`, {});
  assert.equal(validate.statusCode, 200, validate.body);
  assert.equal((validate.json() as { ok: boolean }).ok, false);
});

test('PUT draft rejects changing read-only fields and leaves them unchanged', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const rejected = await call(app, editor, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: draft(EVENT_ID, { assetId: 'asset-2' }),
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.deepEqual(rejected.json(), {
    error: 'read-only fields changed',
    paths: ['assetId'],
  });

  const detail = await call(app, editor, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  const stored = detail.json() as { draft: { assetId: string } };
  assert.equal(stored.draft.assetId, '');

  // A non-read-only field still saves.
  const editable = await call(app, editor, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: draft(EVENT_ID, { initialStamina: 25 }),
  });
  assert.equal(editable.statusCode, 200, editable.body);
  assert.equal((editable.json() as { saved: boolean }).saved, true);

  // Sending read-only values unchanged is allowed.
  const unchanged = await call(app, editor, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: draft(EVENT_ID, { assetId: '', initialStamina: 30 }),
  });
  assert.equal(unchanged.statusCode, 200, unchanged.body);

  const after = await call(app, editor, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  const afterDraft = (after.json() as { draft: { assetId: string; initialStamina: number } }).draft;
  assert.equal(afterDraft.assetId, '');
  assert.equal(afterDraft.initialStamina, 30);
});

test('malformed stored drafts and non-object draft bodies return 400', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await eventStore.createDefinition(
    {
      id: 'marathon-bad-draft',
      kind: 'marathon',
      title: 'Bad draft',
      draft: 'x',
      published: null,
      publishedVersion: 0,
      updatedBy: null,
    },
    [],
  );
  await initEventRegistry({ store: eventStore });
  const publisher = await loginRole(app, adminStore, 'publisher');

  const preview = await call(app, publisher, 'GET', '/sumire/admin/events/marathon-bad-draft/preview');
  assert.equal(preview.statusCode, 400, preview.body);
  const errors = (preview.json() as { errors: { path: string }[] }).errors;
  assert.equal(errors[0]?.path, 'draft');

  const publish = await call(app, publisher, 'POST', '/sumire/admin/events/marathon-bad-draft/publish');
  assert.equal(publish.statusCode, 400, publish.body);

  for (const draftValue of [null, 'x', [1, 2]]) {
    const saved = await call(
      app,
      publisher,
      'PUT',
      '/sumire/admin/events/marathon-bad-draft/draft',
      { draft: draftValue },
    );
    assert.equal(saved.statusCode, 400, saved.body);
    assert.equal((saved.json() as { error?: string }).error, 'draft must be an object');
  }
});

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });
}

test('unique violations on create and import map to 409', async (t) => {
  const racingStore = (racingId: string) => {
    const base = memoryEventStore();
    return {
      ...base,
      async createDefinition(
        input: Parameters<EventStore['createDefinition']>[0],
        schedule: Parameters<EventStore['createDefinition']>[1],
      ) {
        if (input.id === racingId) throw uniqueViolation();
        return base.createDefinition(input, schedule);
      },
    };
  };

  const cases = [
    {
      racingId: 'race-create',
      url: '/sumire/admin/events',
      body: { id: 'race-create', kind: 'marathon', title: 'Race', draft: draft('race-create') },
    },
    {
      racingId: 'race-import',
      url: '/sumire/admin/events/import-from-master',
      body: { kind: 'marathon', eventId: 'race-import' },
    },
  ];

  for (const item of cases) {
    const store = racingStore(item.racingId);
    const { app, adminStore } = makeApp(store);
    t.after(() => app.close());
    await initEventRegistry({ store });
    const editor = await loginRole(app, adminStore, 'editor');
    const res = await call(app, editor, 'POST', item.url, item.body);
    assert.equal(res.statusCode, 409, `${item.racingId}: ${res.body}`);
    assert.equal((res.json() as { error?: string }).error, 'event definition already exists');
  }
});

test('a unique violation on publish maps to 409', async (t) => {
  const base = memoryEventStore();
  const { app, adminStore, eventStore } = makeApp({
    ...base,
    async publish() {
      throw uniqueViolation();
    },
  });
  t.after(() => app.close());
  await seed(eventStore);
  const publisher = await loginRole(app, adminStore, 'publisher');

  const res = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/publish`);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((res.json() as { error?: string }).error, 'publish conflict, retry');
});

test('POST / validates the kind and rejects an existing id', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const unknown = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: 'some-id',
    kind: 'not-a-kind',
    title: 'X',
    draft: {},
  });
  assert.equal(unknown.statusCode, 400, unknown.body);

  const created = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: 'brand-new',
    kind: 'marathon',
    title: 'Brand new',
    draft: draft('brand-new'),
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((created.json() as { publishedVersion: number }).publishedVersion, 0);

  const duplicate = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: 'brand-new',
    kind: 'marathon',
    title: 'Brand new',
    draft: draft('brand-new'),
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
});

test('POST / trims ids and rejects ids outside the shared admin rule', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const created = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: '  brand-trim  ',
    kind: 'marathon',
    title: 'Trimmed',
    draft: draft('brand-trim'),
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((created.json() as { id: string }).id, 'brand-trim');

  for (const id of ['bad id!', '-leading', 'a'.repeat(101)]) {
    const rejected = await call(app, editor, 'POST', '/sumire/admin/events', {
      id,
      kind: 'marathon',
      title: 'Rejected',
      draft: {},
    });
    assert.equal(rejected.statusCode, 400, `${id}: ${rejected.body}`);
    assert.equal((rejected.json() as { error?: string }).error, 'invalid id');
  }
});

test('POST / without a draft uses the kind plugin default draft', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const created = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: 'default-draft',
    kind: 'marathon',
    title: 'Default draft',
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json() as {
    draft: { id?: string; name?: string; type?: number; boxGachas?: unknown };
  };
  assert.equal(body.draft.id, 'default-draft');
  assert.equal(body.draft.name, 'Default draft');
  assert.equal(body.draft.type, 1);
  assert.equal(body.draft.boxGachas, undefined);

  // An explicitly provided draft keeps the old behaviour: it is stored as sent.
  const explicit = draft('explicit-draft');
  const withDraft = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: 'explicit-draft',
    kind: 'marathon',
    title: 'Explicit',
    draft: explicit,
  });
  assert.equal(withDraft.statusCode, 201, withDraft.body);
  assert.deepEqual((withDraft.json() as { draft: unknown }).draft, explicit);

  // Present but malformed drafts are still rejected.
  const malformed = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: 'bad-draft',
    kind: 'marathon',
    title: 'Bad',
    draft: [],
  });
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.equal((malformed.json() as { error?: string }).error, 'draft must be an object');
});

test('POST / rejects an explicitly null draft', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const res = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: 'null-draft',
    kind: 'marathon',
    title: 'Null draft',
    draft: null,
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal((res.json() as { error?: string }).error, 'draft must be an object');
});

test('POST / returns 400 when the kind has no default draft', async (t) => {
  const kind = 'no-default-draft';
  registerEventPlugin({
    kind,
    schema: { fields: [] },
    parseDraft: (raw) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('stub draft must be an object');
      }
      return raw as { id?: string };
    },
    draftId: (source) => source.id ?? '',
    draftTitle: () => '',
    draftSchedule: () => undefined,
    importFromMaster: async (eventId) => ({ id: eventId }),
    validate: () => [],
    compile: (source) => source,
    stateImpact: () => [],
  });
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const editor = await loginRole(app, adminStore, 'editor');

  const res = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: 'no-default',
    kind,
    title: 'No default',
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(
    (res.json() as { error?: string }).error,
    'event kind cannot create a default draft',
  );

  // Supplying a draft still works for the same kind.
  const created = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: 'with-draft',
    kind,
    title: 'With draft',
    draft: { id: 'with-draft' },
  });
  assert.equal(created.statusCode, 201, created.body);
});

test('GET /:id exposes the plugin editor schema with read-only flags', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const viewer = await loginRole(app, adminStore, 'viewer');

  const res = await call(app, viewer, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    schema: { fields: { path: string; type: string; readOnly?: boolean }[] } | null;
  };
  assert.ok(body.schema, 'schema is present');
  const byPath = new Map(body.schema.fields.map((field) => [field.path, field]));
  assert.equal(byPath.get('id')?.readOnly, true);
  assert.equal(byPath.get('name')?.readOnly, true);
  assert.equal(byPath.get('initialStamina')?.readOnly ?? false, false);
  assert.equal(byPath.get('staminaRecoveryMinutes')?.readOnly ?? false, false);
});

test('history versions expose their published payload and publisher name', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const publisher = await loginRole(app, adminStore, 'publisher');

  const first = await call(app, publisher, 'GET', `/sumire/admin/events/${EVENT_ID}/history/1`);
  assert.equal(first.statusCode, 200, first.body);
  const v1 = first.json() as {
    version: number;
    published: { initialStamina: number };
    publishedBy: string | null;
    publishedByName: string | null;
    publishedAt: string;
  };
  assert.equal(v1.version, 1);
  assert.equal(v1.published.initialStamina, 10);
  // Catalog imports are system values, not admin ids: no username is resolved.
  assert.equal(v1.publishedBy, 'catalog-import');
  assert.equal(v1.publishedByName, null);
  assert.ok(!Number.isNaN(Date.parse(v1.publishedAt)));

  await call(app, publisher, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: draft(EVENT_ID, { initialStamina: 42 }),
  });
  const published = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/publish`);
  assert.equal(published.statusCode, 200, published.body);

  const second = await call(app, publisher, 'GET', `/sumire/admin/events/${EVENT_ID}/history/2`);
  assert.equal(second.statusCode, 200, second.body);
  const v2 = second.json() as {
    version: number;
    published: { initialStamina: number };
    publishedBy: string | null;
    publishedByName: string | null;
  };
  assert.equal(v2.version, 2);
  assert.equal(v2.published.initialStamina, 42);
  assert.equal(v2.publishedBy, publisher.userId);
  assert.equal(v2.publishedByName, 'role-publisher');

  const missing = await call(app, publisher, 'GET', `/sumire/admin/events/${EVENT_ID}/history/99`);
  assert.equal(missing.statusCode, 404, missing.body);
  const unknownEvent = await call(app, publisher, 'GET', '/sumire/admin/events/nope/history/1');
  assert.equal(unknownEvent.statusCode, 404, unknownEvent.body);

  for (const bad of ['0', '-1', 'abc', '1.5', '01x']) {
    const res = await call(app, publisher, 'GET', `/sumire/admin/events/${EVENT_ID}/history/${bad}`);
    assert.equal(res.statusCode, 400, `${bad}: ${res.body}`);
    assert.deepEqual(res.json(), { error: 'version must be a positive integer' });
  }
});

test('event detail and list resolve admin ids to usernames in one lookup', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const publisher = await loginRole(app, adminStore, 'publisher');

  let lookups = 0;
  const listByIds = adminStore.listByIds.bind(adminStore);
  adminStore.listByIds = async (ids) => {
    lookups += 1;
    return listByIds(ids);
  };

  await call(app, publisher, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: draft(EVENT_ID, { initialStamina: 42 }),
  });
  const published = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/publish`);
  assert.equal(published.statusCode, 200, published.body);

  const detail = await call(app, publisher, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  assert.equal(detail.statusCode, 200, detail.body);
  const body = detail.json() as {
    updatedBy: string | null;
    updatedByName: string | null;
    history: { publishedBy: string | null; publishedByName: string | null }[];
  };
  assert.equal(body.updatedBy, publisher.userId);
  assert.equal(body.updatedByName, 'role-publisher');
  assert.deepEqual(
    body.history.map((row) => [row.publishedBy, row.publishedByName]),
    [
      ['catalog-import', null],
      [publisher.userId, 'role-publisher'],
    ],
  );
  // Every id in the definition and its history came from a single store query.
  assert.equal(lookups, 1);

  const list = await call(app, publisher, 'GET', '/sumire/admin/events');
  assert.equal(list.statusCode, 200, list.body);
  const summaries = list.json() as { id: string; updatedByName: string | null }[];
  assert.equal(summaries.find((row) => row.id === EVENT_ID)?.updatedByName, 'role-publisher');
});

// Publishing

test('publish bumps the version and records the acting admin in history', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const publisher = await loginRole(app, adminStore, 'publisher');

  const next = draft(EVENT_ID, { initialStamina: 42 });
  const saved = await call(app, publisher, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: next,
  });
  assert.equal(saved.statusCode, 200, saved.body);

  const published = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/publish`);
  assert.equal(published.statusCode, 200, published.body);
  assert.equal((published.json() as { version: number }).version, 2);

  const detail = await call(app, publisher, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  const body = detail.json() as {
    published: { initialStamina: number };
    publishedVersion: number;
    updatedBy: string;
    history: { version: number; publishedBy: string }[];
  };
  assert.equal(body.publishedVersion, 2);
  assert.equal(body.published.initialStamina, 42);
  assert.equal(body.updatedBy, publisher.userId);
  assert.deepEqual(
    body.history.map((row) => row.version),
    [1, 2],
  );
  assert.equal(body.history[1]?.publishedBy, publisher.userId);
});

test('publish rejects validation errors with 400 and blocking impacts with 409', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const publisher = await loginRole(app, adminStore, 'publisher');

  const invalid = await call(app, publisher, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: draft(EVENT_ID, { boxInfiniteRate: 2 }),
  });
  assert.equal(invalid.statusCode, 200, invalid.body);

  const rejected = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/publish`);
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.ok(Array.isArray((rejected.json() as { errors: unknown[] }).errors));

  // An authored box item without an explicit itemKey is a blocking impact that
  // needs no player-state read (simplest blocking case from the preview tests).
  const blocking = draft(EVENT_ID, {
    boxGachas: {
      box1: {
        items: [{ order: 1, itemType: 1, rewardId: 'reward-1', initialStock: 3, isLimited: true }],
      },
      box2: boxesOf(draft()).box2,
    },
  });
  const saved = await call(app, publisher, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: blocking,
  });
  assert.equal(saved.statusCode, 200, saved.body);

  const blocked = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/publish`);
  assert.equal(blocked.statusCode, 409, blocked.body);
  const impacts = (blocked.json() as { impacts: { code: string; severity: string }[] }).impacts;
  assert.ok(impacts.some((impact) => impact.code === 'item-key-missing'));
  assert.ok(impacts.every((impact) => impact.severity === 'block'));
});

test('publish accepts the previewed draft hash and rejects a stale one', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const publisher = await loginRole(app, adminStore, 'publisher');

  const next = draft(EVENT_ID, { initialStamina: 43 });
  const saved = await call(app, publisher, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: next,
  });
  assert.equal(saved.statusCode, 200, saved.body);

  const previewResponse = await call(
    app,
    publisher,
    'GET',
    `/sumire/admin/events/${EVENT_ID}/preview`,
  );
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json() as { draftHash: string };
  assert.match(preview.draftHash, /^[0-9a-f]{64}$/);

  const stale = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/publish`, {
    expectedDraftHash: '0'.repeat(64),
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.deepEqual(stale.json(), { error: 'draft changed since preview', code: 'stale-preview' });

  const afterStale = await call(app, publisher, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  assert.equal((afterStale.json() as { publishedVersion: number }).publishedVersion, 1);

  const matched = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/publish`, {
    expectedDraftHash: preview.draftHash,
  });
  assert.equal(matched.statusCode, 200, matched.body);
  assert.equal((matched.json() as { version: number }).version, 2);

  // Omitting the body keeps the previous publish behaviour.
  const absent = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/publish`);
  assert.equal(absent.statusCode, 200, absent.body);
  assert.equal((absent.json() as { version: number }).version, 3);
});

test('rollback re-publishes an older version through the publish path', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const publisher = await loginRole(app, adminStore, 'publisher');

  await call(app, publisher, 'PUT', `/sumire/admin/events/${EVENT_ID}/draft`, {
    draft: draft(EVENT_ID, { initialStamina: 99 }),
  });
  const published = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/publish`);
  assert.equal(published.statusCode, 200, published.body);

  const rollback = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/rollback`, {
    version: 1,
  });
  assert.equal(rollback.statusCode, 200, rollback.body);
  assert.equal((rollback.json() as { version: number }).version, 3);

  const detail = await call(app, publisher, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  const body = detail.json() as {
    published: { initialStamina: number };
    publishedVersion: number;
    history: { version: number; publishedBy: string }[];
  };
  assert.equal(body.publishedVersion, 3);
  assert.equal(body.published.initialStamina, 10);
  assert.deepEqual(
    body.history.map((row) => row.version),
    [1, 2, 3],
  );
  assert.equal(body.history[2]?.publishedBy, publisher.userId);

  const unknown = await call(app, publisher, 'POST', `/sumire/admin/events/${EVENT_ID}/rollback`, {
    version: 99,
  });
  assert.equal(unknown.statusCode, 404, unknown.body);
});

// Import and export

test('import-from-master creates an unpublished draft, then 409s', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await initEventRegistry({ store: eventStore });
  const editor = await loginRole(app, adminStore, 'editor');

  const imported = await call(app, editor, 'POST', '/sumire/admin/events/import-from-master', {
    kind: 'marathon',
    eventId: 'marathon-imported',
  });
  assert.equal(imported.statusCode, 201, imported.body);
  assert.equal((imported.json() as { id: string }).id, 'marathon-imported');

  const detail = await call(app, editor, 'GET', '/sumire/admin/events/marathon-imported');
  const body = detail.json() as {
    draft: { id: string };
    published: unknown;
    publishedVersion: number;
    history: unknown[];
  };
  assert.equal(body.draft.id, 'marathon-imported');
  assert.equal(body.published, null);
  assert.equal(body.publishedVersion, 0);
  assert.deepEqual(body.history, []);

  const again = await call(app, editor, 'POST', '/sumire/admin/events/import-from-master', {
    kind: 'marathon',
    eventId: 'marathon-imported',
  });
  assert.equal(again.statusCode, 409, again.body);

  const unknownKind = await call(app, editor, 'POST', '/sumire/admin/events/import-from-master', {
    kind: 'not-a-kind',
    eventId: 'whatever',
  });
  assert.equal(unknownKind.statusCode, 400, unknownKind.body);
});

test('export downloads the requested side as an attachment', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const viewer = await loginRole(app, adminStore, 'viewer');

  const draftExport = await call(app, viewer, 'GET', `/sumire/admin/events/${EVENT_ID}/export`);
  assert.equal(draftExport.statusCode, 200, draftExport.body);
  assert.equal(
    draftExport.headers['content-disposition'],
    `attachment; filename="${EVENT_ID}.json"`,
  );
  assert.match(String(draftExport.headers['content-type']), /^application\/json/);
  const draftJson = JSON.parse(draftExport.body) as { id: string; name: string };
  assert.equal(draftJson.id, EVENT_ID);
  assert.equal(draftJson.name, 'Admin event');

  const published = await call(
    app,
    viewer,
    'GET',
    `/sumire/admin/events/${EVENT_ID}/export?which=published`,
  );
  assert.equal(published.statusCode, 200, published.body);
  assert.equal((JSON.parse(published.body) as { id: string }).id, EVENT_ID);

  const missing = await call(app, viewer, 'GET', '/sumire/admin/events/nope/export');
  assert.equal(missing.statusCode, 404, missing.body);

  const badWhich = await call(
    app,
    viewer,
    'GET',
    `/sumire/admin/events/${EVENT_ID}/export?which=both`,
  );
  assert.equal(badWhich.statusCode, 400, badWhich.body);
});

// Schedule

test('schedule replace validates windows, persists rows and reports overlap warnings', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  const OTHER_ID = 'marathon-admin-b';
  await seed(eventStore, [draft(EVENT_ID), draft(OTHER_ID)]);
  const publisher = await loginRole(app, adminStore, 'publisher');

  const invalid = await call(
    app,
    publisher,
    'PUT',
    `/sumire/admin/events/${EVENT_ID}/schedule`,
    {
      schedules: [
        {
          startsAt: '2026-02-02T00:00:00Z',
          endsAt: '2026-02-01T00:00:00Z',
          exchangeEndsAt: '2026-02-03T00:00:00Z',
          enabled: true,
        },
      ],
    },
  );
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.ok(
    (invalid.json() as { errors: string[] }).errors.some((error) =>
      error.includes('startsAt must be before endsAt'),
    ),
  );

  const first = await call(app, publisher, 'PUT', `/sumire/admin/events/${EVENT_ID}/schedule`, {
    schedules: [
      {
        startsAt: '2026-02-01T00:00:00Z',
        endsAt: '2026-02-02T00:00:00Z',
        exchangeEndsAt: '2026-02-03T00:00:00Z',
        enabled: true,
      },
    ],
  });
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = first.json() as { schedule: { eventId: string; enabled: boolean }[]; warnings: string[] };
  assert.equal(firstBody.schedule.length, 1);
  assert.equal(firstBody.schedule[0]?.eventId, EVENT_ID);
  assert.equal(firstBody.schedule[0]?.enabled, true);
  assert.deepEqual(firstBody.warnings, []);

  const second = await call(app, publisher, 'PUT', `/sumire/admin/events/${OTHER_ID}/schedule`, {
    schedules: [
      {
        startsAt: '2026-02-01T12:00:00Z',
        endsAt: '2026-02-02T12:00:00Z',
        exchangeEndsAt: '2026-02-03T12:00:00Z',
        enabled: true,
      },
    ],
  });
  assert.equal(second.statusCode, 200, second.body);
  // Overlapping marathon schedules are supported, so no warning is returned.
  assert.deepEqual((second.json() as { warnings: string[] }).warnings, []);

  const detail = await call(app, publisher, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  const schedule = (detail.json() as { schedule: { eventId: string; enabled: boolean }[] }).schedule;
  assert.equal(schedule.length, 1);
  assert.equal(schedule[0]?.eventId, EVENT_ID);
});

// Delete

test('DELETE removes the definition, schedule and history', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore, [
    draft(EVENT_ID, {
      schedule: {
        startsAt: '2026-02-01T00:00:00Z',
        endsAt: '2026-02-02T00:00:00Z',
        exchangeEndsAt: '2026-02-03T00:00:00Z',
      },
    }),
  ]);
  const publisher = await loginRole(app, adminStore, 'publisher');

  assert.equal((await eventStore.listSchedule()).length, 1);
  assert.equal((await eventStore.listHistory(EVENT_ID)).length, 1);

  const deleted = await call(app, publisher, 'DELETE', `/sumire/admin/events/${EVENT_ID}`);
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal(deleted.body, '');

  const detail = await call(app, publisher, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  assert.equal(detail.statusCode, 404, detail.body);

  const list = await call(app, publisher, 'GET', '/sumire/admin/events');
  const summaries = list.json() as { id: string }[];
  assert.equal(
    summaries.some((row) => row.id === EVENT_ID),
    false,
  );

  assert.equal((await eventStore.listSchedule()).length, 0, 'schedule rows are gone');
  assert.deepEqual(await eventStore.listHistory(EVENT_ID), [], 'history rows are gone');
  assert.equal((await eventStore.listDeleted()).has(EVENT_ID), true);
  assert.equal(await eventStore.getDefinition(EVENT_ID), undefined);
});

test('DELETE refuses a live event with 409', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  const now = Date.now();
  await seed(eventStore, [
    draft(EVENT_ID, {
      schedule: {
        startsAt: new Date(now - 60 * 60 * 1000).toISOString(),
        endsAt: new Date(now + 60 * 60 * 1000).toISOString(),
        exchangeEndsAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      },
    }),
  ]);
  const publisher = await loginRole(app, adminStore, 'publisher');

  const res = await call(app, publisher, 'DELETE', `/sumire/admin/events/${EVENT_ID}`);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(
    (res.json() as { error?: string }).error,
    'Event is live. Disable its schedule first.',
  );
  assert.ok(await eventStore.getDefinition(EVENT_ID), 'live event is not deleted');
});

test('DELETE requires the publisher role and 404s an unknown id', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const editor = await loginRole(app, adminStore, 'editor');
  const publisher = await loginRole(app, adminStore, 'publisher');

  const forbidden = await call(app, editor, 'DELETE', `/sumire/admin/events/${EVENT_ID}`);
  assert.equal(forbidden.statusCode, 403, forbidden.body);

  const missing = await call(app, publisher, 'DELETE', '/sumire/admin/events/does-not-exist');
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal((missing.json() as { error?: string }).error, 'not found');
});

test('a deleted catalog id is not resurrected by the startup import', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore);
  const publisher = await loginRole(app, adminStore, 'publisher');

  const deleted = await call(app, publisher, 'DELETE', `/sumire/admin/events/${EVENT_ID}`);
  assert.equal(deleted.statusCode, 204, deleted.body);

  // Same call the server makes on startup with the checked-in catalog drafts.
  const imported = await initEventRegistry({
    store: eventStore,
    drafts: [{ kind: 'marathon', draft: draft(EVENT_ID) }],
  });
  assert.deepEqual(imported.imported, []);
  assert.equal(await eventStore.getDefinition(EVENT_ID), undefined);
  assert.equal((await eventStore.listDeleted()).has(EVENT_ID), true);

  const created = await call(app, publisher, 'POST', '/sumire/admin/events', {
    id: EVENT_ID,
    kind: 'marathon',
    title: 'Created again',
    draft: draft(EVENT_ID),
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await eventStore.listDeleted()).has(EVENT_ID), false, 'tombstone is cleared');
});

// Moshikoi (permanent event kind)

const MOSHIKOI_ID = 'love-24-1114';

function moshikoiDraft() {
  const found = moshikoiCatalogDrafts().find((candidate) => candidate.id === MOSHIKOI_ID);
  assert.ok(found, 'checked-in moshikoi draft exists');
  return found;
}

async function seedMoshikoi(eventStore: EventStore): Promise<void> {
  await initEventRegistry({
    store: eventStore,
    drafts: [{ kind: 'moshikoi', draft: moshikoiDraft() }],
  });
}

test('event list and detail report the plugin lifecycle', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seed(eventStore, [draft()]);
  await initEventRegistry({
    store: eventStore,
    drafts: [{ kind: 'moshikoi', draft: moshikoiDraft() }],
  });
  const viewer = await loginRole(app, adminStore, 'viewer');

  const list = await call(app, viewer, 'GET', '/sumire/admin/events');
  assert.equal(list.statusCode, 200, list.body);
  const items = list.json() as { id: string; lifecycle: string }[];
  assert.equal(items.find((row) => row.id === EVENT_ID)?.lifecycle, 'scheduled');
  assert.equal(items.find((row) => row.id === MOSHIKOI_ID)?.lifecycle, 'permanent');

  const marathon = await call(app, viewer, 'GET', `/sumire/admin/events/${EVENT_ID}`);
  assert.equal(marathon.statusCode, 200, marathon.body);
  assert.equal((marathon.json() as { lifecycle: string }).lifecycle, 'scheduled');

  const moshikoi = await call(app, viewer, 'GET', `/sumire/admin/events/${MOSHIKOI_ID}`);
  assert.equal(moshikoi.statusCode, 200, moshikoi.body);
  const detail = moshikoi.json() as { lifecycle: string; schedule: unknown[] };
  assert.equal(detail.lifecycle, 'permanent');
  assert.deepEqual(detail.schedule, []);
});

test('schedule replace is rejected for a permanent moshikoi event', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await seedMoshikoi(eventStore);
  const publisher = await loginRole(app, adminStore, 'publisher');

  const res = await call(
    app,
    publisher,
    'PUT',
    `/sumire/admin/events/${MOSHIKOI_ID}/schedule`,
    {
      schedules: [
        {
          startsAt: '2026-02-01T00:00:00Z',
          endsAt: '2026-02-02T00:00:00Z',
          exchangeEndsAt: '2026-02-03T00:00:00Z',
          enabled: true,
        },
      ],
    },
  );
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(
    (res.json() as { error?: string }).error,
    'permanent events have no schedule',
  );
  assert.deepEqual(await eventStore.listSchedule(), []);
});

test('POST / without a draft creates a moshikoi event from the default draft', async (t) => {
  const { app, adminStore, eventStore } = makeApp();
  t.after(() => app.close());
  await initEventRegistry({ store: eventStore, drafts: [] });
  const editor = await loginRole(app, adminStore, 'editor');

  const created = await call(app, editor, 'POST', '/sumire/admin/events', {
    id: 'moshikoi-default',
    kind: 'moshikoi',
    title: 'New love event',
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json() as {
    draft: {
      id: string;
      title: string;
      catalog: { loveId: string };
      routes: { loveId: string };
    };
  };
  assert.equal(body.draft.id, 'moshikoi-default');
  assert.equal(body.draft.title, 'New love event');
  assert.equal(body.draft.catalog.loveId, 'moshikoi-default');
  assert.equal(body.draft.routes.loveId, 'moshikoi-default');
});
