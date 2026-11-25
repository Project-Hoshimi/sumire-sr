// Admin race live-ops routes against the configured Postgres. Skips (with a
// message) when the database is unreachable so the pure suites still run.
//
//   node --test src/services/race/adminRace.db.test.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
// Loads the generated field specs, so item rows encode and decode (`specFor`).
import '@sumire-sr/protocol/gen/registry.ts';
import { client, db } from '../../db/client.ts';
import { deleteTestPlayers } from '../../testing/deleteTestPlayers.ts';
import { adminRoutes } from '../../routes/admin.ts';
import { adminRaceRoutes, type RaceSummary } from '../../routes/adminRace.ts';
import { hashAdminPassword, LoginLimiter } from '../admin/auth.ts';
import { memoryAdminStore, type AdminRole, type AdminStore } from '../admin/store.ts';
import { grantItem } from '../inventory.ts';
import type { RaceConfig } from './types.ts';
import { emptyRaceState, markRaceInitialLogin, saveRaceState } from './state.ts';

const PASSWORD = 'correct horse battery';
const RACE_ID = 'race-admin-test';
const AREA_A = 'race-area-test-01';
const AREA_B = 'race-area-test-02';
const PANEL_COUNTS = new Map([
  [AREA_A, 4],
  [AREA_B, 2],
]);
const CONFIG = {
  raceId: RACE_ID,
  areaIds: [AREA_A, AREA_B],
  racePointItemId: 'item-race_point-test',
  raceMedalItemId: 'item-race_medal-test',
  // The race-wide VENUS fallback used before a player's difficulty is frozen.
  livePanelDifficultyNumber: 3,
} as unknown as RaceConfig;
const RACES: RaceSummary[] = [
  {
    id: RACE_ID,
    title: 'Race admin test',
    publishedVersion: 1,
    lifecycle: 'scheduled',
    schedule: [],
  },
];

const tag = randomUUID();
const accountIds = [1, 2, 3].map((n) => `test-race-admin-account-${n}-${tag}`);
const playerIds = [1, 2, 3].map((n) => `test-race-admin-player-${n}-${tag}`);
const [P1, P2, P3] = playerIds as [string, string, string];

let available: boolean | null = null;

