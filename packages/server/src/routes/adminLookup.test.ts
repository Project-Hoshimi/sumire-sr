// Admin lookup API tests: viewer gate, injectable loaders, five-minute cache.
// No listener and no Postgres.
//
//   node --test src/routes/adminLookup.test.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { beforeEach } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { hashAdminPassword, LoginLimiter } from '../services/admin/auth.ts';
import {
  memoryAdminStore,
  type AdminRole,
  type AdminStore,
} from '../services/admin/store.ts';
import { adminRoutes } from './admin.ts';
import { resetTranslationsForTests } from '../services/translations.ts';
import {
  adminLookupRoutes,
  LOOKUP_QUEST_CACHE_MAX,
  LOOKUP_QUERY_MAX,
  LOOKUP_TTL_MS,
  type AdminLookupOptions,
  type LiveAbilityRowSource,
  type LiveBonusGroupRowSource,
  type LiveBonusRowSource,
  type LookupCardSource,
  type LookupItemSource,
  type LookupMarathon,
  type LookupMarathonSource,
  type LookupQuestSource,
  type LookupResourceSource,
  type LookupRewardRow,
  type SkillRowSource,
} from './adminLookup.ts';

const PASSWORD = 'correct horse battery';

// English lookups stay off unless a test points at a fixture checkout, so the
// expectations below can carry null names.
beforeEach(() => {
  delete process.env.SUMIRE_TRANSLATION_DIR;
  resetTranslationsForTests();
});

const CARDS: LookupCardSource[] = [
  { id: 'card-a', name: 'Card A', rarity: 5, characterId: 'char-a' },
  { id: 'card-b', name: null, rarity: 4, characterId: null },
];
const ITEMS: LookupItemSource[] = [
  { id: 'item-a', name: 'Item A' },
  { id: 'item-b', name: null },
];
const QUESTS: Record<string, LookupQuestSource[]> = {
  'event-a': [{ id: 'quest-1', name: 'Quest 1', order: 1 }],
  'event-b': [{ id: 'quest-2', name: null, order: 2 }],
};

const MARATHONS: LookupMarathonSource[] = [
  { id: 'mini-marathon-raid-42', questCount: 0, boxGachaCount: 3 },
  { id: 'marathon-2026-11', questCount: 4, boxGachaCount: 2 },
  { id: 'mini-marathon-1', questCount: 2, boxGachaCount: 0 },
  { id: 'legacy-event', questCount: 1, boxGachaCount: 0 },
  { id: 'marathon-raid-9', questCount: 5, boxGachaCount: 1 },
];

interface TestApp {
  app: FastifyInstance;
  adminStore: AdminStore;
}

function makeApp(overrides: Partial<AdminLookupOptions> = {}): TestApp {
  const adminStore = memoryAdminStore();
  const app = Fastify();
  app.register(cookie);
  app.register(adminRoutes, { store: adminStore, limiter: new LoginLimiter() });
  app.register(adminLookupRoutes, {
    admin: { store: adminStore },
    ...overrides,
  });
  return { app, adminStore };
}

async function seedUser(
  store: AdminStore,
  username: string,
  role: AdminRole,
): Promise<void> {
  await store.create({
    id: randomUUID(),
    username,
    passwordHash: hashAdminPassword(PASSWORD),
    role,
    disabled: false,
  });
}

async function loginCookie(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  const raw = res.headers['set-cookie'];
  const headers = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const cookieHeader = headers.find((value) => value.startsWith('sumire_admin='));
  assert.ok(cookieHeader, 'expected a sumire_admin cookie');
  return cookieHeader.split(';')[0] as string;
}

test('lookup endpoints require a session', async () => {
  const { app } = makeApp();
  try {
    for (const url of [
      '/sumire/admin/lookup/cards',
      '/sumire/admin/lookup/items',
      '/sumire/admin/lookup/quests?eventId=event-a',
      '/sumire/admin/lookup/marathons',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 401, url);
      assert.deepEqual(res.json(), { error: 'unauthorized' });
    }
  } finally {
    await app.close();
  }
});

