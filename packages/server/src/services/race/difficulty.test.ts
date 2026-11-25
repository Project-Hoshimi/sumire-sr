// Per-player VENUS difficulty: grade mapping, frozen state field and the
// fallback chain. Pure tests; the mapping defaults come from the shipped
// import draft.
//
//   node --test src/services/race/difficulty.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { deriveRaceDraft, type RaceDraftLookups } from './importDraft.ts';
import { difficultyForGrade, raceDifficultyNumber, RACE_GRADE_DIFFICULTY_KEYS } from './difficulty.ts';
import { emptyRaceState, normalizeRaceState } from './state.ts';
import type { RaceState } from './state.ts';
import {
  RACE_DEFAULT_GRADE_DIFFICULTY,
  type RaceConfig,
  type RaceGradeDifficultyConfig,
} from './types.ts';

const RACE_ID = 'race-26-0226';

function raceConfig(overrides: Partial<RaceConfig> = {}): RaceConfig {
  return {
    raceId: RACE_ID,
    livePanelDifficultyNumber: 1,
    gradeDifficulty: { ...RACE_DEFAULT_GRADE_DIFFICULTY },
    ...overrides,
  } as unknown as RaceConfig;
}

function stateWith(difficultyNumber: number | null): RaceState {
  return { ...emptyRaceState(), difficultyNumber };
}

test('the import draft seeds the default grade mapping', () => {
  const draft = deriveRaceDraft(RACE_ID, {} as RaceDraftLookups);
  assert.deepEqual(draft.gradeDifficulty, {
    challenger: 1,
    bronze: 2,
    silver: 3,
    gold: 4,
    platinum: 5,
    diamond: 6,
    big4: 7,
  });
});

test('every VENUS grade maps to its default difficulty', () => {
  const config = raceConfig();
  assert.equal(difficultyForGrade(config, 'hie-001'), 7); // BIG4
  assert.equal(difficultyForGrade(config, 'hie-002'), 6); // Diamond
  assert.equal(difficultyForGrade(config, 'hie-003'), 5); // Platinum
  assert.equal(difficultyForGrade(config, 'hie-004'), 4); // Gold
  assert.equal(difficultyForGrade(config, 'hie-005'), 3); // Silver
  assert.equal(difficultyForGrade(config, 'hie-006'), 2); // Bronze
  assert.equal(difficultyForGrade(config, 'hie-007'), 1); // Challenger
  assert.deepEqual(Object.keys(RACE_GRADE_DIFFICULTY_KEYS).sort(), [
    'hie-001',
    'hie-002',
    'hie-003',
    'hie-004',
    'hie-005',
    'hie-006',
    'hie-007',
  ]);
});

test('a configured mapping overrides the defaults per grade', () => {
  const gradeDifficulty: RaceGradeDifficultyConfig = {
    ...RACE_DEFAULT_GRADE_DIFFICULTY,
    platinum: 2,
    challenger: 4,
  };
  const config = raceConfig({ gradeDifficulty });
  assert.equal(difficultyForGrade(config, 'hie-003'), 2);
  assert.equal(difficultyForGrade(config, 'hie-007'), 4);
  // Untouched leaves keep their default.
  assert.equal(difficultyForGrade(config, 'hie-001'), 7);
});

test('an unknown or missing grade falls back to the race difficulty', () => {
  const config = raceConfig({ livePanelDifficultyNumber: 3 });
  assert.equal(difficultyForGrade(config, 'hie-999'), 3);
  assert.equal(difficultyForGrade(config, 'unknown'), 3);
  assert.equal(difficultyForGrade(config, ''), 3);
  assert.equal(difficultyForGrade(config, null), 3);
  assert.equal(difficultyForGrade(config, undefined), 3);
  // A draft that predates the field uses the built-in default fallback.
  const bare = { raceId: RACE_ID } as unknown as RaceConfig;
  assert.equal(difficultyForGrade(bare, 'hie-999'), 1);
  assert.equal(difficultyForGrade(bare, 'hie-003'), 5);
});

test('raceDifficultyNumber prefers the frozen value over the race fallback', () => {
  const config = raceConfig({ livePanelDifficultyNumber: 2 });
  assert.equal(raceDifficultyNumber(stateWith(7), config), 7);
  assert.equal(raceDifficultyNumber(stateWith(1), config), 1);
  assert.equal(raceDifficultyNumber(stateWith(null), config), 2);
  assert.equal(raceDifficultyNumber(emptyRaceState(), config), 2);
});

test('normalizeRaceState keeps an integer tier 1..7 and drops anything else', () => {
  for (const value of [1, 4, 7]) {
    assert.equal(normalizeRaceState({ difficultyNumber: value } as unknown as Decoded).difficultyNumber, value);
  }
  for (const value of [0, 8, -1, 2.5, Number.NaN, '3', true, null, undefined]) {
    assert.equal(
      normalizeRaceState({ difficultyNumber: value } as unknown as Decoded).difficultyNumber,
      null,
      `difficultyNumber ${String(value)} must normalize to null`,
    );
  }
  assert.equal(emptyRaceState().difficultyNumber, null);
  assert.equal(normalizeRaceState(null).difficultyNumber, null);
});
