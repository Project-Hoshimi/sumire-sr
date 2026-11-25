// Race persistence tests: the `RaceState:<raceId>` / `RaceDecks:<raceId>`
// singletons against the configured Postgres. Skips (with a message) when the
// database is unreachable so the pure suites still run without a server.
//
//   node --test src/services/race/state.db.test.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { client, db } from '../../db/client.ts';
import {
  loadRaceDecks,
  loadRaceState,
  markRaceInitialLogin,
  saveRaceDeck,
  saveRaceState,
} from './state.ts';

const RACE_ID = 'race-26-0226';
const accountId = `test-race-${randomUUID()}`;
const playerId = `test-race-player-${randomUUID()}`;

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
  try {
    await db.execute(sql`delete from player_entities where player_id = ${playerId}`);
    await db.execute(sql`delete from players where id = ${playerId}`);
    await db.execute(sql`delete from accounts where id = ${accountId}`);
  } catch {
    // Nothing was created when the database is unreachable.
  }
  await client.end({ timeout: 5 });
});

async function createPlayer(t: { skip: (message: string) => void }): Promise<boolean> {
  if (!(await dbAvailable())) {
    t.skip('dev postgres is not reachable; run `npm run db:migrate` and retry');
    return false;
  }
  await db.execute(sql`
    insert into accounts (id, display_name) values (${accountId}, 'race test')
    on conflict (id) do nothing
  `);
  await db.execute(sql`
    insert into players (id, account_id, name) values (${playerId}, ${accountId}, 'race test')
    on conflict (id) do nothing
  `);
  return true;
}

test('race state persists and the initial-login flag flips once', async (t) => {
  if (!(await createPlayer(t))) return;
  const empty = await loadRaceState(playerId, RACE_ID);
  assert.equal(empty.initialized, false);
  assert.equal(empty.panelNumber, 0);

  assert.equal(markRaceInitialLogin(empty), true);
  empty.areaIndex = 2;
  empty.panelNumber = 7;
  empty.totalClearPanelCount = 6;
  empty.pendingVenus = true;
  empty.currentLivePanelScore = 12345;
  empty.liveBonuses['race_live_bonus-active_skill_score_multiply'] = 2;
  empty.medalsSpentOnBonuses = 4000;
  empty.cardCoolTimes['card-1'] = 1_800_000_000_000;
  empty.areaQuestClear['race-qt-26-0226-pt'] = 3;
  empty.areaQuestTierReachedAt.pt = { '3': 1_700_000_000_000 };
  empty.areaQuestHighScore['race-qt-26-0226-pt'] = { '2': 70000 };
  empty.lastActivityReceiveMs = 1_700_000_000_000;
  empty.readStoryEpisodes = [1, 2];
  await saveRaceState(playerId, RACE_ID, empty);

  const loaded = await loadRaceState(playerId, RACE_ID);
  assert.deepEqual(loaded, empty);
  assert.equal(markRaceInitialLogin(loaded), false);
});

test('saveRaceDeck then loadRaceDecks round-trips the stored deck', async (t) => {
  if (!(await createPlayer(t))) return;
  const before = await loadRaceDecks(playerId, RACE_ID);
  assert.deepEqual(before, { decks: [], positions: [] });

  await saveRaceDeck(
    playerId,
    RACE_ID,
    {
      Number: 2,
      Name: 'race deck',
      Positions: [
        { Number: 2, Position: 1, CardId: 'card-a', Part1AccessoryId: 'acce-1', PhotoIds: ['photo-1'] },
        { Number: 2, Position: 2, CardId: 'card-b' },
        { Number: 2, Position: 3, CardId: '' },
      ],
    },
    db,
  );

  const after_ = await loadRaceDecks(playerId, RACE_ID);
  assert.deepEqual(after_.decks, [{ Number: 2, Name: 'race deck' }]);
  assert.equal(after_.positions.length, 2);
  assert.deepEqual(
    after_.positions.map((position) => [position.Number, position.Position, position.CardId]),
    [
      [2, 1, 'card-a'],
      [2, 2, 'card-b'],
    ],
  );
  assert.equal(after_.positions[0].Part1AccessoryId, 'acce-1');
  assert.deepEqual(after_.positions[0].PhotoIds, ['photo-1']);

  // Saving the same deck number replaces it instead of appending.
  await saveRaceDeck(
    playerId,
    RACE_ID,
    { Number: 2, Name: 'renamed', Positions: [{ Number: 2, Position: 1, CardId: 'card-c' }] },
    db,
  );
  const replaced = await loadRaceDecks(playerId, RACE_ID);
  assert.deepEqual(replaced.decks, [{ Number: 2, Name: 'renamed' }]);
  assert.deepEqual(
    replaced.positions.map((position) => position.CardId),
    ['card-c'],
  );
});