test('a viewer can read every lookup list', async () => {
  let cardCalls = 0;
  let itemCalls = 0;
  let questCalls = 0;
  const { app, adminStore } = makeApp({
    loadCards: async () => {
      cardCalls += 1;
      return CARDS;
    },
    loadItems: async () => {
      itemCalls += 1;
      return ITEMS;
    },
    loadQuests: async (eventId) => {
      questCalls += 1;
      return QUESTS[eventId] ?? [];
    },
  });
  try {
    await seedUser(adminStore, 'viewer', 'viewer');
    const cookieHeader = await loginCookie(app, 'viewer');

    const cards = await app.inject({
      method: 'GET',
      url: '/sumire/admin/lookup/cards',
      headers: { cookie: cookieHeader },
    });
    assert.equal(cards.statusCode, 200);
    assert.deepEqual(cards.json(), [
    ...CARDS.map((row) => ({ ...row, nameEn: null, characterNameEn: null })),
  ]);

    const items = await app.inject({
      method: 'GET',
      url: '/sumire/admin/lookup/items',
      headers: { cookie: cookieHeader },
    });
    assert.equal(items.statusCode, 200);
    assert.deepEqual(items.json(), ITEMS.map((row) => ({ ...row, nameEn: null })));

    const quests = await app.inject({
      method: 'GET',
      url: '/sumire/admin/lookup/quests?eventId=event-a',
      headers: { cookie: cookieHeader },
    });
    assert.equal(quests.statusCode, 200);
    assert.deepEqual(
    quests.json(),
    QUESTS['event-a']!.map((row) => ({ ...row, nameEn: null })),
  );

    assert.deepEqual({ cardCalls, itemCalls, questCalls }, { cardCalls: 1, itemCalls: 1, questCalls: 1 });
  } finally {
    await app.close();
  }
});

test('marathon lookup maps variants and counts, sorted by id', async () => {
  let marathonCalls = 0;
  let eventCalls = 0;
  let eventIds = ['marathon-2026-11', 'legacy-event'];
  const { app, adminStore } = makeApp({
    loadMarathons: async () => {
      marathonCalls += 1;
      return MARATHONS;
    },
    loadEventIds: async () => {
      eventCalls += 1;
      return eventIds;
    },
  });
  try {
    await seedUser(adminStore, 'viewer', 'viewer');
    const cookieHeader = await loginCookie(app, 'viewer');

    const first = await app.inject({
      method: 'GET',
      url: '/sumire/admin/lookup/marathons',
      headers: { cookie: cookieHeader },
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), [
      { id: 'legacy-event', variant: 'other', questCount: 1, boxGachaCount: 0, eventDefined: true },
      { id: 'marathon-2026-11', variant: 'marathon', questCount: 4, boxGachaCount: 2, eventDefined: true },
      { id: 'marathon-raid-9', variant: 'marathon-raid', questCount: 5, boxGachaCount: 1, eventDefined: false },
      { id: 'mini-marathon-1', variant: 'mini-marathon', questCount: 2, boxGachaCount: 0, eventDefined: false },
      { id: 'mini-marathon-raid-42', variant: 'mini-marathon-raid', questCount: 0, boxGachaCount: 3, eventDefined: false },
    ]);

    // Master ids stay cached, but event-defined flags are recomputed per request.
    eventIds = ['marathon-raid-9'];
    const second = await app.inject({
      method: 'GET',
      url: '/sumire/admin/lookup/marathons',
      headers: { cookie: cookieHeader },
    });
    assert.equal(second.statusCode, 200);
    const rows = second.json() as LookupMarathon[];
    const flags = new Map(rows.map((row) => [row.id, row.eventDefined]));
    assert.equal(flags.get('legacy-event'), false);
    assert.equal(flags.get('marathon-raid-9'), true);
    assert.equal(marathonCalls, 1);
    assert.equal(eventCalls, 2);
  } finally {
    await app.close();
  }
});

test('quests require an eventId', async () => {
  const { app, adminStore } = makeApp({ loadQuests: async () => [] });
  try {
    await seedUser(adminStore, 'viewer', 'viewer');
    const cookieHeader = await loginCookie(app, 'viewer');

    for (const url of ['/sumire/admin/lookup/quests', '/sumire/admin/lookup/quests?eventId=']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
      assert.equal(res.statusCode, 400, url);
      assert.deepEqual(res.json(), { error: 'eventId is required' });
    }
  } finally {
    await app.close();
  }
});

