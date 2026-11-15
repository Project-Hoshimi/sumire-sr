// Marathon unlock-condition parsing. Pure unit tests; no database.
//
//   node --test src/services/marathon/unlock.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConditionEvaluator } from '../conditions.ts';
import type { MarathonState } from './state.ts';
import {
  marathonDifficultyConditionMet,
  marathonQuestClearConditionDifficulty,
  marathonQuestClearConditionTarget,
} from './unlock.ts';

test('cd-<questId>-<digits> targets the quest id', () => {
  assert.equal(marathonQuestClearConditionTarget('cd-quest-1-1'), 'quest-1');
  assert.equal(marathonQuestClearConditionTarget('cd-quest-1-999'), 'quest-1');
});

test('the target keeps internal hyphens', () => {
  assert.equal(marathonQuestClearConditionTarget('cd-quest-a-b-12'), 'quest-a-b');
});

test('non-cd ids are not clear conditions', () => {
  assert.equal(marathonQuestClearConditionTarget(''), null);
  assert.equal(marathonQuestClearConditionTarget('clearQuest-1'), null);
  assert.equal(marathonQuestClearConditionTarget('quest-1-1'), null);
});

test('a suffix without 1-3 digits does not match', () => {
  assert.equal(marathonQuestClearConditionTarget('cd-quest-1-1234'), null);
  assert.equal(marathonQuestClearConditionTarget('cd-quest-1-'), null);
});

test('a two-segment id still parses as quest plus suffix', () => {
  assert.equal(marathonQuestClearConditionTarget('cd-quest-1'), 'quest');
});

test('the difficulty helper captures the number and keeps dashes in the quest id', () => {
  assert.deepEqual(marathonQuestClearConditionDifficulty('cd-quest-a-b-12'), {
    questId: 'quest-a-b',
    difficulty: 12,
  });
  assert.deepEqual(marathonQuestClearConditionDifficulty('cd-quest-1'), {
    questId: 'quest',
    difficulty: 1,
  });
});

test('the difficulty helper parses a zero-padded number as base ten', () => {
  assert.deepEqual(marathonQuestClearConditionDifficulty('cd-foo-quest-5-08'), {
    questId: 'foo-quest-5',
    difficulty: 8,
  });
});

test('the difficulty helper rejects ids that are not cd conditions', () => {
  assert.equal(marathonQuestClearConditionDifficulty(''), null);
  assert.equal(marathonQuestClearConditionDifficulty('clearQuest-1'), null);
  assert.equal(marathonQuestClearConditionDifficulty('quest-1-1'), null);
  assert.equal(marathonQuestClearConditionDifficulty('cd-quest-1-1234'), null);
  assert.equal(marathonQuestClearConditionDifficulty('cd-quest-1-'), null);
});

function stateWithCleared(questId: string, diffKey: string): MarathonState {
  return {
    stamina: 0,
    staminaUpdatedTime: 0,
    quests: {
      [questId]: {
        last: Number(diffKey),
        diffs: { [diffKey]: { cleared: true, highestScore: 0, rankType: 0, plus: 0 } },
      },
    },
  };
}

function evaluatorSatisfied(result: boolean): ConditionEvaluator {
  return { satisfied: async () => result } as unknown as ConditionEvaluator;
}

test('an empty difficulty condition is open', async () => {
  const state: MarathonState = { stamina: 0, staminaUpdatedTime: 0, quests: {} };
  assert.equal(await marathonDifficultyConditionMet('player', 'quest', '', state), true);
});

test('a satisfied evaluator opens the gate regardless of state', async () => {
  const state: MarathonState = { stamina: 0, staminaUpdatedTime: 0, quests: {} };
  assert.equal(
    await marathonDifficultyConditionMet('player', 'quest', 'cd-quest-2', state, undefined, evaluatorSatisfied(true)),
    true,
  );
});

test('an unsatisfied evaluator falls back to the previous difficulty being cleared', async () => {
  const state = stateWithCleared('quest-a-b', '2');
  assert.equal(
    await marathonDifficultyConditionMet('player', 'quest-a-b', 'cd-quest-a-b-3', state, undefined, evaluatorSatisfied(false)),
    true,
  );
});

test('the previous difficulty must be switched on, not merely present', async () => {
  const state: MarathonState = {
    stamina: 0,
    staminaUpdatedTime: 0,
    quests: {
      'quest-a-b': {
        last: 2,
        diffs: { '2': { cleared: false, highestScore: 0, rankType: 0, plus: 0 } },
      },
    },
  };
  assert.equal(
    await marathonDifficultyConditionMet('player', 'quest-a-b', 'cd-quest-a-b-3', state, undefined, evaluatorSatisfied(false)),
    false,
  );
});

test('difficulty 1 has no previous difficulty to fall back on', async () => {
  const state = stateWithCleared('quest', '0');
  assert.equal(
    await marathonDifficultyConditionMet('player', 'quest', 'cd-quest-1', state, undefined, evaluatorSatisfied(false)),
    false,
  );
});

test('the condition must point at the same quest', async () => {
  const state = stateWithCleared('other-quest', '2');
  assert.equal(
    await marathonDifficultyConditionMet('player', 'quest', 'cd-other-quest-3', state, undefined, evaluatorSatisfied(false)),
    false,
  );
});

test('non-cd conditions do not fall back to cleared state', async () => {
  const state = stateWithCleared('quest', '2');
  assert.equal(
    await marathonDifficultyConditionMet('player', 'quest', 'clearQuest-1', state, undefined, evaluatorSatisfied(false)),
    false,
  );
});
