// Synthetic race bots: deterministic pace over the race window, monotonic in
// `now`, and a disabled/missing config yields no bots at all.
//
//   node --test src/services/race/bots.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { isRaceBotId, raceBotEntries, fnv1a32 } from './bots.ts';
import type { RaceBotConfig } from './types.ts';

const RACE_ID = 'race-26-0226';
const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 1, 26, 4, 0, 0);
const END = START + 14 * DAY_MS;

const WINDOW = { startTime: START, endTime: END };

function config(patch: Partial<RaceBotConfig> = {}): RaceBotConfig {
  return {
    enabled: true,
    count: 8,
    minPanelsPerDay: 20,
    maxPanelsPerDay: 120,
    names: [],
    ...patch,
  };
}

test('undefined or disabled config generates no bots', () => {
  assert.deepEqual(raceBotEntries(RACE_ID, undefined, WINDOW, START), []);
  assert.deepEqual(raceBotEntries(RACE_ID, config({ enabled: false }), WINDOW, START), []);
  assert.deepEqual(raceBotEntries(RACE_ID, config({ count: 0 }), WINDOW, START), []);
});

test('bot ids carry the known prefix', () => {
  const bots = raceBotEntries(RACE_ID, config(), WINDOW, START + DAY_MS);
  assert.ok(bots.length > 0);
  for (const bot of bots) {
    assert.equal(isRaceBotId(bot.id), true);
    assert.equal(isRaceBotId(bot.userId), false);
  }
  assert.equal(isRaceBotId('player-1'), false);
});

test('generation is deterministic', () => {
  const now = START + 3 * DAY_MS + 1234;
  assert.deepEqual(
    raceBotEntries(RACE_ID, config(), WINDOW, now),
    raceBotEntries(RACE_ID, config(), WINDOW, now),
  );
  // A different race id reseeds every bot.
  assert.notDeepEqual(
    raceBotEntries(RACE_ID, config(), WINDOW, now),
    raceBotEntries('race-26-0305', config(), WINDOW, now),
  );
});

test('clearPanelCount never decreases as now advances', () => {
  const bots = config();
  let previous: number[] | null = null;
  for (let hour = 0; hour <= 15 * 24; hour += 1) {
    const counts = raceBotEntries(RACE_ID, bots, WINDOW, START + hour * 3_600_000).map(
      (bot) => bot.clearPanelCount,
    );
    if (previous !== null) {
      counts.forEach((count, index) => {
        assert.ok(count >= (previous as number[])[index]!, `bot ${index} went backwards`);
      });
    }
    previous = counts;
  }
});

test('no progress before the start, frozen after the end', () => {
  const bots = config();
  assert.deepEqual(
    raceBotEntries(RACE_ID, bots, WINDOW, START - DAY_MS).map((bot) => bot.clearPanelCount),
    new Array(bots.count).fill(0),
  );
  const atEnd = raceBotEntries(RACE_ID, bots, WINDOW, END);
  assert.deepEqual(raceBotEntries(RACE_ID, bots, WINDOW, END + 10 * DAY_MS), atEnd);
  assert.ok(atEnd.every((bot) => bot.clearPanelCount > 0));
});

test('honours count and keeps names unique past the name list length', () => {
  assert.equal(raceBotEntries(RACE_ID, config({ count: 5 }), WINDOW, START + DAY_MS).length, 5);

  const many = raceBotEntries(
    RACE_ID,
    config({ count: 400, names: ['Alpha', 'Beta'] }),
    WINDOW,
    START + DAY_MS,
  );
  assert.equal(many.length, 400);
  assert.equal(new Set(many.map((bot) => bot.name)).size, 400);
  assert.deepEqual(
    many.slice(0, 4).map((bot) => bot.name),
    ['Alpha', 'Beta', 'Alpha 2', 'Beta 2'],
  );
});

test('empty names name the bots after the idol list with that idol character id', () => {
  const idols = [
    { id: 'char-ai', name: 'Ai' },
    { id: 'char-kana', name: 'Kana' },
    { id: 'char-mei', name: 'Mei' },
  ];
  const now = START + DAY_MS;
  const bots = raceBotEntries(RACE_ID, config({ count: 3 }), WINDOW, now, idols);
  const offset = fnv1a32(RACE_ID) % idols.length;
  bots.forEach((bot, index) => {
    const idol = idols[(offset + index) % idols.length]!;
    assert.equal(bot.name, idol.name);
    assert.equal(bot.characterId, idol.id);
  });
  // Deterministic for the same race and idol list.
  assert.deepEqual(bots, raceBotEntries(RACE_ID, config({ count: 3 }), WINDOW, now, idols));
});

