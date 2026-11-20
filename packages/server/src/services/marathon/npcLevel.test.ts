// Per-stage NPC level rules: authored `npcRosters` values may carry a
// `fixedLevel` or `levelOffset`. Pure unit tests; no database or master data.
//
//   node --test src/services/marathon/npcLevel.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { npcRosters } from '../../live/data/npcRosters.ts';
import {
  marathonPlugin,
  npcLevelFor,
  parseNpcLevelRules,
  parseNpcRosters,
  type MarathonConfig,
} from './plugin.ts';

const QUEST_ID = 'test-marathon-quest-1';
const OTHER_QUEST_ID = 'test-marathon-quest-2';
const ROSTER_KEY = Object.keys(npcRosters)[0] as string;
const OTHER_ROSTER_KEY = Object.keys(npcRosters)[1] as string;

function draft(npcRostersValue: unknown): Record<string, unknown> {
  return {
    id: 'marathon-levels',
    name: 'Levels',
    type: 1,
    assetId: '',
    bannerAssetId: '',
    boxGachaGroupId: '',
    initialStamina: 1,
    staminaRecoveryMinutes: 1,
    staminaRecoveryItemId: '',
    questUnlockItemId: '',
    eventMissionId: '',
    order: 1,
    npcRosters: npcRostersValue,
  };
}

function compile(npcRostersValue: unknown): MarathonConfig {
  return marathonPlugin.compile(marathonPlugin.parseDraft(draft(npcRostersValue)));
}

test('a plain roster key keeps the roster map and authors no level rule', () => {
  assert.deepEqual(parseNpcRosters('test-marathon', { [QUEST_ID]: ROSTER_KEY }), {
    [QUEST_ID]: ROSTER_KEY,
  });
  assert.deepEqual(parseNpcLevelRules('test-marathon', { [QUEST_ID]: ROSTER_KEY }), {});
});

test('an object value may name only a roster, adding no level rule', () => {
  const value = { [QUEST_ID]: { rosterId: ROSTER_KEY } };
  assert.deepEqual(parseNpcRosters('test-marathon', value), { [QUEST_ID]: ROSTER_KEY });
  assert.deepEqual(parseNpcLevelRules('test-marathon', value), {});
});

test('fixedLevel and levelOffset are parsed into the rule table only', () => {
  const value = {
    [QUEST_ID]: { rosterId: ROSTER_KEY, fixedLevel: 42 },
    [OTHER_QUEST_ID]: { rosterId: OTHER_ROSTER_KEY, levelOffset: -3 },
  };
  assert.deepEqual(parseNpcRosters('test-marathon', value), {
    [QUEST_ID]: ROSTER_KEY,
    [OTHER_QUEST_ID]: OTHER_ROSTER_KEY,
  });
  assert.deepEqual(parseNpcLevelRules('test-marathon', value), {
    [QUEST_ID]: { fixedLevel: 42 },
    [OTHER_QUEST_ID]: { levelOffset: -3 },
  });
});

test('compile keeps npcRosters unchanged and adds npcLevelRules', () => {
  const config = compile({
    [QUEST_ID]: ROSTER_KEY,
    [OTHER_QUEST_ID]: { rosterId: OTHER_ROSTER_KEY, levelOffset: 4 },
  });
  assert.deepEqual(config.npcRosters, {
    [QUEST_ID]: ROSTER_KEY,
    [OTHER_QUEST_ID]: OTHER_ROSTER_KEY,
  });
  assert.deepEqual(config.npcLevelRules, {
    [OTHER_QUEST_ID]: { levelOffset: 4 },
  });
});

test('fixedLevel and levelOffset are mutually exclusive', () => {
  assert.throws(
    () =>
      parseNpcRosters('test-marathon', {
        [QUEST_ID]: { rosterId: ROSTER_KEY, fixedLevel: 5, levelOffset: 2 },
      }),
    /cannot have both fixedLevel and levelOffset/,
  );
});

test('fixedLevel must be an integer of at least 1', () => {
  for (const fixedLevel of [0, -1, 1.5, '5', null]) {
    assert.throws(
      () => parseNpcRosters('test-marathon', { [QUEST_ID]: { rosterId: ROSTER_KEY, fixedLevel } }),
      /fixedLevel must be an integer >= 1/,
    );
  }
});

test('levelOffset must be an integer and may be negative', () => {
  for (const levelOffset of [1.5, '2', null]) {
    assert.throws(
      () => parseNpcRosters('test-marathon', { [QUEST_ID]: { rosterId: ROSTER_KEY, levelOffset } }),
      /levelOffset must be an integer/,
    );
  }
});

test('an object value needs a non-empty rosterId naming a known roster', () => {
  assert.throws(
    () => parseNpcRosters('test-marathon', { [QUEST_ID]: { levelOffset: 1 } }),
    /rosterId must be a roster key/,
  );
  assert.throws(
    () => parseNpcRosters('test-marathon', { [QUEST_ID]: { rosterId: '' } }),
    /rosterId must be a roster key/,
  );
  assert.throws(
    () => parseNpcRosters('test-marathon', { [QUEST_ID]: { rosterId: 'missing-roster' } }),
    /names unknown roster/,
  );
});

test('any other value shape is rejected', () => {
  for (const value of [7, null, ['roster'], true]) {
    assert.throws(
      () => parseNpcRosters('test-marathon', { [QUEST_ID]: value }),
      /must be a roster key or an object with a rosterId/,
    );
  }
});

test('npcLevelFor returns the fixed level, the shifted level, or the difficulty level', () => {
  const config: Pick<MarathonConfig, 'npcLevelRules'> = {
    npcLevelRules: {
      [QUEST_ID]: { fixedLevel: 40 },
      [OTHER_QUEST_ID]: { levelOffset: -3 },
    },
  };
  assert.equal(npcLevelFor(config, QUEST_ID, 12), 40);
  assert.equal(npcLevelFor(config, OTHER_QUEST_ID, 12), 9);
  assert.equal(npcLevelFor(config, 'unruled-quest', 12), 12);
});

test('a negative levelOffset clamps the result to 1', () => {
  const config: Pick<MarathonConfig, 'npcLevelRules'> = {
    npcLevelRules: { [QUEST_ID]: { levelOffset: -10 } },
  };
  assert.equal(npcLevelFor(config, QUEST_ID, 3), 1);
  assert.equal(npcLevelFor(config, QUEST_ID, 1), 1);
});
