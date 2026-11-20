// NPC roster cache tests. Pure unit tests against `memoryRosterStore`: no
// database, no game master data.
//
//   node --test src/services/rosters/cache.test.ts
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { npcRosters, type NpcRoster } from '../../live/data/npcRosters.ts';
import {
  NpcRosterValidationError,
  createNpcRoster,
  duplicateNpcRoster,
  initRosterCache,
  listRosterIds,
  resetRosterCacheForTests,
  rosterById,
  rosterCacheLoaded,
  rosterUsage,
  saveNpcRoster,
  validateNpcRoster,
} from './cache.ts';
import { memoryRosterStore } from './store.ts';

const ROSTER_ID = 'qt-main-1-007-04';
const ROSTER_COUNT = Object.keys(npcRosters).length;

function validRoster(): NpcRoster {
  return {
    Name: '対戦アイドル',
    ManagerLevel: 31,
    Cards: [
      { CardId: 'card-a', Position: 1, Level: 31, Rarity: 5, LightFanAmount: 100, MiddleFanAmount: 10, HeavyFanAmount: 1, EvolutionLevel: 0 },
      { CardId: 'card-b', Position: 2, Level: 31, Rarity: 5, LightFanAmount: 100, MiddleFanAmount: 10, HeavyFanAmount: 1, EvolutionLevel: 0 },
      { CardId: 'card-c', Position: 3, Level: 31, Rarity: 5, LightFanAmount: 100, MiddleFanAmount: 10, HeavyFanAmount: 1, EvolutionLevel: 0 },
      { CardId: 'card-d', Position: 4, Level: 31, Rarity: 5, LightFanAmount: 100, MiddleFanAmount: 10, HeavyFanAmount: 1, EvolutionLevel: 0 },
      { CardId: 'card-e', Position: 5, Level: 31, Rarity: 5, LightFanAmount: 100, MiddleFanAmount: 10, HeavyFanAmount: 1, EvolutionLevel: 0 },
    ],
  };
}

beforeEach(() => {
  resetRosterCacheForTests();
});

test('seeding inserts every checked-in roster and is idempotent', async () => {
  const store = memoryRosterStore();
  await initRosterCache({ store });
  assert.equal(rosterCacheLoaded(), true);
  assert.equal((await store.listRosters()).length, ROSTER_COUNT);
  assert.equal(ROSTER_COUNT, 47);

  await initRosterCache({ store });
  assert.equal((await store.listRosters()).length, ROSTER_COUNT);
  assert.equal(listRosterIds().length, ROSTER_COUNT);
});

test('a DB row overrides the checked-in roster', async () => {
  const overridden = validRoster();
  overridden.Name = 'overridden';
  const store = memoryRosterStore({ [ROSTER_ID]: overridden });
  await initRosterCache({ store });

  assert.equal(rosterById(ROSTER_ID)?.Name, 'overridden');
  assert.notDeepEqual(rosterById(ROSTER_ID), npcRosters[ROSTER_ID]);
});

test('rosterById falls back to the checked-in constant when the cache is not loaded', () => {
  assert.equal(rosterCacheLoaded(), false);
  assert.deepEqual(rosterById(ROSTER_ID), npcRosters[ROSTER_ID]);
  assert.deepEqual(listRosterIds(), Object.keys(npcRosters).sort());
});

test('saveNpcRoster rejects an invalid roster and leaves the cache untouched', async () => {
  const store = memoryRosterStore();
  await initRosterCache({ store });

  const invalid = validRoster();
  invalid.Cards[0]!.Level = 0;
  invalid.Cards[1]!.Position = 1;
  await assert.rejects(() => saveNpcRoster(ROSTER_ID, invalid, 'tester'), /is invalid: .*Level/);
  assert.deepEqual(rosterById(ROSTER_ID), npcRosters[ROSTER_ID]);
  const row = await store.getRoster(ROSTER_ID);
  assert.equal(row?.roster.Name, npcRosters[ROSTER_ID]!.Name);
});

test('saveNpcRoster persists a valid roster and reloads the cache', async () => {
  const store = memoryRosterStore();
  await initRosterCache({ store });

  const updated = validRoster();
  updated.Name = 'updated roster';
  await saveNpcRoster(ROSTER_ID, updated, 'tester');

  assert.equal(rosterById(ROSTER_ID)?.Name, 'updated roster');
  const row = await store.getRoster(ROSTER_ID);
  assert.equal(row?.updatedBy, 'tester');
  assert.equal(row?.roster.Name, 'updated roster');
});

test('saveNpcRoster creates a roster that is not in the constant', async () => {
  const store = memoryRosterStore();
  await initRosterCache({ store });

  await saveNpcRoster('custom-roster', validRoster(), null);
  assert.equal(rosterById('custom-roster')?.Name, validRoster().Name);
  assert.deepEqual(listRosterIds(), [...Object.keys(npcRosters), 'custom-roster'].sort());
});

test('duplicateNpcRoster copies a roster and refuses an existing id', async () => {
  const store = memoryRosterStore();
  await initRosterCache({ store });

  await duplicateNpcRoster(ROSTER_ID, 'copied-roster', 'tester');
  assert.deepEqual(rosterById('copied-roster'), rosterById(ROSTER_ID));

  await assert.rejects(() => duplicateNpcRoster(ROSTER_ID, ROSTER_ID, 'tester'), /already exists/);
  await assert.rejects(() => duplicateNpcRoster('missing-roster', 'another-roster', 'tester'), /not found/);
  assert.equal(rosterById('another-roster'), undefined);
});

