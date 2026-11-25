// Per-run race story read state against the dev Postgres and the master data.
//
//   npm run test:race
//
// Publishes `race-26-0226` into an in-memory event registry, then checks the
// override helper and the real `Story:ReadEvent` / `User:Get` handlers. Skips
// when the database is unreachable.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test, type TestContext } from 'node:test';
import { sql } from 'drizzle-orm';
import '@sumire-sr/protocol/gen/registry.ts';
import { client, db } from '../../db/client.ts';
import { accounts, players } from '../../db/schema.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { initEventRegistry, resetEventRegistryForTests } from '../events/registry.ts';
import { memoryEventStore } from '../events/store.ts';
import { getHandler, type RpcContext } from '../handlers.ts';
import { listElements, putElements } from '../playerState.ts';
import { getCorpusResponse, loadCorpus } from '../replay/corpus.ts';
import { deleteTestPlayers, isDatabaseUnreachable } from '../../testing/deleteTestPlayers.ts';
import { racePlugin } from './plugin.ts';
import { normalizeRaceState, loadRaceState } from './state.ts';
import { applyRaceStoryOverride } from './storyOverride.ts';
// Registers `Story:ReadEvent` and `User:Get` (the handlers these tests drive).
import '../story.ts';
import '../user.ts';
import './index.ts';

const RACE_ID = 'race-26-0226';
const EVENT_STORY_ID = 'st-eve-2603-race';
const EPISODE = 1;
const STORY_ID = 'st-eve-2603-race-001';
/** Inside the test schedule (2026-01-01 → 2027-01-01, exchange ends 2027-01-02). */
const INSIDE_NOW = Date.UTC(2026, 5, 1);
const AFTER_WINDOW = Date.UTC(2027, 5, 1);

/**
 * The capture corpus under DATA_DIR/captures is private game data and is not in
 * the public export, so the User:Get template test skips there instead of
 * failing on a missing capture.
 */
loadCorpus();
const MISSING_USER_GET_TEMPLATE =
  !getCorpusResponse('User:Get') &&
  'DATA_DIR/captures (the capture corpus) is private data, not in this checkout';

let available = false;
const created: { accountId: string; playerId: string }[] = [];

function ready(t: TestContext): boolean {
  if (available) return true;
  t.skip('dev postgres / race draft is not available; run `npm run db:migrate` and retry');
  return false;
}

before(async () => {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return;
  }
  const draft = await racePlugin.importFromMaster(RACE_ID);
  const { imported } = await initEventRegistry({
    store: memoryEventStore(),
    drafts: [
      {
        kind: 'race',
        draft: {
          ...draft,
          schedule: {
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2027-01-01T00:00:00Z',
            exchangeEndsAt: '2027-01-02T00:00:00Z',
          },
        },
      },
    ],
  });
  available = imported.includes(RACE_ID);
});

after(async () => {
  try {
    await deleteTestPlayers(
      created.map((entry) => entry.playerId),
      created.map((entry) => entry.accountId),
    );
  } catch (error) {
    if (!isDatabaseUnreachable(error)) throw error;
  }
  resetEventRegistryForTests();
  await client.end({ timeout: 5 });
});

async function newPlayer(): Promise<{ accountId: string; playerId: string }> {
  const suffix = randomUUID();
  const accountId = `test-race-story-${suffix}`;
  const playerId = `test-race-story-player-${suffix}`;
  await db
    .insert(accounts)
    .values({ id: accountId, displayName: `race story ${suffix.slice(0, 8)}` })
    .onConflictDoNothing();
  await db
    .insert(players)
    .values({ id: playerId, accountId, name: `race-story-${suffix.slice(0, 8)}` })
    .onConflictDoNothing();
  const entry = { accountId, playerId };
  created.push(entry);
  return entry;
}

function rpcContext(name: string, accountId: string, request: Decoded): RpcContext {
  return {
    name,
    service: name.split(':')[0] ?? '',
    method: name.split(':')[1] ?? '',
    requestShape: '',
    responseShape: '',
    request,
    requestBytes: Buffer.alloc(0),
    fastifyReq: { log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } },
    auth: {
      ok: true,
      claims: { sub: accountId, iat: 0, exp: 0, iss: 'test', aud: 'test' },
    },
  } as unknown as RpcContext;
}