async function dbAvailable(): Promise<boolean> {
  if (available !== null) return available;
  try {
    await db.execute(sql`select 1`);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

after(async () => {
  if (await dbAvailable()) {
    await deleteTestPlayers(playerIds, accountIds);
  }
  await client.end({ timeout: 5 });
});

async function seedPlayers(t: { skip: (message: string) => void }): Promise<boolean> {
  if (!(await dbAvailable())) {
    t.skip('dev postgres is not reachable; run `npm run db:migrate` and retry');
    return false;
  }
  const names = ['alpha', 'bravo', 'charlie'];
  for (let i = 0; i < playerIds.length; i++) {
    const publicUserId = i === 0 ? `pub-${tag}` : undefined;
    await db.execute(sql`
      insert into accounts (id, display_name) values (${accountIds[i]}, ${names[i]})
      on conflict (id) do nothing
    `);
    await db.execute(sql`
      insert into players (id, account_id, name, data)
      values (${playerIds[i]}, ${accountIds[i]}, ${names[i]},
        ${publicUserId === undefined ? sql`'{}'::jsonb` : sql`${JSON.stringify({ publicUserId })}::jsonb`})
      on conflict (id) do nothing
    `);
  }

  await db.execute(sql`delete from player_entities where player_id in (${P1}, ${P2}, ${P3})`);

  const first = emptyRaceState();
  assert.equal(markRaceInitialLogin(first), true);
  first.areaIndex = 0;
  first.panelNumber = 2;
  first.totalClearPanelCount = 10;
  first.pendingVenus = true;
  first.currentLivePanelScore = 1234;
  first.cardCoolTimes['card-1'] = 1_900_000_000_000;
  first.cardCoolTimes['card-2'] = 1_800_000_000_000;
  await saveRaceState(P1, RACE_ID, first);

  const second = emptyRaceState();
  markRaceInitialLogin(second);
  second.totalClearPanelCount = 10;
  await saveRaceState(P2, RACE_ID, second);

  const third = emptyRaceState();
  markRaceInitialLogin(third);
  third.areaIndex = 1;
  third.panelNumber = 1;
  third.totalClearPanelCount = 4;
  await saveRaceState(P3, RACE_ID, third);

  await grantItem(P1, CONFIG.racePointItemId, 5000);
  await grantItem(P1, CONFIG.raceMedalItemId, 7);
  await grantItem(P3, CONFIG.racePointItemId, 150);
  return true;
}

interface Session {
  cookie: string;
  csrfToken: string;
}

interface TestApp {
  app: FastifyInstance;
  adminStore: AdminStore;
}

function makeApp(): TestApp {
  const adminStore = memoryAdminStore();
  const app = Fastify();
  app.register(cookie);
  app.register(adminRoutes, { store: adminStore, limiter: new LoginLimiter() });
  app.register(adminRaceRoutes, {
    admin: { store: adminStore },
    configFor: (raceId) => (raceId === RACE_ID ? CONFIG : undefined),
    listRaces: async () => RACES,
    panelCountFor: async (areaIds) =>
      new Map(areaIds.map((areaId) => [areaId, PANEL_COUNTS.get(areaId) ?? 0])),
  });
  return { app, adminStore };
}

async function loginRole(app: FastifyInstance, store: AdminStore, role: AdminRole): Promise<Session> {
  // Admin usernames are at most 32 characters of [a-z0-9_.-].
  const username = `race.${role}.${randomUUID().slice(0, 8)}`;
  await store.create({
    id: randomUUID(),
    username,
    passwordHash: hashAdminPassword(PASSWORD),
    role,
    disabled: false,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/sumire/admin/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  const setCookie = res.headers['set-cookie'];
  const headers = Array.isArray(setCookie) ? setCookie : [String(setCookie ?? '')];
  const session = headers.find((value) => value.startsWith('sumire_admin='));
  assert.ok(session, 'expected a sumire_admin cookie');
  const body = res.json() as { csrfToken: string };
  return { cookie: session.split(';')[0] as string, csrfToken: body.csrfToken };
}

function call(
  app: FastifyInstance,
  session: Session,
  method: 'GET' | 'PATCH' | 'POST',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, 'x-sumire-csrf': session.csrfToken },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function setup(t: { skip: (message: string) => void }) {
  if (!(await seedPlayers(t))) return null;
  return makeApp();
}

test('role matrix: reads need viewer, writes need editor', async (t) => {
  const env = await setup(t);
  if (env === null) return;
  t.after(() => env.app.close());
  const viewer = await loginRole(env.app, env.adminStore, 'viewer');
  const editor = await loginRole(env.app, env.adminStore, 'editor');

  const probes = [
    { method: 'GET' as const, url: `/sumire/admin/races/${RACE_ID}/players` },
    { method: 'GET' as const, url: `/sumire/admin/races/${RACE_ID}/players/${P1}` },
    { method: 'GET' as const, url: `/sumire/admin/races/${RACE_ID}/ranking` },
    { method: 'GET' as const, url: '/sumire/admin/races' },
    { method: 'PATCH' as const, url: `/sumire/admin/races/${RACE_ID}/players/${P1}` },
    { method: 'POST' as const, url: `/sumire/admin/races/${RACE_ID}/players/${P1}/reset` },
  ];
  for (const probe of probes) {
    const allowed = await call(env.app, editor, probe.method, probe.url, {});
    assert.ok(allowed.statusCode !== 401 && allowed.statusCode !== 403, `${probe.method} ${probe.url}: ${allowed.body}`);
    if (probe.method === 'GET') {
      const view = await call(env.app, viewer, probe.method, probe.url);
      assert.equal(view.statusCode, 200, `${probe.method} ${probe.url}: ${view.body}`);
    } else {
      // A viewer gets 403 before body validation runs.
      const view = await call(env.app, viewer, probe.method, probe.url, {});
      assert.equal(view.statusCode, 403, `${probe.method} ${probe.url}: ${view.body}`);
    }
  }

  const anonymous = await env.app.inject({
    method: 'GET',
    url: `/sumire/admin/races/${RACE_ID}/players`,
  });
  assert.equal(anonymous.statusCode, 401);
  const noCsrf = await env.app.inject({
    method: 'PATCH',
    url: `/sumire/admin/races/${RACE_ID}/players/${P1}`,
    headers: { cookie: editor.cookie },
    payload: { panelNumber: 1 },
  });
  assert.equal(noCsrf.statusCode, 403);
});

test('published race list is returned for the page selector', async (t) => {
  const env = await setup(t);
  if (env === null) return;
  t.after(() => env.app.close());
  const viewer = await loginRole(env.app, env.adminStore, 'viewer');
  const res = await call(env.app, viewer, 'GET', '/sumire/admin/races');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { races: RACES });
});

test('player list joins identity, board position, rank and balances', async (t) => {
  const env = await setup(t);
  if (env === null) return;
  t.after(() => env.app.close());
  const viewer = await loginRole(env.app, env.adminStore, 'viewer');

  const res = await call(env.app, viewer, 'GET', `/sumire/admin/races/${RACE_ID}/players`);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    total: number;
    players: {
      playerId: string;
      userId: string;
      name: string;
      areaIndex: number;
      areaId: string;
      panelNumber: number;
      totalClearPanelCount: number;
      rank: number;
      racePoints: number;
      medals: number;
      pendingVenus: boolean;
      lastUpdated: string;
    }[];
  };
  assert.equal(body.total, 3);
  assert.deepEqual(
    body.players.map((row) => [row.name, row.rank, row.totalClearPanelCount]),
    [
      ['alpha', 1, 10],
      ['bravo', 1, 10],
      ['charlie', 3, 4],
    ],
  );
  const alpha = body.players[0]!;
  assert.equal(alpha.userId, `pub-${tag}`);
  assert.equal(alpha.areaId, AREA_A);
  assert.equal(alpha.panelNumber, 2);
  assert.equal(alpha.pendingVenus, true);
  assert.equal(alpha.racePoints, 5000);
  assert.equal(alpha.medals, 7);
  assert.ok(!Number.isNaN(Date.parse(alpha.lastUpdated)));
  assert.equal(body.players[2]!.areaId, AREA_B);

  // Public user id and display-name search.
  for (const q of [`pub-${tag}`, 'ALPHA']) {
    const found = await call(env.app, viewer, 'GET', `/sumire/admin/races/${RACE_ID}/players?q=${encodeURIComponent(q)}`);
    assert.equal(found.statusCode, 200, found.body);
    const rows = (found.json() as { total: number; players: { name: string }[] });
    assert.equal(rows.total, 1, q);
    assert.equal(rows.players[0]!.name, 'alpha');
  }

  const paged = await call(
    env.app,
    viewer,
    'GET',
    `/sumire/admin/races/${RACE_ID}/players?limit=1&offset=1`,
  );
  assert.equal(paged.statusCode, 200, paged.body);
  const page = paged.json() as { total: number; players: { name: string }[] };
  assert.equal(page.total, 3);
  assert.deepEqual(page.players.map((row) => row.name), ['bravo']);
});

test('player detail returns normalized state, balances and cool times', async (t) => {
  const env = await setup(t);
  if (env === null) return;
  t.after(() => env.app.close());
  const viewer = await loginRole(env.app, env.adminStore, 'viewer');

  const res = await call(env.app, viewer, 'GET', `/sumire/admin/races/${RACE_ID}/players/${P1}`);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    player: { playerId: string; userId: string; name: string; level: number };
    state: { initialized: boolean; areaIndex: number; totalClearPanelCount: number; cardCoolTimes: Record<string, number> };
    lessonTiers: { pt: number; medal: number } | null;
    nextTallyAt: number | null;
    racePoints: number;
    medals: number;
    cardCoolTimes: { cardId: string; endsAt: number }[];
    areas: { index: number; areaId: string; panelCount: number }[];
  };
  assert.equal(body.player.playerId, P1);
  assert.equal(body.player.userId, `pub-${tag}`);
  assert.equal(body.player.name, 'alpha');
  assert.equal(body.state.initialized, true);
  assert.equal(body.state.totalClearPanelCount, 10);
  // This test config has no schedule and no area quests, so there is no tally
  // to resolve: the detail reports unknown tiers and no next boundary.
  assert.equal(body.lessonTiers, null);
  assert.equal(body.nextTallyAt, null);
  assert.equal(body.racePoints, 5000);
  assert.equal(body.medals, 7);
  assert.deepEqual(body.cardCoolTimes, [
    { cardId: 'card-2', endsAt: 1_800_000_000_000 },
    { cardId: 'card-1', endsAt: 1_900_000_000_000 },
  ]);
  assert.deepEqual(body.areas, [
    { index: 0, areaId: AREA_A, panelCount: 4 },
    { index: 1, areaId: AREA_B, panelCount: 2 },
  ]);

  const missing = await call(env.app, viewer, 'GET', `/sumire/admin/races/${RACE_ID}/players/nope`);
  assert.equal(missing.statusCode, 404, missing.body);
  const unknownRace = await call(env.app, viewer, 'GET', '/sumire/admin/races/nope/players');
  assert.equal(unknownRace.statusCode, 404, unknownRace.body);
});

test('PATCH edits the board, balances and cool times in one transaction', async (t) => {
  const env = await setup(t);
  if (env === null) return;
  t.after(() => env.app.close());
  const editor = await loginRole(env.app, env.adminStore, 'editor');

  const res = await call(env.app, editor, 'PATCH', `/sumire/admin/races/${RACE_ID}/players/${P3}`, {
    areaIndex: 0,
    panelNumber: 3,
    loopCount: 2,
    totalClearPanelCount: 12,
    pendingVenus: true,
    currentLivePanelScore: 999,
    racePointAmount: 123,
    medalAmount: 3,
    clearCardCoolTimes: true,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    state: {
      areaIndex: number;
      panelNumber: number;
      loopCount: number;
      totalClearPanelCount: number;
      pendingVenus: boolean;
      currentLivePanelScore: number;
    };
    racePoints: number;
    medals: number;
    cardCoolTimes: unknown[];
  };
  assert.equal(body.state.areaIndex, 0);
  assert.equal(body.state.panelNumber, 3);
  assert.equal(body.state.loopCount, 2);
  assert.equal(body.state.totalClearPanelCount, 12);
  assert.equal(body.state.pendingVenus, true);
  assert.equal(body.state.currentLivePanelScore, 999);
  assert.equal(body.racePoints, 123);
  assert.equal(body.medals, 3);
  assert.deepEqual(body.cardCoolTimes, []);

  const reread = await call(env.app, editor, 'GET', `/sumire/admin/races/${RACE_ID}/players/${P3}`);
  const stored = reread.json() as {
    state: { totalClearPanelCount: number; loopCount: number };
    racePoints: number;
  };
  assert.equal(stored.state.totalClearPanelCount, 12);
  assert.equal(stored.state.loopCount, 2);
  assert.equal(stored.racePoints, 123);

  // A lowering update spends the difference without going negative.
  const lowered = await call(env.app, editor, 'PATCH', `/sumire/admin/races/${RACE_ID}/players/${P3}`, {
    racePointAmount: 0,
  });
  assert.equal(lowered.statusCode, 200, lowered.body);
  assert.equal((lowered.json() as { racePoints: number }).racePoints, 0);
});

test('PATCH validates positions against the race areas and panel counts', async (t) => {
  const env = await setup(t);
  if (env === null) return;
  t.after(() => env.app.close());
  const editor = await loginRole(env.app, env.adminStore, 'editor');
  const url = `/sumire/admin/races/${RACE_ID}/players/${P1}`;

  const cases: { body: Record<string, unknown>; error: string }[] = [
    { body: {}, error: 'no editable field in the body' },
    { body: { areaIndex: -1 }, error: 'areaIndex must be a non-negative integer' },
    { body: { areaIndex: 2 }, error: 'areaIndex must be between 0 and 1' },
    { body: { panelNumber: 5 }, error: 'panelNumber must be between 0 and 4' },
    { body: { areaIndex: 1, panelNumber: 3 }, error: 'panelNumber must be between 0 and 2' },
    { body: { racePointAmount: -5 }, error: 'racePointAmount must be a non-negative integer' },
    { body: { totalClearPanelCount: 1.5 }, error: 'totalClearPanelCount must be a non-negative integer' },
    { body: { loopCount: -1 }, error: 'loopCount must be a non-negative integer' },
    { body: { loopCount: 1.5 }, error: 'loopCount must be a non-negative integer' },
    { body: { pendingVenus: 'yes' }, error: 'pendingVenus must be a boolean' },
  ];
  for (const entry of cases) {
    const res = await call(env.app, editor, 'PATCH', url, entry.body);
    assert.equal(res.statusCode, 400, `${JSON.stringify(entry.body)}: ${res.body}`);
    assert.match((res.json() as { error: string }).error, new RegExp(entry.error));
  }

  const unchanged = await call(env.app, editor, 'GET', url);
  const state = (unchanged.json() as { state: { areaIndex: number; panelNumber: number } }).state;
  assert.equal(state.areaIndex, 0);
  assert.equal(state.panelNumber, 2);

  // Walking past the new area's last panel needs an explicit panelNumber.
  const walked = await call(env.app, editor, 'PATCH', url, { panelNumber: 3 });
  assert.equal(walked.statusCode, 200, walked.body);
  const moved = await call(env.app, editor, 'PATCH', url, { areaIndex: 1 });
  assert.equal(moved.statusCode, 400, moved.body);
  assert.match((moved.json() as { error: string }).error, /does not exist/);
  const landed = await call(env.app, editor, 'PATCH', url, { areaIndex: 1, panelNumber: 2 });
  assert.equal(landed.statusCode, 200, landed.body);
  const landedState = (landed.json() as { state: { areaIndex: number; panelNumber: number } }).state;
  assert.equal(landedState.areaIndex, 1);
  assert.equal(landedState.panelNumber, 2);
});

test('PATCH pins and unfreezes the per-player VENUS difficulty', async (t) => {
  const env = await setup(t);
  if (env === null) return;
  t.after(() => env.app.close());
  const editor = await loginRole(env.app, env.adminStore, 'editor');
  const url = `/sumire/admin/races/${RACE_ID}/players/${P1}`;
  const detailUrl = url;
  const listUrl = `/sumire/admin/races/${RACE_ID}/players`;
  type Detail = {
    state: { difficultyNumber: number | null };
    difficultyNumber: number | null;
    effectiveDifficultyNumber: number;
  };
  type ListRow = {
    playerId: string;
    difficultyNumber: number | null;
    effectiveDifficultyNumber: number;
  };
  const listRow = async (): Promise<ListRow> => {
    const res = await call(env.app, editor, 'GET', listUrl);
    assert.equal(res.statusCode, 200, res.body);
    const row = (res.json() as { players: ListRow[] }).players.find(
      (entry) => entry.playerId === P1,
    );
    assert.ok(row, 'the player is on the list');
    return row;
  };

  // The seeded states carry no frozen difficulty, so the number the VENUS live
  // actually plays at is the race-wide `livePanelDifficultyNumber` (3 here).
  const before = await call(env.app, editor, 'GET', detailUrl);
  assert.equal(before.statusCode, 200, before.body);
  const beforeBody = before.json() as Detail;
  assert.equal(beforeBody.state.difficultyNumber, null);
  assert.equal(beforeBody.difficultyNumber, null);
  assert.equal(beforeBody.effectiveDifficultyNumber, 3);
  assert.equal((await listRow()).difficultyNumber, null);
  assert.equal((await listRow()).effectiveDifficultyNumber, 3);

  const pinned = await call(env.app, editor, 'PATCH', url, { difficultyNumber: 7 });
  assert.equal(pinned.statusCode, 200, pinned.body);
  const pinnedBody = pinned.json() as Detail;
  assert.equal(pinnedBody.state.difficultyNumber, 7);
  assert.equal(pinnedBody.difficultyNumber, 7);
  assert.equal(pinnedBody.effectiveDifficultyNumber, 7);

  const detail = (await call(env.app, editor, 'GET', detailUrl)).json() as Detail;
  assert.equal(detail.state.difficultyNumber, 7);
  assert.equal(detail.difficultyNumber, 7);
  assert.equal(detail.effectiveDifficultyNumber, 7);
  const pinnedRow = await listRow();
  assert.equal(pinnedRow.difficultyNumber, 7);
  assert.equal(pinnedRow.effectiveDifficultyNumber, 7);

  // `null` unfreezes the value: the next open re-derives it from the grade, and
  // until then the race-wide fallback applies again.
  const cleared = await call(env.app, editor, 'PATCH', url, { difficultyNumber: null });
  assert.equal(cleared.statusCode, 200, cleared.body);
  const clearedBody = cleared.json() as Detail;
  assert.equal(clearedBody.state.difficultyNumber, null);
  assert.equal(clearedBody.difficultyNumber, null);
  assert.equal(clearedBody.effectiveDifficultyNumber, 3);
  const clearedRow = await listRow();
  assert.equal(clearedRow.difficultyNumber, null);
  assert.equal(clearedRow.effectiveDifficultyNumber, 3);

  for (const invalid of [9, 'x'] as const) {
    const res = await call(env.app, editor, 'PATCH', url, { difficultyNumber: invalid });
    assert.equal(res.statusCode, 400, `${JSON.stringify(invalid)}: ${res.body}`);
    assert.match(
      (res.json() as { error: string }).error,
      /difficultyNumber must be an integer between 1 and 7, or null/,
    );
  }
  // The rejected values left the unfrozen state alone.
  const afterInvalid = (await call(env.app, editor, 'GET', detailUrl)).json() as Detail;
  assert.equal(afterInvalid.difficultyNumber, null);
});

test('reset stores a fresh initialized state and leaves item balances alone', async (t) => {
  const env = await setup(t);
  if (env === null) return;
  t.after(() => env.app.close());
  const editor = await loginRole(env.app, env.adminStore, 'editor');

  const res = await call(env.app, editor, 'POST', `/sumire/admin/races/${RACE_ID}/players/${P1}/reset`, {});
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    state: {
      initialized: boolean;
      areaIndex: number;
      panelNumber: number;
      totalClearPanelCount: number;
      pendingVenus: boolean;
      cardCoolTimes: Record<string, number>;
      lastActivityReceiveMs: number;
    };
    racePoints: number;
    medals: number;
  };
  assert.equal(body.state.initialized, true);
  assert.equal(body.state.areaIndex, 0);
  assert.equal(body.state.panelNumber, 0);
  assert.equal(body.state.totalClearPanelCount, 0);
  assert.equal(body.state.pendingVenus, false);
  assert.deepEqual(body.state.cardCoolTimes, {});
  assert.ok(body.state.lastActivityReceiveMs > 0);
  // Race point and medal items are a separate balance and are not re-granted.
  assert.equal(body.racePoints, 5000);
  assert.equal(body.medals, 7);

  const missing = await call(env.app, editor, 'POST', `/sumire/admin/races/${RACE_ID}/players/nope/reset`, {});
  assert.equal(missing.statusCode, 404, missing.body);
});

test('ranking mirrors Race:Ranking order, ties and limit', async (t) => {
  const env = await setup(t);
  if (env === null) return;
  t.after(() => env.app.close());
  const viewer = await loginRole(env.app, env.adminStore, 'viewer');

  const res = await call(env.app, viewer, 'GET', `/sumire/admin/races/${RACE_ID}/ranking`);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    displayNum: number;
    ranking: {
      playerId: string;
      userId: string;
      name: string;
      clearPanelCount: number;
      rank: number;
    }[];
  };
  assert.equal(body.displayNum, 1000);
  // `raceRanking` keeps ties in database row order, which depends on how often
  // the row was rewritten; the shared competition rank is the contract.
  const rows = body.ranking
    .map((row) => [row.name, row.clearPanelCount, row.rank] as const)
    .sort((a, b) => a[2] - b[2] || a[0].localeCompare(b[0]));
  assert.deepEqual(rows, [
    ['alpha', 10, 1],
    ['bravo', 10, 1],
    ['charlie', 4, 3],
  ]);
  const alpha = body.ranking.find((row) => row.name === 'alpha')!;
  assert.equal(alpha.playerId, P1);
  assert.equal(alpha.userId, `pub-${tag}`);

  const limited = await call(env.app, viewer, 'GET', `/sumire/admin/races/${RACE_ID}/ranking?limit=2`);
  assert.equal((limited.json() as { ranking: unknown[] }).ranking.length, 2);

  const unknown = await call(env.app, viewer, 'GET', '/sumire/admin/races/nope/ranking');
  assert.equal(unknown.statusCode, 404, unknown.body);
});