test('idol mode keeps pace and levels identical to custom names', () => {
  const idols = [
    { id: 'char-ai', name: 'Ai' },
    { id: 'char-kana', name: 'Kana' },
  ];
  const now = START + DAY_MS;
  const idolBots = raceBotEntries(RACE_ID, config({ count: 4 }), WINDOW, now, idols);
  const customBots = raceBotEntries(
    RACE_ID,
    config({ count: 4, names: ['Alpha', 'Beta'] }),
    WINDOW,
    now,
  );
  const draws = (bots: { id: string; managerLevel: number; displayCharacterIndex: number; clearPanelCount: number }[]) =>
    bots.map((bot) => [bot.id, bot.managerLevel, bot.displayCharacterIndex, bot.clearPanelCount]);
  assert.deepEqual(draws(idolBots), draws(customBots));
});

test('idol mode suffixes repeats past the idol list length', () => {
  const idols = [
    { id: 'char-ai', name: 'Ai' },
    { id: 'char-kana', name: 'Kana' },
    { id: 'char-mei', name: 'Mei' },
  ];
  const bots = raceBotEntries(RACE_ID, config({ count: 7 }), WINDOW, START + DAY_MS, idols);
  const offset = fnv1a32(RACE_ID) % idols.length;
  assert.equal(bots.length, 7);
  bots.forEach((bot, index) => {
    const idol = idols[(offset + index) % idols.length]!;
    assert.equal(bot.characterId, idol.id);
    const expected =
      index >= idols.length
        ? `${idol.name} ${Math.floor(index / idols.length) + 1}`
        : idol.name;
    assert.equal(bot.name, expected);
  });
  assert.equal(new Set(bots.map((bot) => bot.name)).size, 7);
});

test('empty names with no idols fall back to Bot N handles', () => {
  const bots = raceBotEntries(RACE_ID, config({ count: 3 }), WINDOW, START + DAY_MS);
  assert.deepEqual(
    bots.map((bot) => bot.name),
    ['Bot 1', 'Bot 2', 'Bot 3'],
  );
  assert.ok(bots.every((bot) => bot.characterId === undefined));
});

test('custom names keep the seeded rotation and carry no character id', () => {
  const idols = [{ id: 'char-ai', name: 'Ai' }];
  const bots = raceBotEntries(
    RACE_ID,
    config({ count: 4, names: ['Alpha', 'Beta'] }),
    WINDOW,
    START + DAY_MS,
    idols,
  );
  assert.deepEqual(
    bots.map((bot) => bot.name),
    ['Alpha', 'Beta', 'Alpha 2', 'Beta 2'],
  );
  assert.ok(bots.every((bot) => bot.characterId === undefined));
});

test('clearPanelCount scales with the configured pace band', () => {
  const now = START + 7 * DAY_MS;
  const slow = raceBotEntries(
    RACE_ID,
    config({ minPanelsPerDay: 10, maxPanelsPerDay: 20 }),
    WINDOW,
    now,
  );
  const fast = raceBotEntries(
    RACE_ID,
    config({ minPanelsPerDay: 100, maxPanelsPerDay: 200 }),
    WINDOW,
    now,
  );
  const total = (bots: { clearPanelCount: number }[]): number =>
    bots.reduce((sum, bot) => sum + bot.clearPanelCount, 0);
  assert.ok(total(fast) > total(slow));
  // Every bot of the faster band clears at least the slow band's minimum pace.
  assert.ok(fast.every((bot) => bot.clearPanelCount >= 7 * 10));
});

test('manager levels stay in range and the seeded character index is stable', () => {
  const bots = raceBotEntries(RACE_ID, config({ count: 60 }), WINDOW, START + DAY_MS);
  for (const bot of bots) {
    assert.ok(Number.isInteger(bot.managerLevel));
    assert.ok(bot.managerLevel >= 20 && bot.managerLevel <= 200);
    assert.ok(Number.isInteger(bot.displayCharacterIndex));
    assert.ok(bot.displayCharacterIndex >= 0);
  }
  assert.ok(new Set(bots.map((bot) => bot.managerLevel)).size > 1);
});
