// Opponent list tests: real players ahead, level with, then behind the caller
// may appear up to the limit, and only characters that own cards may dress a
// fallback avatar.
//
//   node --test src/services/race/rivals.test.ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  RACE_RIVAL_CHARACTER_TYPES,
  isRivalCharacter,
  selectRaceOpponents,
} from './rivals.ts';

interface Row {
  [key: string]: unknown;
}

/**
 * phaseA2/out/structured holds the generated game master data at the repository
 * root. The public export does not ship it, so master-driven tests skip there
 * instead of failing on a missing file.
 */
const MASTER_DIR = new URL('../../../../phaseA2/out/structured/', import.meta.url);
const MISSING_MASTER =
  !existsSync(new URL('RaceQuest.json', MASTER_DIR)) &&
  'phaseA2/out/structured is generated master data, not in this checkout';

function loadMaster(type: string): Row[] {
  return JSON.parse(readFileSync(new URL(`${type}.json`, MASTER_DIR), 'utf8')) as Row[];
}

/** Register a test whose fixture rows come from the generated master JSON. */
function testWithMaster(name: string, fn: () => void): void {
  test(name, { skip: MISSING_MASTER }, fn);
}

/**
 * A ranked entry list in list order: `counts[i]` is player-(i+1)'s
 * `totalClearPanelCount`. Rank is the competition rank (ties share).
 */
function board(counts: readonly number[]): {
  playerId: string;
  rank: number;
  clearPanelCount: number;
}[] {
  return counts.map((clearPanelCount, index) => ({
    playerId: `player-${index + 1}`,
    clearPanelCount,
    rank: 1 + counts.filter((other) => other > clearPanelCount).length,
  }));
}

/** The leader-heavy board: player-N has `9 - N` cleared panels. */
function ladder(count: number): ReturnType<typeof board> {
  return board(Array.from({ length: count }, (_, index) => count - index));
}

function ranks(entries: readonly { rank: number }[]): number[] {
  return entries.map((entry) => entry.rank);
}

function ids(entries: readonly { playerId: string }[]): string[] {
  return entries.map((entry) => entry.playerId);
}

test('isRivalCharacter keeps main, Memories and collaboration idols only', () => {
  assert.deepEqual([...RACE_RIVAL_CHARACTER_TYPES].sort(), [1, 3, 4]);
  assert.equal(isRivalCharacter({ Id: 'char-ai', Name: 'Ai', Type: 1 }), true);
  assert.equal(isRivalCharacter({ Id: 'char-mna', Name: 'Mana', Type: 3 }), true);
  assert.equal(isRivalCharacter({ Id: 'char-mku', Name: 'Miku', Type: 4 }), true);
  // Story NPCs own no cards and ship no `img_chr_icon_*`, so they must not be
  // used as a fallback avatar (the client stops at Octo `name_not_found`).
  assert.equal(isRivalCharacter({ Id: 'char-haruhi', Name: 'Haruhi', Type: 2 }), false);
  assert.equal(isRivalCharacter({ Id: 'char-cinnamo', Name: 'Cinnamo', Type: 2 }), false);
  // A numeric string, as the bigint column can hand it back.
  assert.equal(isRivalCharacter({ Id: 'char-ai', Name: 'Ai', Type: '1' }), true);
  assert.equal(isRivalCharacter({ Id: 'char-ai', Name: 'Ai', Type: null }), false);
  assert.equal(isRivalCharacter({ Id: 'char-ai', Name: 'Ai' }), false);
});

testWithMaster('the fallback avatar pool from master data holds only characters that own cards', () => {
  const characters = loadMaster('Character');
  const cardCharacterIds = new Set(loadMaster('Card').map((row) => String(row.CharacterId ?? '')));
  const pool = characters.filter((row) =>
    isRivalCharacter({ Id: String(row.Id ?? ''), Name: null, Type: row.Type as number }),
  );
  // 20 main idols + Mana + 7 collaboration idols (Miku, Aqours, GochiUsa).
  assert.equal(pool.length, 28);
  for (const character of pool) {
    assert.ok(
      cardCharacterIds.has(String(character.Id)),
      `${String(character.Id)} must own a card to stand in as a rival`,
    );
  }
  // The characters whose icons the client failed to resolve are NPCs.
  for (const npc of ['char-haruhi', 'char-cinnamo']) {
    const row = characters.find((character) => character.Id === npc);
    assert.equal(Number(row?.Type), 2);
    assert.equal(
      isRivalCharacter({ Id: npc, Name: null, Type: Number(row?.Type) }),
      false,
    );
  }
});

test('selectRaceOpponents takes the leader plus the players closest ahead', () => {
  // Ranks 1 and 2..4 sit ahead of rank 5; the limit fills before the caller is
  // reached, so the caller itself never appears.
  assert.deepEqual(ranks(selectRaceOpponents(ladder(8), 'player-5', 4)), [1, 2, 3, 4]);
  // Nearest ahead first (6, 5), then the leader; the output is rank ascending.
  assert.deepEqual(ranks(selectRaceOpponents(ladder(8), 'player-7', 3)), [1, 5, 6]);
});