test('createNpcRoster inserts, reloads the cache and refuses existing ids', async () => {
  const store = memoryRosterStore();
  await initRosterCache({ store });

  const created = validRoster();
  created.Name = 'brand new';
  await createNpcRoster('brand-new-roster', created, 'tester');
  assert.equal(rosterById('brand-new-roster')?.Name, 'brand new');
  const row = await store.getRoster('brand-new-roster');
  assert.equal(row?.updatedBy, 'tester');

  await assert.rejects(
    () => createNpcRoster(ROSTER_ID, created, 'tester'),
    /already exists/,
  );
  await assert.rejects(
    () => createNpcRoster('brand-new-roster', created, 'tester'),
    /already exists/,
  );
});

test('createNpcRoster rejects an invalid roster and inserts nothing', async () => {
  const store = memoryRosterStore();
  await initRosterCache({ store });

  const invalid = validRoster();
  invalid.Name = '';
  await assert.rejects(
    () => createNpcRoster('invalid-roster', invalid, 'tester'),
    NpcRosterValidationError,
  );
  assert.equal(rosterById('invalid-roster'), undefined);
  assert.equal(await store.getRoster('invalid-roster'), undefined);
});

test('concurrent createNpcRoster calls leave one roster and one unique violation', async () => {
  const store = memoryRosterStore();
  await initRosterCache({ store });

  const results = await Promise.allSettled([
    createNpcRoster('racing-roster', validRoster(), 'first'),
    createNpcRoster('racing-roster', validRoster(), 'second'),
  ]);
  const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
  const rejected = results.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(
    ((rejected[0] as PromiseRejectedResult).reason as { code?: string }).code,
    '23505',
  );
  assert.equal(rosterById('racing-roster')?.Name, validRoster().Name);
});

test('validateNpcRoster accepts every existing roster', () => {
  for (const [id, roster] of Object.entries(npcRosters)) {
    assert.deepEqual(validateNpcRoster(roster), [], `roster ${id} should be valid`);
  }
});

test('validateNpcRoster reports every problem it finds', () => {
  const roster = validRoster();
  roster.Name = '';
  roster.ManagerLevel = 0;
  roster.Cards[0]!.Rarity = 11;
  roster.Cards[0]!.CardId = '';
  roster.Cards[1]!.EvolutionLevel = -1;
  roster.Cards[2]!.LightFanAmount = -1;

  const errors = validateNpcRoster(roster);
  assert.deepEqual(errors, [
    'Name must not be empty',
    'ManagerLevel must be an integer >= 1',
    'Cards[0].Rarity must be an integer 1 to 10',
    'Cards[0].CardId must not be empty',
    'Cards[1].EvolutionLevel must be an integer >= 0',
    'Cards[2].LightFanAmount must be a finite number >= 0',
  ]);
});

test('validateNpcRoster checks card ids when a cardExists predicate is given', () => {
  const roster = validRoster();
  assert.deepEqual(validateNpcRoster(roster, { cardExists: (id) => id !== 'card-c' }), [
    'Cards[2].CardId "card-c" does not exist',
  ]);
});

test('rosterUsage reports the main quest keyed by its own id and no events', () => {
  assert.deepEqual(rosterUsage(ROSTER_ID), { quests: [ROSTER_ID], events: [] });
  assert.deepEqual(rosterUsage(ROSTER_ID, { questExists: () => false }), { quests: [], events: [] });
  assert.deepEqual(rosterUsage('missing-roster'), { quests: [], events: [] });
});

test('mutating a rosterById result does not change the next lookup', async () => {
  const store = memoryRosterStore();
  await initRosterCache({ store });

  const cached = rosterById(ROSTER_ID);
  assert.ok(cached);
  cached.Name = 'mutated';
  cached.Cards[0]!.Level = 99;
  const next = rosterById(ROSTER_ID);
  assert.ok(next);
  assert.equal(next.Name, npcRosters[ROSTER_ID]!.Name);
  assert.equal(next.Cards[0]!.Level, npcRosters[ROSTER_ID]!.Cards[0]!.Level);

  // The checked-in fallback is cloned too.
  resetRosterCacheForTests();
  const fallback = rosterById(ROSTER_ID);
  assert.ok(fallback);
  fallback.Name = 'mutated fallback';
  assert.equal(rosterById(ROSTER_ID)?.Name, npcRosters[ROSTER_ID]!.Name);
});

test('overlapping saves leave the cache with the last save', async () => {
  const base = memoryRosterStore();
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  let reads = 0;
  let upserts = 0;
  const store = {
    ...base,
    async listRosters() {
      reads += 1;
      const rows = await base.listRosters();
      // The first post-save reload snapshots early and installs late.
      if (reads === 2) await delay(20);
      return rows;
    },
    async upsertRoster(id: string, roster: NpcRoster, updatedBy: string | null) {
      upserts += 1;
      // The second save writes after the first reload has already snapshotted.
      if (upserts === 2) await delay(10);
      return base.upsertRoster(id, roster, updatedBy);
    },
  };
  await initRosterCache({ store });

  const first = validRoster();
  first.Name = 'first save';
  const second = validRoster();
  second.Name = 'last save';
  await Promise.all([
    saveNpcRoster(ROSTER_ID, first, 'first'),
    saveNpcRoster(ROSTER_ID, second, 'last'),
  ]);

  assert.equal(rosterById(ROSTER_ID)?.Name, 'last save');
});
