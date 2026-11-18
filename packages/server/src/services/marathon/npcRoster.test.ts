// Marathon versus-stage NPC roster mapping tests. Pure unit tests: the roster
// table ships with the server, so no database or master data is required.
//
//   node --test src/services/marathon/npcRoster.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { npcRosters } from '../../live/data/npcRosters.ts';
import { marathonOpponentInfo, npcRosterQuestId, opponentInfoForRoster, scaleOpponentToLevel } from '../opponent.ts';
import { parseNpcRosters } from './catalog.ts';

const QUEST_ID = 'test-marathon-quest-1';
const ROSTER_KEY = Object.keys(npcRosters)[0];

test('catalog validator accepts a configured roster key', () => {
  assert.equal(typeof ROSTER_KEY, 'string');
  assert.deepEqual(parseNpcRosters('test-marathon', { [QUEST_ID]: ROSTER_KEY }), {
    [QUEST_ID]: ROSTER_KEY,
  });
});

test('catalog validator rejects an unknown roster key', () => {
  assert.throws(
    () => parseNpcRosters('test-marathon', { [QUEST_ID]: 'test-marathon-roster-missing' }),
    /names unknown roster/,
  );
});

test('catalog validator rejects a non-string roster value', () => {
  assert.throws(
    () => parseNpcRosters('test-marathon', { [QUEST_ID]: 7 }),
    /must be a roster key/,
  );
});

test('catalog validator absent table keeps current behaviour', () => {
  assert.equal(parseNpcRosters('test-marathon', undefined), undefined);
});

test('npcRosterQuestId prefers the explicit roster id over the quest id', () => {
  assert.equal(npcRosterQuestId(QUEST_ID), QUEST_ID);
  assert.equal(npcRosterQuestId(QUEST_ID, ROSTER_KEY), ROSTER_KEY);
});

test('marathonOpponentInfo fills OpponentInfo for a mapped versus difficulty', () => {
  const info = marathonOpponentInfo(QUEST_ID, { ClearScore: 0 }, { [QUEST_ID]: ROSTER_KEY });
  assert.equal(typeof info.Name, 'string');
  assert.ok((info.Name as string).length > 0);
  assert.ok(Number(info.ManagerLevel) > 0);
  assert.equal((info.CardInfos as unknown[]).length, 5);
});

test('marathonOpponentInfo leaves OpponentInfo empty when the quest has no mapping', () => {
  const info = marathonOpponentInfo(QUEST_ID, { ClearScore: 0 }, undefined);
  assert.equal(info.Name, undefined);
  assert.equal(info.CardInfos, undefined);
  assert.equal(info.__msg, 'Solis.Common.Proto.Api.QuestOpponentInfo');
});

test('marathonOpponentInfo leaves OpponentInfo empty for a scored difficulty', () => {
  const info = marathonOpponentInfo(QUEST_ID, { ClearScore: 12345 }, { [QUEST_ID]: ROSTER_KEY });
  assert.equal(info.Name, undefined);
  assert.equal(info.CardInfos, undefined);
});

test('opponentInfoForRoster returns undefined for an unknown roster', () => {
  assert.equal(opponentInfoForRoster('test-marathon-roster-missing'), undefined);
});

test('scaleOpponentToLevel sets the manager and every card level without mutating the input', () => {
  const sample = {
    __msg: 'Solis.Common.Proto.Api.QuestOpponentInfo',
    Name: 'Test Opponent',
    ManagerLevel: 7,
    CardInfos: [
      {
        CardId: 'card-a',
        Level: 5,
        Rarity: 3,
        Position: 1,
        EvolutionLevel: 2,
        LightFanAmount: 11,
        MiddleFanAmount: 12,
        HeavyFanAmount: 13,
      },
      {
        CardId: 'card-b',
        Level: 9,
        Rarity: 5,
        Position: 2,
        EvolutionLevel: 0,
        LightFanAmount: 21,
        MiddleFanAmount: 22,
        HeavyFanAmount: 23,
      },
    ],
  };
  const scaled = scaleOpponentToLevel(sample, 123);
  assert.equal(scaled.ManagerLevel, 123);
  const cards = scaled.CardInfos as Array<Record<string, unknown>>;
  assert.equal(cards.length, 2);
  for (const card of cards) assert.equal(card.Level, 123);
  assert.equal(scaled.Name, sample.Name);
  assert.deepEqual(
    cards.map(({ CardId, Rarity, Position, EvolutionLevel, LightFanAmount, MiddleFanAmount, HeavyFanAmount }) => ({
      CardId,
      Rarity,
      Position,
      EvolutionLevel,
      LightFanAmount,
      MiddleFanAmount,
      HeavyFanAmount,
    })),
    sample.CardInfos.map(({ CardId, Rarity, Position, EvolutionLevel, LightFanAmount, MiddleFanAmount, HeavyFanAmount }) => ({
      CardId,
      Rarity,
      Position,
      EvolutionLevel,
      LightFanAmount,
      MiddleFanAmount,
      HeavyFanAmount,
    })),
  );
  // The original object must be untouched.
  assert.equal(sample.ManagerLevel, 7);
  assert.deepEqual(sample.CardInfos.map((card) => card.Level), [5, 9]);
  assert.notEqual(scaled, sample);
  assert.notEqual(scaled.CardInfos, sample.CardInfos);
});

test('scaleOpponentToLevel leaves the copy unscaled for non-positive or non-finite levels', () => {
  const sample = {
    __msg: 'Solis.Common.Proto.Api.QuestOpponentInfo',
    Name: 'Test Opponent',
    ManagerLevel: 7,
    CardInfos: [{ CardId: 'card-a', Level: 5, Position: 1 }],
  };
  for (const level of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const copy = scaleOpponentToLevel(sample, level);
    assert.equal(copy.ManagerLevel, 7);
    assert.equal((copy.CardInfos as Array<Record<string, unknown>>)[0].Level, 5);
  }
});

test('marathonOpponentInfo scales a mapped roster to the difficulty level', () => {
  const info = marathonOpponentInfo(
    QUEST_ID,
    { ClearScore: 0, DifficultyLevel: 123 },
    { [QUEST_ID]: ROSTER_KEY },
  );
  assert.equal(info.ManagerLevel, 123);
  for (const card of info.CardInfos as Array<Record<string, unknown>>) {
    assert.equal(card.Level, 123);
  }
});

test('marathonOpponentInfo keeps authored levels for a level 0 or missing difficulty level', () => {
  const authored = opponentInfoForRoster(ROSTER_KEY);
  assert.notEqual(authored, undefined);
  for (const difficulty of [{ ClearScore: 0, DifficultyLevel: 0 }, { ClearScore: 0 }]) {
    const info = marathonOpponentInfo(QUEST_ID, difficulty, { [QUEST_ID]: ROSTER_KEY });
    assert.equal(info.ManagerLevel, authored!.ManagerLevel);
    const levels = (info.CardInfos as Array<Record<string, unknown>>).map((card) => card.Level);
    const authoredLevels = (authored!.CardInfos as Array<Record<string, unknown>>).map((card) => card.Level);
    assert.deepEqual(levels, authoredLevels);
  }
});
