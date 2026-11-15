// Marathon live-bonus helpers. Pure unit tests; no database.
//
//   node --test src/services/marathon/liveBonus.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { addLiveBonus, liveBonusInfos, pickLiveBonusId } from './liveBonus.ts';
import type { MarathonState } from './state.ts';

const INFO_MSG = 'Solis.Common.Proto.Api.MarathonLiveBonusInfo';

function state(): MarathonState {
  return { stamina: 0, staminaUpdatedTime: 0, quests: {} };
}

test('pickLiveBonusId returns null for an empty list', () => {
  assert.equal(pickLiveBonusId([], () => 0), null);
  assert.equal(pickLiveBonusId([], () => 0.5), null);
});

test('pickLiveBonusId picks the first id for rng 0', () => {
  assert.equal(pickLiveBonusId(['a', 'b', 'c'], () => 0), 'a');
});

test('pickLiveBonusId picks the last id for rng just below 1', () => {
  assert.equal(pickLiveBonusId(['a', 'b', 'c'], () => 0.999999), 'c');
});

test('pickLiveBonusId clamps rng 1 to the last index', () => {
  assert.equal(pickLiveBonusId(['a', 'b', 'c'], () => 1), 'c');
  assert.equal(pickLiveBonusId(['only'], () => 1), 'only');
});

test('addLiveBonus creates the map and accumulates per id', () => {
  const marathon = state();
  addLiveBonus(marathon, 'b');
  addLiveBonus(marathon, 'a');
  addLiveBonus(marathon, 'b', 2);
  assert.deepEqual(marathon.liveBonuses, { a: 1, b: 3 });
});

test('liveBonusInfos sorts by id and omits zero amounts', () => {
  const marathon = state();
  marathon.liveBonuses = { z: 0, b: 2, a: 1 };
  assert.deepEqual(liveBonusInfos(marathon), [
    { __msg: INFO_MSG, LiveBonusId: 'a', Amount: 1 },
    { __msg: INFO_MSG, LiveBonusId: 'b', Amount: 2 },
  ]);
});

test('liveBonusInfos is empty when no live bonus is owned', () => {
  assert.deepEqual(liveBonusInfos(state()), []);
});