test('quests reject an invalid eventId', async (t) => {
  let calls = 0;
  const { app, adminStore } = makeApp({
    loadQuests: async () => {
      calls += 1;
      return [];
    },
  });
  t.after(() => app.close());
  await seedUser(adminStore, 'viewer', 'viewer');
  const cookieHeader = await loginCookie(app, 'viewer');

  for (const eventId of ['bad%20id!', '-leading', 'a'.repeat(101)]) {
    const res = await app.inject({
      method: 'GET',
      url: `/sumire/admin/lookup/quests?eventId=${eventId}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(res.statusCode, 400, eventId);
    assert.deepEqual(res.json(), { error: 'invalid eventId' });
  }
  assert.equal(calls, 0);
});

test('concurrent cold lookups share one in-flight load', async (t) => {
  let calls = 0;
  let release!: (cards: LookupCardSource[]) => void;
  const pending = new Promise<LookupCardSource[]>((resolve) => {
    release = resolve;
  });
  const { app, adminStore } = makeApp({
    loadCards: () => {
      calls += 1;
      return pending;
    },
  });
  t.after(() => app.close());
  await seedUser(adminStore, 'viewer', 'viewer');
  const cookieHeader = await loginCookie(app, 'viewer');
  const request = () =>
    app.inject({ method: 'GET', url: '/sumire/admin/lookup/cards', headers: { cookie: cookieHeader } });

  const first = request();
  const second = request();
  // Let both requests reach the loader before resolving it.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  release(CARDS);

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.deepEqual(a.json(), CARDS.map((row) => ({ ...row, nameEn: null, characterNameEn: null })));
  assert.deepEqual(b.json(), CARDS.map((row) => ({ ...row, nameEn: null, characterNameEn: null })));
  assert.equal(calls, 1);
});

test('a rejected lookup is not cached', async (t) => {
  let calls = 0;
  const { app, adminStore } = makeApp({
    loadCards: async () => {
      calls += 1;
      if (calls === 1) throw new Error('loader failed');
      return CARDS;
    },
  });
  t.after(() => app.close());
  await seedUser(adminStore, 'viewer', 'viewer');
  const cookieHeader = await loginCookie(app, 'viewer');
  const request = () =>
    app.inject({ method: 'GET', url: '/sumire/admin/lookup/cards', headers: { cookie: cookieHeader } });

  const failed = await request();
  assert.equal(failed.statusCode, 500);

  const ok = await request();
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), CARDS.map((row) => ({ ...row, nameEn: null, characterNameEn: null })));
  assert.equal(calls, 2);
});

test('the quest cache evicts the oldest entry at its size cap', async (t) => {
  const questCalls = new Map<string, number>();
  const { app, adminStore } = makeApp({
    now: () => 1_000_000,
    loadQuests: async (eventId) => {
      questCalls.set(eventId, (questCalls.get(eventId) ?? 0) + 1);
      return [];
    },
  });
  t.after(() => app.close());
  await seedUser(adminStore, 'viewer', 'viewer');
  const cookieHeader = await loginCookie(app, 'viewer');
  const get = (eventId: string) =>
    app.inject({
      method: 'GET',
      url: `/sumire/admin/lookup/quests?eventId=${eventId}`,
      headers: { cookie: cookieHeader },
    });

  for (let index = 0; index <= LOOKUP_QUEST_CACHE_MAX; index += 1) {
    const res = await get(`event-${index}`);
    assert.equal(res.statusCode, 200);
  }
  // The first event was evicted when the 201st entry was inserted.
  assert.equal((await get('event-0')).statusCode, 200);
  assert.equal(questCalls.get('event-0'), 2);
  assert.equal(questCalls.get('event-1'), 1);
});

test('lists are cached for five minutes; quests are cached per event', async () => {
  let clock = 1_000_000;
  let cardCalls = 0;
  let itemCalls = 0;
  const questCalls = new Map<string, number>();

  const { app, adminStore } = makeApp({
    now: () => clock,
    loadCards: async () => {
      cardCalls += 1;
      return CARDS;
    },
    loadItems: async () => {
      itemCalls += 1;
      return ITEMS;
    },
    loadQuests: async (eventId) => {
      questCalls.set(eventId, (questCalls.get(eventId) ?? 0) + 1);
      return QUESTS[eventId] ?? [];
    },
  });

  try {
    await seedUser(adminStore, 'viewer', 'viewer');
    const cookieHeader = await loginCookie(app, 'viewer');
    const get = (url: string) =>
      app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });

    await get('/sumire/admin/lookup/cards');
    await get('/sumire/admin/lookup/cards');
    await get('/sumire/admin/lookup/items');
    await get('/sumire/admin/lookup/items');
    assert.deepEqual({ cardCalls, itemCalls }, { cardCalls: 1, itemCalls: 1 });

    await get('/sumire/admin/lookup/quests?eventId=event-a');
    await get('/sumire/admin/lookup/quests?eventId=event-a');
    await get('/sumire/admin/lookup/quests?eventId=event-b');
    await get('/sumire/admin/lookup/quests?eventId=event-b');
    assert.equal(questCalls.get('event-a'), 1);
    assert.equal(questCalls.get('event-b'), 1);

    // Just before the TTL everything is still cached.
    clock += LOOKUP_TTL_MS - 1;
    await get('/sumire/admin/lookup/cards');
    await get('/sumire/admin/lookup/quests?eventId=event-a');
    assert.equal(cardCalls, 1);
    assert.equal(questCalls.get('event-a'), 1);

    // Once the TTL has passed, both lists reload.
    clock += 2;
    await get('/sumire/admin/lookup/cards');
    await get('/sumire/admin/lookup/items');
    await get('/sumire/admin/lookup/quests?eventId=event-a');
    assert.equal(cardCalls, 2);
    assert.equal(itemCalls, 2);
    assert.equal(questCalls.get('event-a'), 2);
  } finally {
    await app.close();
  }
});

test('lookups are readable by every role', async () => {
  const { app, adminStore } = makeApp({
    loadCards: async () => CARDS,
    loadItems: async () => ITEMS,
    loadQuests: async () => [],
  });
  try {
    const roles: AdminRole[] = ['viewer', 'editor', 'publisher', 'owner'];
    for (const role of roles) {
      await seedUser(adminStore, `user-${role}`, role);
      const cookieHeader = await loginCookie(app, `user-${role}`);
      const res = await app.inject({
        method: 'GET',
        url: '/sumire/admin/lookup/cards',
        headers: { cookie: cookieHeader },
      });
      assert.equal(res.statusCode, 200, role);
    }
  } finally {
    await app.close();
  }
});

test('lookup routes attach English names from a translation checkout', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sumire-lookup-translations-'));
  const masterDir = join(root, 'local-files', 'masterTrans');
  const genericDir = join(root, 'local-files', 'genericTrans');
  mkdirSync(masterDir, { recursive: true });
  mkdirSync(genericDir, { recursive: true });
  const master = (table: string, data: Record<string, string>) => {
    writeFileSync(join(masterDir, `${table}.json`), JSON.stringify({ rule: [], data }));
  };
  master('Card', { 'card-a|name': 'Alpha EN' });
  master('Item', { 'item-a|name': 'Item EN' });
  master('MarathonQuest', { 'quest-1|name': 'Quest EN' });
  master('Character', { 'char-a|name': 'Ai EN' });
  writeFileSync(join(genericDir, 'generic.json'), JSON.stringify({ 'Quest 2 JP': 'Quest 2 EN' }));

  process.env.SUMIRE_TRANSLATION_DIR = root;
  resetTranslationsForTests();
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.SUMIRE_TRANSLATION_DIR;
    resetTranslationsForTests();
  });

  const { app, adminStore } = makeApp({
    loadCards: async () => [
      { id: 'card-a', name: 'カードA', rarity: 5, characterId: 'char-a' },
      { id: 'card-b', name: null, rarity: 4, characterId: null },
    ],
    loadItems: async () => [
      { id: 'item-a', name: 'アイテムA' },
      { id: 'item-b', name: null },
    ],
    loadQuests: async () => [
      { id: 'quest-1', name: 'クエスト1', order: 1 },
      { id: 'quest-2', name: 'Quest 2 JP', order: 2 },
    ],
  });
  t.after(() => app.close());
  await seedUser(adminStore, 'viewer', 'viewer');
  const cookieHeader = await loginCookie(app, 'viewer');
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });

  const cards = (await get('/sumire/admin/lookup/cards')).json() as unknown[];
  assert.deepEqual(cards, [
    {
      id: 'card-a',
      name: 'カードA',
      nameEn: 'Alpha EN',
      rarity: 5,
      characterId: 'char-a',
      characterNameEn: 'Ai EN',
    },
    { id: 'card-b', name: null, nameEn: null, rarity: 4, characterId: null, characterNameEn: null },
  ]);

  const items = (await get('/sumire/admin/lookup/items')).json() as unknown[];
  assert.deepEqual(items, [
    { id: 'item-a', name: 'アイテムA', nameEn: 'Item EN' },
    { id: 'item-b', name: null, nameEn: null },
  ]);

  const quests = (await get('/sumire/admin/lookup/quests?eventId=event-a')).json() as unknown[];
  assert.deepEqual(quests, [
    { id: 'quest-1', name: 'クエスト1', nameEn: 'Quest EN', order: 1 },
    { id: 'quest-2', name: 'Quest 2 JP', nameEn: 'Quest 2 EN', order: 2 },
  ]);
});

const REWARD_ROWS: LookupRewardRow[] = [
  {
    id: 'rd-basic',
    resources: [
      { resourceType: 1, resourceId: 'item-a', amount: 3 },
      { resourceType: 15, resourceId: '', amount: 100 },
    ],
  },
  {
    id: 'rd-set',
    resources: [{ resourceType: 999, resourceId: 'rd-basic', amount: 1 }],
  },
  {
    id: 'rd-auto-item',
    resources: [{ resourceType: 1, resourceId: 'item-auto', amount: 1 }],
  },
];

const GROUP_ROWS: LiveBonusGroupRowSource[] = [
  { groupId: 'group-a', liveBonusId: 'bonus-1' },
  { groupId: 'group-a', liveBonusId: 'bonus-2' },
  { groupId: 'group-b', liveBonusId: null },
];

const LIVE_BONUS_ROWS: LiveBonusRowSource[] = [
  { id: 'bonus-1', liveAbilityId: 'ability-a', level: 1 },
  { id: 'bonus-2', liveAbilityId: 'ability-a', level: 3 },
];

const LIVE_ABILITY_ROWS: LiveAbilityRowSource[] = [
  {
    id: 'ability-a',
    levels: [
      { Level: 1, Description: 'レベル1', SkillId: 'skill-a' },
      { Level: 2, Description: 'レベル2', SkillId: 'skill-a' },
      { Level: 3, Description: 'レベル3', SkillId: 'skill-a' },
      { Level: 4, Description: 'レベル4', SkillId: 'skill-a' },
    ],
  },
];

const SKILL_ROWS: SkillRowSource[] = [
  {
    id: 'skill-a',
    name: 'スキルA',
    levels: [
      { Level: 1, Description: 'スキルAレベル1' },
      { Level: 2, Description: 'スキルAレベル2' },
      { Level: 3, Description: 'スキルAレベル3' },
    ],
  },
];

const RESOURCE_ROWS: Record<number, LookupResourceSource[]> = {
  1: [
    { id: 'item-a', name: 'アイテムA' },
    { id: 'item-auto', name: '自動アイテム' },
    { id: 'item-z', name: null },
  ],
  15: [],
};

const RESOURCE_NAMES: Record<number, Record<string, string>> = {
  1: { 'item-a': 'アイテムA', 'item-auto': '自動アイテム' },
  15: {},
};

function rewardLookupOverrides(): Partial<AdminLookupOptions> {
  return {
    loadRewardRows: async (ids) => REWARD_ROWS.filter((row) => ids.includes(row.id)),
    loadAllRewards: async () => REWARD_ROWS,
    loadResourceNames: async (type, ids) =>
      new Map(
        Object.entries(RESOURCE_NAMES[type] ?? {}).filter(([id]) => ids.includes(id)),
      ),
    loadLiveBonusGroupRows: async (groupIds) =>
      GROUP_ROWS.filter((row) => groupIds.includes(row.groupId)),
    loadAllLiveBonusGroupRows: async () => GROUP_ROWS,
    loadLiveBonusRows: async (ids) => LIVE_BONUS_ROWS.filter((row) => ids.includes(row.id)),
    loadLiveAbilityRows: async (ids) =>
      LIVE_ABILITY_ROWS.filter((row) => ids.includes(row.id)),
    loadSkillRows: async (ids) => SKILL_ROWS.filter((row) => ids.includes(row.id)),
    loadResources: async (type) => RESOURCE_ROWS[type] ?? [],
  };
}

async function rewardTestApp(
  t: { after: (fn: () => unknown) => void },
  overrides: Partial<AdminLookupOptions> = {},
): Promise<{ app: FastifyInstance; cookieHeader: string }> {
  const { app, adminStore } = makeApp({ ...rewardLookupOverrides(), ...overrides });
  t.after(() => app.close());
  await seedUser(adminStore, 'viewer', 'viewer');
  const cookieHeader = await loginCookie(app, 'viewer');
  return { app, cookieHeader };
}

test('reward and live-bonus lookups require a session', async () => {
  const { app } = makeApp(rewardLookupOverrides());
  try {
    for (const url of [
      '/sumire/admin/lookup/rewards?ids=rd-basic',
      '/sumire/admin/lookup/rewards?q=item',
      '/sumire/admin/lookup/live-bonus-groups?ids=group-a',
      '/sumire/admin/lookup/live-bonus-groups?q=group',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 401, url);
      assert.deepEqual(res.json(), { error: 'unauthorized' });
    }
  } finally {
    await app.close();
  }
});

test('resolves rewards, rd_auto references and unknown ids', async (t) => {
  const { app, cookieHeader } = await rewardTestApp(t);
  const ids = [
    'rd-basic',
    'rd-set',
    'rd_auto;item;item-auto;500000',
    'rd-missing',
    'rd_auto;bogus;;1',
  ];
  const res = await app.inject({
    method: 'GET',
    url: `/sumire/admin/lookup/rewards?ids=${encodeURIComponent(ids.join(','))}`,
    headers: { cookie: cookieHeader },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), [
    {
      id: 'rd-basic',
      found: true,
      resources: [
        {
          resourceType: 1,
          typeLabel: 'Item',
          resourceId: 'item-a',
          amount: 3,
          name: 'アイテムA',
          nameEn: null,
        },
        {
          resourceType: 15,
          typeLabel: 'Stone',
          resourceId: '',
          amount: 100,
          name: null,
          nameEn: null,
        },
      ],
    },
    {
      id: 'rd-set',
      found: true,
      resources: [
        {
          resourceType: 1,
          typeLabel: 'Item',
          resourceId: 'item-a',
          amount: 3,
          name: 'アイテムA',
          nameEn: null,
        },
        {
          resourceType: 15,
          typeLabel: 'Stone',
          resourceId: '',
          amount: 100,
          name: null,
          nameEn: null,
        },
      ],
    },
    {
      id: 'rd_auto;item;item-auto;500000',
      found: true,
      resources: [
        {
          resourceType: 1,
          typeLabel: 'Item',
          resourceId: 'item-auto',
          amount: 500000,
          name: '自動アイテム',
          nameEn: null,
        },
      ],
    },
    { id: 'rd-missing', found: false, resources: [] },
    { id: 'rd_auto;bogus;;1', found: false, resources: [] },
  ]);
});

test('searches rewards by id, Japanese and English resource names', async (t) => {
  const { app, cookieHeader } = await rewardTestApp(t);
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
  const page = async (url: string) =>
    (await get(url)).json() as { items: { id: string }[]; total: number };

  const byId = await page('/sumire/admin/lookup/rewards?q=rd-bas');
  assert.deepEqual(
    byId.items.map((row) => row.id),
    ['rd-basic'],
  );
  assert.equal(byId.total, 1);

  const byJapanese = await page(
    `/sumire/admin/lookup/rewards?q=${encodeURIComponent('アイテムa')}`,
  );
  assert.deepEqual(
    byJapanese.items.map((row) => row.id),
    ['rd-basic', 'rd-set'],
  );

  const byAutoName = await page(
    `/sumire/admin/lookup/rewards?q=${encodeURIComponent('自動')}`,
  );
  assert.deepEqual(
    byAutoName.items.map((row) => row.id),
    ['rd-auto-item'],
  );

  const limited = await page('/sumire/admin/lookup/rewards?q=rd&limit=1');
  assert.equal(limited.items.length, 1);
  assert.equal(limited.total, 3);
});

test('browses rewards without a query, sorted by type, name and id', async (t) => {
  const { app, cookieHeader } = await rewardTestApp(t);
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
  type Browse = { items: { id: string }[]; total: number };

  const all = (await get('/sumire/admin/lookup/rewards')).json() as Browse;
  assert.deepEqual(
    all.items.map((row) => row.id),
    ['rd-basic', 'rd-set', 'rd-auto-item'],
  );
  assert.equal(all.total, 3);

  const paged = (await get('/sumire/admin/lookup/rewards?offset=1&limit=1')).json() as Browse;
  assert.deepEqual(
    paged.items.map((row) => row.id),
    ['rd-set'],
  );
  assert.equal(paged.total, 3);

  const stones = (await get('/sumire/admin/lookup/rewards?type=15')).json() as Browse;
  assert.deepEqual(
    stones.items.map((row) => row.id),
    ['rd-basic', 'rd-set'],
  );
  assert.equal(stones.total, 2);

  const items = (await get('/sumire/admin/lookup/rewards?type=1')).json() as Browse;
  assert.equal(items.total, 3);

  // The limit is capped at 100 even when a larger page is requested.
  const capped = (await get('/sumire/admin/lookup/rewards?limit=1000')).json() as Browse;
  assert.equal(capped.total, 3);

  const invalid = await get('/sumire/admin/lookup/rewards?type=item');
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: 'invalid type' });
});

test('lists reward resource types with counts, snake names and grantability', async (t) => {
  const rows: LookupRewardRow[] = [
    ...REWARD_ROWS,
    // Story (10) is a real reward resource but `applyGrants` cannot deliver it.
    { id: 'rd-story', resources: [{ resourceType: 10, resourceId: 'story-a', amount: 1 }] },
  ];
  const { app, cookieHeader } = await rewardTestApp(t, {
    loadRewardRows: async (ids) => rows.filter((row) => ids.includes(row.id)),
    loadAllRewards: async () => rows,
  });
  const res = await app.inject({
    method: 'GET',
    url: '/sumire/admin/lookup/resource-types',
    headers: { cookie: cookieHeader },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), [
    { resourceType: 1, typeLabel: 'Item', snakeName: 'item', count: 3, grantable: true },
    { resourceType: 10, typeLabel: 'Story', snakeName: 'story', count: 1, grantable: false },
    { resourceType: 15, typeLabel: 'Stone', snakeName: 'stone', count: 2, grantable: true },
  ]);
});

test('browses resources of a single type', async (t) => {
  const { app, cookieHeader } = await rewardTestApp(t);
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });

  const res = await get('/sumire/admin/lookup/resources?type=1');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    total: 3,
    items: [
      {
        resourceType: 1,
        typeLabel: 'Item',
        resourceId: 'item-z',
        name: null,
        nameEn: null,
      },
      {
        resourceType: 1,
        typeLabel: 'Item',
        resourceId: 'item-a',
        name: 'アイテムA',
        nameEn: null,
      },
      {
        resourceType: 1,
        typeLabel: 'Item',
        resourceId: 'item-auto',
        name: '自動アイテム',
        nameEn: null,
      },
    ],
  });

  const searched = (await get('/sumire/admin/lookup/resources?type=1&q=auto')).json() as {
    items: { resourceId: string }[];
    total: number;
  };
  assert.deepEqual(
    searched.items.map((row) => row.resourceId),
    ['item-auto'],
  );
  assert.equal(searched.total, 1);

  const paged = (await get('/sumire/admin/lookup/resources?type=1&offset=2&limit=50')).json() as {
    items: { resourceId: string }[];
    total: number;
  };
  assert.deepEqual(
    paged.items.map((row) => row.resourceId),
    ['item-auto'],
  );
  assert.equal(paged.total, 3);

  const missingType = await get('/sumire/admin/lookup/resources');
  assert.equal(missingType.statusCode, 400);
  assert.deepEqual(missingType.json(), { error: 'type is required' });

  const invalidType = await get('/sumire/admin/lookup/resources?type=nope');
  assert.equal(invalidType.statusCode, 400);
  assert.deepEqual(invalidType.json(), { error: 'invalid type' });
});


test('rejects oversized id batches', async (t) => {
  const { app, cookieHeader } = await rewardTestApp(t);
  const ids = Array.from({ length: 201 }, (_, index) => `rd-${index}`);
  const res = await app.inject({
    method: 'GET',
    url: `/sumire/admin/lookup/rewards?ids=${encodeURIComponent(ids.join(','))}`,
    headers: { cookie: cookieHeader },
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'at most 200 ids' });
});

test('rejects an over-long q on both search routes', async (t) => {
  const { app, cookieHeader } = await rewardTestApp(t);
  const tooLong = 'a'.repeat(LOOKUP_QUERY_MAX + 1);
  for (const path of [
    '/sumire/admin/lookup/rewards',
    '/sumire/admin/lookup/live-bonus-groups',
  ]) {
    const res = await app.inject({
      method: 'GET',
      url: `${path}?q=${tooLong}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(res.statusCode, 400, path);
    assert.deepEqual(res.json(), { error: 'q too long' });
  }
});

test('accepts a q at the length cap', async (t) => {
  const { app, cookieHeader } = await rewardTestApp(t);
  const atCap = 'a'.repeat(LOOKUP_QUERY_MAX);
  for (const path of [
    '/sumire/admin/lookup/rewards',
    '/sumire/admin/lookup/live-bonus-groups',
  ]) {
    const res = await app.inject({
      method: 'GET',
      url: `${path}?q=${atCap}`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { items: [], total: 0 });
  }
});

test('resolves live-bonus groups and unknown groups', async (t) => {
  const { app, cookieHeader } = await rewardTestApp(t);
  const res = await app.inject({
    method: 'GET',
    url: `/sumire/admin/lookup/live-bonus-groups?ids=${encodeURIComponent(
      'group-a,group-b,group-missing',
    )}`,
    headers: { cookie: cookieHeader },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), [
    {
      groupId: 'group-a',
      found: true,
      bonuses: [
        {
          liveBonusId: 'bonus-1',
          liveAbilityId: 'ability-a',
          level: 1,
          description: 'レベル1',
          descriptionEn: null,
          skills: [
            {
              skillId: 'skill-a',
              name: 'スキルA',
              nameEn: null,
              level: 1,
              description: 'スキルAレベル1',
              descriptionEn: null,
            },
          ],
        },
        {
          liveBonusId: 'bonus-2',
          liveAbilityId: 'ability-a',
          level: 3,
          description: 'レベル3',
          descriptionEn: null,
          skills: [
            {
              skillId: 'skill-a',
              name: 'スキルA',
              nameEn: null,
              level: 3,
              description: 'スキルAレベル3',
              descriptionEn: null,
            },
          ],
        },
      ],
    },
    { groupId: 'group-b', found: true, bonuses: [] },
    { groupId: 'group-missing', found: false, bonuses: [] },
  ]);

  const search = await app.inject({
    method: 'GET',
    url: '/sumire/admin/lookup/live-bonus-groups?q=レベル3',
    headers: { cookie: cookieHeader },
  });
  assert.equal(search.statusCode, 200, search.body);
  const found = search.json() as { items: { groupId: string }[]; total: number };
  assert.deepEqual(
    found.items.map((row) => row.groupId),
    ['group-a'],
  );
  assert.equal(found.total, 1);
});

test('browses live-bonus groups without a query', async (t) => {
  const { app, cookieHeader } = await rewardTestApp(t);
  type Browse = { items: { groupId: string; bonuses: { liveBonusId: string }[] }[]; total: number };
  const get = async (url: string) =>
    (await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } })).json() as Browse;

  const all = await get('/sumire/admin/lookup/live-bonus-groups');
  assert.deepEqual(
    all.items.map((row) => row.groupId),
    ['group-a', 'group-b'],
  );
  assert.equal(all.total, 2);

  const paged = await get('/sumire/admin/lookup/live-bonus-groups?offset=1&limit=1');
  assert.deepEqual(
    paged.items.map((row) => row.groupId),
    ['group-b'],
  );
  assert.equal(paged.total, 2);

  // Skill names and descriptions participate in the browse search too.
  const bySkill = await get('/sumire/admin/lookup/live-bonus-groups?q=スキルAレベル3');
  assert.deepEqual(
    bySkill.items.map((row) => row.groupId),
    ['group-a'],
  );
  assert.equal(bySkill.total, 1);
});