async function call(name: string, accountId: string, request: Decoded = {}): Promise<Decoded> {
  const handler = getHandler(name);
  return (await handler(rpcContext(name, accountId, request))) as Decoded;
}

function storiesOf(response: Decoded): Decoded[] {
  const updated = (response.CommonResponse as Decoded | undefined)?.UpdatedData as Decoded | undefined;
  const rows = updated?.Stories;
  return Array.isArray(rows) ? (rows as Decoded[]) : [];
}

async function putStory(playerId: string, statusType: number): Promise<void> {
  await putElements(playerId, 'Stories', [
    {
      __msg: 'Solis.Common.Proto.Transaction.UserStory',
      StoryId: STORY_ID,
      StatusType: statusType,
    } as Decoded,
  ]);
}

test('a stored state without playedStoryIds normalises to an empty list', () => {
  const legacy = normalizeRaceState({ initialized: true } as Decoded);
  assert.deepEqual(legacy.playedStoryIds, []);
});

test('override serves a real read row as unread while the race is open', async (t) => {
  if (!ready(t)) return;
  const { playerId } = await newPlayer();
  await putStory(playerId, 2);
  const rows = await listElements(playerId, 'Stories');

  const served = await applyRaceStoryOverride(playerId, rows, INSIDE_NOW);
  const row = served.find((entry) => String(entry.StoryId ?? '') === STORY_ID);
  assert.ok(row !== undefined);
  assert.equal(Number(row.StatusType), 1, 'an unplayed episode is served as Unread');

  const stored = (await listElements(playerId, 'Stories')).find(
    (entry) => String(entry.StoryId ?? '') === STORY_ID,
  );
  assert.equal(Number(stored?.StatusType), 2, 'the stored row must stay Read');

  // Without an open race the real row is served unchanged.
  const closed = await applyRaceStoryOverride(playerId, rows, AFTER_WINDOW);
  const closedRow = closed.find((entry) => String(entry.StoryId ?? '') === STORY_ID);
  assert.equal(Number(closedRow?.StatusType), 2);
});

test('Story:ReadEvent marks the episode played and does not repeat the reward', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer();
  await putStory(playerId, 2);

  const response = await call('Story:ReadEvent', accountId, {
    EventStoryId: EVENT_STORY_ID,
    Episode: EPISODE,
  });
  assert.equal((response.Rewards as Decoded[]).length, 0, 'a Read row grants no reward again');
  const rows = storiesOf(response);
  assert.equal(Number(rows[0]?.StatusType), 2, 'the read response shows the row as Read');

  const state = await loadRaceState(playerId, RACE_ID);
  assert.deepEqual(state.playedStoryIds, [STORY_ID]);

  // The just-read episode is no longer overridden within this run.
  const served = await applyRaceStoryOverride(playerId, rows, INSIDE_NOW);
  assert.equal(Number(served[0]?.StatusType), 2);
});

test('a first read grants once and a second read does not', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer();
  await putStory(playerId, 1);

  const first = await call('Story:ReadEvent', accountId, {
    EventStoryId: EVENT_STORY_ID,
    Episode: EPISODE,
  });
  assert.ok((first.Rewards as Decoded[]).length > 0, 'the first read grants the story reward');
  assert.equal(Number(storiesOf(first)[0]?.StatusType), 2);

  const second = await call('Story:ReadEvent', accountId, {
    EventStoryId: EVENT_STORY_ID,
    Episode: EPISODE,
  });
  assert.equal((second.Rewards as Decoded[]).length, 0, 'the reward is not granted twice');

  const state = await loadRaceState(playerId, RACE_ID);
  assert.deepEqual(state.playedStoryIds, [STORY_ID], 'the episode is recorded once');
});

test('User:Get serves the race episode as unread and keeps the real row read', { skip: MISSING_USER_GET_TEMPLATE }, async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer();
  await putStory(playerId, 2);

  const response = await call('User:Get', accountId);
  const rows = (response.Stories as Decoded[] | undefined) ?? [];
  const served = rows.find((entry) => String(entry.StoryId ?? '') === STORY_ID);
  assert.ok(served !== undefined, 'User:Get must carry the story row');
  assert.equal(Number(served.StatusType), 1, 'the race episode is served as Unread');

  const stored = (await listElements(playerId, 'Stories')).find(
    (entry) => String(entry.StoryId ?? '') === STORY_ID,
  );
  assert.equal(Number(stored?.StatusType), 2, 'the stored row must stay Read');
});
