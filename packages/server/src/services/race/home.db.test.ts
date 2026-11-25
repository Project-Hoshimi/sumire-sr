// `Home:Enter` race-state initialisation against the dev Postgres.
//
//   npm run test:race
//
// Publishes `race-26-0226` into an in-memory event registry and drives the real
// `Home:Enter` / `Race:Top` handlers through `getHandler`: the starting race
// points must be granted by `Home:Enter` (inside `CommonResponse.UpdatedData`),
// exactly once, and `Race:Top` must then report a non-initial login and grant
// nothing. Skips when the database is unreachable.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test, type TestContext } from 'node:test';
import { sql } from 'drizzle-orm';
import '@sumire-sr/protocol/gen/registry.ts';
import { client, db } from '../../db/client.ts';
import { accounts, players } from '../../db/schema.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { decodeMessage, Reader } from '@sumire-sr/protocol/runtime/proto.ts';
import HomeEnterResponse from '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_HomeEnterResponse.ts';
import { initEventRegistry, resetEventRegistryForTests } from '../events/registry.ts';
import { memoryEventStore } from '../events/store.ts';
import { getHandler, type RpcContext } from '../handlers.ts';
import { getItemAmount } from '../inventory.ts';
import { loadCorpus } from '../replay/corpus.ts';
// Registers `Home:Enter` (the handler this test drives) and, through it, the
// race module.
import '../home.ts';
import { raceConfigFor } from './catalog.ts';
import { racePlugin } from './plugin.ts';
import { loadRaceState } from './state.ts';
import type { RaceConfig } from './types.ts';
import './index.ts';

const RACE_ID = 'race-26-0226';

let available = false;
let config: RaceConfig | undefined;
const created: { accountId: string; playerId: string }[] = [];

function ready(t: TestContext): boolean {
  if (available && config !== undefined) return true;
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
  const loaded = raceConfigFor(RACE_ID);
  available = imported.includes(RACE_ID) && loaded !== undefined;
  if (loaded !== undefined) config = loaded;
});

after(async () => {
  for (const entry of created) {
    try {
      await db.execute(sql`delete from player_entities where player_id = ${entry.playerId}`);
      await db.execute(sql`delete from players where id = ${entry.playerId}`);
      await db.execute(sql`delete from accounts where id = ${entry.accountId}`);
    } catch {
      // Nothing was created when the database is unreachable.
    }
  }
  resetEventRegistryForTests();
  await client.end({ timeout: 5 });
});

async function newPlayer(): Promise<{ accountId: string; playerId: string }> {
  const suffix = randomUUID();
  const accountId = `test-race-home-${suffix}`;
  const playerId = `test-race-home-player-${suffix}`;
  await db
    .insert(accounts)
    .values({ id: accountId, displayName: `race home ${suffix.slice(0, 8)}` })
    .onConflictDoNothing();
  await db
    .insert(players)
    .values({ id: playerId, accountId, name: `race-home-${suffix.slice(0, 8)}` })
    .onConflictDoNothing();
  const entry = { accountId, playerId };
  created.push(entry);
  return entry;
}

function rpcContext(accountId: string, request: Decoded): RpcContext {
  return {
    name: 'test',
    service: 'Race',
    method: 'test',
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
  return (await handler(rpcContext(accountId, request))) as Decoded;
}

/**
 * `Home:Enter` answers with the encoded payload instead of a decoded object
 * (the router decodes it), so decode it here. The server loads the captured
 * corpus at boot; do the same so the test takes the corpus body path.
 */
async function callHomeEnter(accountId: string): Promise<Decoded> {
  loadCorpus();
  const bytes = (await call('Home:Enter', accountId)) as unknown as Buffer;
  return decodeMessage(HomeEnterResponse, new Reader(Uint8Array.from(bytes))) as Decoded;
}

/** Rows of `CommonResponse.UpdatedData.Items` carrying `itemId`. */
function updatedItemRows(response: Decoded, itemId: string): Decoded[] {
  const updated = (response.CommonResponse as Decoded | undefined)?.UpdatedData as Decoded | undefined;
  const rows = updated?.Items;
  const items = Array.isArray(rows) ? (rows as Decoded[]) : [];
  return items.filter((row) => String(row.ItemId ?? '') === itemId);
}

/** `HomeEventInfo.RaceInfos` ids of a `Home:Enter` response. */
function homeRaceIds(response: Decoded): string[] {
  const eventInfo = response.EventInfo as Decoded | undefined;
  const infos = Array.isArray(eventInfo?.RaceInfos) ? (eventInfo!.RaceInfos as Decoded[]) : [];
  return infos.map((row) => String(row.Id ?? ''));
}

test('Home:Enter initialises the open race once and Race:Top grants nothing', async (t) => {
  if (!ready(t)) return;
  const { accountId, playerId } = await newPlayer();
  const ptItemId = config!.racePointItemId;
  const startingPoints = config!.initialRacePointAmount;
  assert.ok(startingPoints > 0, 'race-26-0226 must declare starting race points');

  // First home payload: the race banner row plus the one-off starting points.
  const enter = await callHomeEnter(accountId);
  assert.ok(homeRaceIds(enter).includes(RACE_ID), 'Home:Enter must list the open race');
  const granted = updatedItemRows(enter, ptItemId);
  assert.equal(granted.length, 1, 'Home:Enter must carry exactly one race point row');
  assert.equal(Number(granted[0].Amount), startingPoints);
  assert.equal(await getItemAmount(playerId, ptItemId), startingPoints);

  const state = await loadRaceState(playerId, RACE_ID);
  assert.equal(state.initialized, true);
  assert.ok(state.lastActivityReceiveMs > 0, 'the activity-lesson clock starts with the state');

  // Second home payload: the state exists, so nothing is granted again.
  const again = await callHomeEnter(accountId);
  assert.equal(updatedItemRows(again, ptItemId).length, 0);
  assert.equal(await getItemAmount(playerId, ptItemId), startingPoints);
  assert.deepEqual(await loadRaceState(playerId, RACE_ID), state);

  // Race:Top is the fallback initialiser; it must not re-grant.
  const top = await call('Race:Top', accountId, { RaceId: RACE_ID });
  assert.equal(top.IsInitialLogin, false);
  assert.equal(updatedItemRows(top, ptItemId).length, 0);
  assert.equal(await getItemAmount(playerId, ptItemId), startingPoints);
});