test('English live-ability descriptions use the Levels array index', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sumire-lookup-live-'));
  const masterDir = join(root, 'local-files', 'masterTrans');
  const genericDir = join(root, 'local-files', 'genericTrans');
  mkdirSync(masterDir, { recursive: true });
  mkdirSync(genericDir, { recursive: true });
  writeFileSync(
    join(masterDir, 'LiveAbility.json'),
    JSON.stringify({
      rule: [],
      data: {
        'ability-a|levels[0].description': 'Level 1 EN',
        'ability-a|levels[2].description': 'Level 3 EN',
        'ability-a|levels[3].description': 'Level 4 EN',
      },
    }),
  );

  writeFileSync(
    join(masterDir, 'Skill.json'),
    JSON.stringify({
      rule: [],
      data: {
        'skill-a|name': 'Skill A EN',
        'skill-a|levels[0].description': 'Skill Lv1 EN',
        'skill-a|levels[2].description': 'Skill Lv3 EN',
      },
    }),
  );

  writeFileSync(
    join(masterDir, 'Item.json'),
    JSON.stringify({ rule: [], data: { 'item-a|name': 'Item A EN' } }),
  );

  process.env.SUMIRE_TRANSLATION_DIR = root;
  resetTranslationsForTests();
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.SUMIRE_TRANSLATION_DIR;
    resetTranslationsForTests();
  });

  const { app, cookieHeader } = await rewardTestApp(t);
  const res = await app.inject({
    method: 'GET',
    url: '/sumire/admin/lookup/live-bonus-groups?ids=group-a',
    headers: { cookie: cookieHeader },
  });
  assert.equal(res.statusCode, 200, res.body);
  const groups = res.json() as {
    bonuses: {
      liveBonusId: string;
      descriptionEn: string | null;
      skills: { nameEn: string | null; descriptionEn: string | null }[];
    }[];
  }[];
  assert.deepEqual(
    groups[0]?.bonuses.map((bonus) => [bonus.liveBonusId, bonus.descriptionEn]),
    [
      ['bonus-1', 'Level 1 EN'],
      ['bonus-2', 'Level 3 EN'],
    ],
  );
  assert.deepEqual(
    groups[0]?.bonuses.map((bonus) =>
      bonus.skills.map((skill) => [skill.nameEn, skill.descriptionEn]),
    ),
    [
      [['Skill A EN', 'Skill Lv1 EN']],
      [['Skill A EN', 'Skill Lv3 EN']],
    ],
  );

  const resources = await app.inject({
    method: 'GET',
    url: '/sumire/admin/lookup/resources?type=1',
    headers: { cookie: cookieHeader },
  });
  assert.equal(resources.statusCode, 200, resources.body);
  const resourceItems = (
    resources.json() as { items: { resourceId: string; nameEn: string | null }[] }
  ).items;
  assert.equal(
    resourceItems.find((row) => row.resourceId === 'item-a')?.nameEn,
    'Item A EN',
  );
});
