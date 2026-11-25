// Race activity-lesson rate tests. Pure: the progress builder only reads the
// compiled config and the per-player state, so no database is needed.
//
//   node --test src/services/race/lesson.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultRaceDraft } from './plugin.ts';
import { emptyRaceState } from './state.ts';
import { buildRaceActivityLessonProgress, RACE_STEP_INTERVAL_MS } from './userRaceInfo.ts';

const HOUR_MS = 60 * 60 * 1000;
const CONFIG = defaultRaceDraft('race-26-0226');

function progressFor(ptTier: number, medalTier = 1): Record<string, unknown> {
  const state = emptyRaceState();
  state.lastActivityReceiveMs = 1_700_000_000_000;
  return buildRaceActivityLessonProgress(CONFIG, state, { pt: ptTier, medal: medalTier }) as Record<
    string,
    unknown
  >;
}

test('the lesson pays 34 race points per step at tier 1', () => {
  assert.equal(Number(progressFor(1).StepRewardRacePoint), 34);
});

test('the lesson pays 277 race points per step at tier 55', () => {
  // floor(34 + 4.5 * 54) = floor(277)
  assert.equal(Number(progressFor(55).StepRewardRacePoint), 277);
});

test('the medal rate has a base and a per-tier bonus', () => {
  // floor(17 + 3.3 * 0) = 17; floor(17 + 3.3 * 54) = floor(195.2) = 195.
  assert.equal(Number(progressFor(1, 1).StepRewardRaceMedal), 17);
  assert.equal(Number(progressFor(55, 55).StepRewardRaceMedal), 195);
});

test('the 36 h cap bounds the payable steps', () => {
  const progress = progressFor(55);
  const lastReceive = Number(progress.LastReceiveTime);
  const maxReward = Number(progress.MaxRewardTime);
  assert.equal(maxReward - lastReceive, 36 * HOUR_MS);

  const cappedSteps = Math.floor((maxReward - lastReceive) / RACE_STEP_INTERVAL_MS);
  assert.equal(cappedSteps, 12_960);

  // Idling well past the cap pays no more than the 36 h window.
  const idleUntil = lastReceive + 48 * HOUR_MS;
  const paidSteps = Math.floor((Math.min(idleUntil, maxReward) - lastReceive) / RACE_STEP_INTERVAL_MS);
  assert.equal(paidSteps, cappedSteps);
});