test('selectRaceOpponents fills the empty slots with the closest players behind', () => {
  // Only rank 1 is ahead of rank 2, so the remaining rows go to the players
  // right behind the caller (3, then 4, then 5), closest first.
  assert.deepEqual(ids(selectRaceOpponents(ladder(8), 'player-2', 4)), [
    'player-1',
    'player-3',
    'player-4',
    'player-5',
  ]);
  assert.deepEqual(ranks(selectRaceOpponents(ladder(8), 'player-2', 4)), [1, 3, 4, 5]);
  // An outright leader sees the closest players behind, up to the limit.
  assert.deepEqual(ids(selectRaceOpponents(ladder(8), 'player-1', 4)), [
    'player-2',
    'player-3',
    'player-4',
    'player-5',
  ]);
  assert.deepEqual(ranks(selectRaceOpponents(ladder(8), 'player-1', 4)), [2, 3, 4, 5]);
  // The limit caps the backfill too, and equal counts keep list order.
  assert.deepEqual(ids(selectRaceOpponents(ladder(8), 'player-1', 2)), ['player-2', 'player-3']);
  assert.deepEqual(ids(selectRaceOpponents(board([10, 5, 5, 5]), 'player-1', 2)), [
    'player-2',
    'player-3',
  ]);
  // A player with no ranked entry counts as behind everyone and takes the rows
  // in list order after the rank-1 players.
  assert.deepEqual(ranks(selectRaceOpponents(board([3, 2, 1]), 'player-unranked', 4)), [1, 2, 3]);
  assert.deepEqual(ranks(selectRaceOpponents(ladder(8), 'player-unranked', 4)), [1, 2, 3, 4]);
});

test('selectRaceOpponents sees its own row only when alone in the race', () => {
  const solo = board([5]);
  assert.deepEqual(ids(selectRaceOpponents(solo, 'player-1', 4)), ['player-1']);
  assert.deepEqual(ranks(selectRaceOpponents(solo, 'player-1', 4)), [1]);
  // Once another player is listed, the caller's own row is never repeated.
  const pair = board([9, 4]);
  const first = selectRaceOpponents(pair, 'player-1', 4);
  assert.deepEqual(ids(first), ['player-2']);
  const last = selectRaceOpponents(pair, 'player-2', 4);
  assert.deepEqual(ids(last), ['player-1']);
});

test('selectRaceOpponents lists one ahead plus the closest players behind', () => {
  // 50, 40, 30, 20, 10: the caller on 40 has one player ahead and three behind.
  const entries = board([50, 40, 30, 20, 10]);
  assert.deepEqual(ids(selectRaceOpponents(entries, 'player-2', 4)), [
    'player-1',
    'player-3',
    'player-4',
    'player-5',
  ]);
  assert.deepEqual(ranks(selectRaceOpponents(entries, 'player-2', 4)), [1, 3, 4, 5]);
  // A shorter limit keeps the ahead player and only the closest followers.
  assert.deepEqual(ids(selectRaceOpponents(entries, 'player-2', 3)), [
    'player-1',
    'player-3',
    'player-4',
  ]);
});

test('selectRaceOpponents keeps the ahead and tied players ahead of the backfill', () => {
  // 50, 50, 40, 30, 20, 10: with two tied leaders ahead, the limit fills with
  // them before any player behind the caller is considered.
  const entries = board([50, 50, 40, 30, 20, 10]);
  assert.deepEqual(ids(selectRaceOpponents(entries, 'player-3', 2)), ['player-1', 'player-2']);
  // With room left, the closest player behind (30) takes the final row.
  assert.deepEqual(ids(selectRaceOpponents(entries, 'player-3', 4)), [
    'player-1',
    'player-2',
    'player-4',
    'player-5',
  ]);
});


test('selectRaceOpponents pairs up players tied at the top', () => {
  // 49, 49, 40: both leaders are rank 1, the third player is rank 3.
  const entries = board([49, 49, 40]);
  assert.deepEqual(ranks(entries), [1, 1, 3]);
  // Each tied leader sees the other one first; the player on 40 then backfills
  // the free rows. The caller's own row is not repeated.
  const first = selectRaceOpponents(entries, 'player-1', 4);
  assert.deepEqual(ids(first), ['player-2', 'player-3']);
  assert.deepEqual(ranks(first), [1, 3]);
  const second = selectRaceOpponents(entries, 'player-2', 4);
  assert.deepEqual(ids(second), ['player-1', 'player-3']);
  assert.deepEqual(ranks(second), [1, 3]);
  // The player behind sees both tied leaders, in list order, both rank 1, and
  // no one else is left to backfill.
  assert.deepEqual(ids(selectRaceOpponents(entries, 'player-3', 4)), ['player-1', 'player-2']);
  assert.deepEqual(ranks(selectRaceOpponents(entries, 'player-3', 4)), [1, 1]);
});

test('selectRaceOpponents fills the tie ahead before the nearest followers', () => {
  // 30, 30, 30, 20: the caller on 20 gets the rank-1 ties first, then nothing
  // else is ahead, so the limit stays unfilled.
  const entries = board([30, 30, 30, 20]);
  assert.deepEqual(ids(selectRaceOpponents(entries, 'player-4', 4)), [
    'player-1',
    'player-2',
    'player-3',
  ]);
  // A limit below the tie size takes the earlier rows of the tie only.
  assert.deepEqual(ids(selectRaceOpponents(entries, 'player-4', 2)), ['player-1', 'player-2']);
  // A tie in the middle of the list keeps list order among equal counts.
  const mixed = board([50, 40, 40, 30]);
  // Caller on 30: the rank-1 player first, then the two tied players on 40
  // (equal difference, list order).
  assert.deepEqual(ids(selectRaceOpponents(mixed, 'player-4', 4)), [
    'player-1',
    'player-2',
    'player-3',
  ]);
});

test('selectRaceOpponents returns nothing for a zero limit', () => {
  assert.deepEqual(selectRaceOpponents(ladder(8), 'player-5', 0), []);
  assert.deepEqual(selectRaceOpponents([], 'player-1', 4), []);
  // Even the tied leader gets nothing when the limit is 0.
  assert.deepEqual(selectRaceOpponents(board([49, 49]), 'player-1', 0), []);
});
