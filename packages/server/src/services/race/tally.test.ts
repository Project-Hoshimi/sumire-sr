// Two-day activity-lesson tally: JST boundary helpers, the tallied clear tier
// and the piecewise step segmentation of a claim window.
//
//   node --test src/services/race/tally.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultRaceDraft } from './plugin.ts';
import { emptyRaceState, recordAreaQuestTierReached } from './state.ts';
import {
  firstTallyAt,
  jstMidnightOnOrBefore,
  lastTallyAt,
  lessonTallyBoundaries,
  nextTallyAt,
  talliedClearTier,
  tallyStepSegments,
} from './tally.ts';
import { buildRaceEffectiveClearedTiers } from './userRaceInfo.ts';
import type { RaceConfig } from './types.ts';

const PT_QUEST = 'race-qt-test-pt';
const MEDAL_QUEST = 'race-qt-test-medal';
const CONFIG: RaceConfig = {
  ...defaultRaceDraft('race-26-0226'),
  areaQuestIds: { pt: PT_QUEST, medal: MEDAL_QUEST },
};
/** Difficulty numbers the quest defines (race tiers start at 2). */
const TIERS: number[] = [2, 3, 4, 5, 6];
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** JST midnight: 15:00 UTC. */
const JST_MIDNIGHT_UTC_HOUR = 15;

function utc(y: number, m: number, d: number, hour = 0, minute = 0): number {
  return Date.UTC(y, m - 1, d, hour, minute, 0, 0);
}

/** 2026-03-02 14:00 JST, i.e. mid-day on the JST day the race starts. */
const START_MID_DAY_JST = utc(2026, 3, 2, 5, 0);

test('tally boundaries are every 2 JST midnights after the start day', () => {
  // The start day is 2026-03-02 JST, whose midnight is 2026-03-01T15:00Z.
  assert.equal(jstMidnightOnOrBefore(START_MID_DAY_JST), utc(2026, 3, 1, JST_MIDNIGHT_UTC_HOUR));
  assert.equal(firstTallyAt(START_MID_DAY_JST), utc(2026, 3, 3, JST_MIDNIGHT_UTC_HOUR));
  const boundaries = [];
  for (const at of lessonTallyBoundaries(START_MID_DAY_JST)) {
    boundaries.push(at);
    if (boundaries.length === 3) break;
  }
  assert.deepEqual(boundaries, [
    utc(2026, 3, 3, JST_MIDNIGHT_UTC_HOUR),
    utc(2026, 3, 5, JST_MIDNIGHT_UTC_HOUR),
    utc(2026, 3, 7, JST_MIDNIGHT_UTC_HOUR),
  ]);
});

test('a start exactly at JST midnight keeps the same boundaries', () => {
  // 2026-03-02T00:00 JST is exactly 2026-03-01T15:00Z.
  const startAtMidnight = utc(2026, 3, 1, JST_MIDNIGHT_UTC_HOUR);
  assert.equal(jstMidnightOnOrBefore(startAtMidnight), startAtMidnight);
  assert.equal(jstMidnightOnOrBefore(startAtMidnight), jstMidnightOnOrBefore(START_MID_DAY_JST));
  assert.equal(firstTallyAt(startAtMidnight), firstTallyAt(START_MID_DAY_JST));
});

test('boundaries stay at 15:00 UTC year round (JST has no DST)', () => {
  for (const month of [1, 3, 6, 9, 11]) {
    const start = utc(2026, month, 10, 5, 0);
    for (const at of lessonTallyBoundaries(start)) {
      if (at - start > 10 * DAY_MS) break;
      assert.equal(new Date(at).getUTCHours(), JST_MIDNIGHT_UTC_HOUR);
      assert.equal(new Date(at).getUTCMinutes(), 0);
    }
  }
});

test('lastTallyAt is null before the first boundary, then the latest one', () => {
  const first = firstTallyAt(START_MID_DAY_JST);
  assert.equal(lastTallyAt(START_MID_DAY_JST, first - 1), null);
  assert.equal(lastTallyAt(START_MID_DAY_JST, first), first);
  assert.equal(lastTallyAt(START_MID_DAY_JST, first + 1), first);
  assert.equal(lastTallyAt(START_MID_DAY_JST, first + 2 * DAY_MS), first + 2 * DAY_MS);
  assert.equal(lastTallyAt(START_MID_DAY_JST, first + 2 * DAY_MS - 1), first);
});

test('nextTallyAt is strictly after now, including exactly on a boundary', () => {
  const first = firstTallyAt(START_MID_DAY_JST);
  assert.equal(nextTallyAt(START_MID_DAY_JST, START_MID_DAY_JST), first);
  assert.equal(nextTallyAt(START_MID_DAY_JST, first - 1), first);
  assert.equal(nextTallyAt(START_MID_DAY_JST, first), first + 2 * DAY_MS);
});

test('a clear does not raise the lesson rate until the next boundary', () => {
  const first = firstTallyAt(START_MID_DAY_JST);
  const state = emptyRaceState();
  state.areaQuestClear[PT_QUEST] = 5;
  recordAreaQuestTierReached(state, 'pt', 0, 5, START_MID_DAY_JST + HOUR_MS);

  const before = buildRaceEffectiveClearedTiers(
    CONFIG,
    state,
    { pt: TIERS, medal: TIERS },
    START_MID_DAY_JST,
    first - 1,
  );
  assert.equal(before.pt, 0, 'nothing is tallied before the first boundary');
  assert.equal(before.medal, 0);

  const atFirst = buildRaceEffectiveClearedTiers(CONFIG, state, { pt: TIERS, medal: TIERS }, START_MID_DAY_JST, first);
  assert.equal(atFirst.pt, 4, 'difficulty 5 is the 4th tier above 1');

  const state2 = emptyRaceState();
  state2.areaQuestClear[PT_QUEST] = 5;
  recordAreaQuestTierReached(state2, 'pt', 0, 5, first + HOUR_MS);
  const atFirstClearLater = buildRaceEffectiveClearedTiers(
    CONFIG,
    state2,
    { pt: TIERS, medal: TIERS },
    START_MID_DAY_JST,
    first + 2 * DAY_MS - HOUR_MS,
  );
  assert.equal(atFirstClearLater.pt, 0, 'a clear after a boundary waits for the next one');
  const afterSecond = buildRaceEffectiveClearedTiers(
    CONFIG,
    state2,
    { pt: TIERS, medal: TIERS },
    START_MID_DAY_JST,
    first + 2 * DAY_MS,
  );
  assert.equal(afterSecond.pt, 4);
});

test('legacy clears without reachedAt history keep their rate immediately', () => {
  const first = firstTallyAt(START_MID_DAY_JST);
  const state = emptyRaceState();
  state.areaQuestClear[PT_QUEST] = 5;
  state.areaQuestClear[MEDAL_QUEST] = 3;
  const tiers = buildRaceEffectiveClearedTiers(CONFIG, state, { pt: TIERS, medal: TIERS }, START_MID_DAY_JST, first - 1);
  assert.deepEqual(tiers, { pt: 4, medal: 2 });
});

test('a tier stamped at time 0 is effective before the first boundary', () => {
  const first = firstTallyAt(START_MID_DAY_JST);
  const state = emptyRaceState();
  state.areaQuestClear[PT_QUEST] = 5;
  state.areaQuestTierReachedAt.pt = { '5': 0 };
  assert.equal(
    buildRaceEffectiveClearedTiers(CONFIG, state, { pt: TIERS, medal: TIERS }, START_MID_DAY_JST, first - 1).pt,
    4,
  );
});

test('recording a clear stamps the newly reached tiers and the legacy highest', () => {
  const now = START_MID_DAY_JST;
  const state = emptyRaceState();
  state.areaQuestClear[MEDAL_QUEST] = 3;
  // Legacy state: a clear but no history. The prior highest is kept at time 0.
  recordAreaQuestTierReached(state, 'medal', 3, 5, now);
  assert.deepEqual(state.areaQuestTierReachedAt.medal, { '3': 0, '4': now, '5': now });
  // An existing entry is not overwritten.
  recordAreaQuestTierReached(state, 'medal', 5, 6, now + 1);
  assert.equal(state.areaQuestTierReachedAt.medal['5'], now);
  const reached = state.areaQuestTierReachedAt.medal as Record<string, number>;
  assert.equal(reached['6'], now + 1);
});

test('a claim window spanning a boundary is split into per-tier segments', () => {
  const first = firstTallyAt(START_MID_DAY_JST);
  const stepMs = 10_000;
  // One hour either side of the boundary.
  const segments = tallyStepSegments({
    startMs: START_MID_DAY_JST,
    windowStartMs: first - HOUR_MS,
    steps: 720,
    stepMs,
  });
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { steps: 360, atMs: first - HOUR_MS });
  assert.deepEqual(segments[1], { steps: 360, atMs: first });
  assert.equal(
    segments.reduce((total, segment) => total + segment.steps, 0),
    720,
    'segments partition every step',
  );
});

test('a step starting exactly on a boundary already uses the new tier', () => {
  const first = firstTallyAt(START_MID_DAY_JST);
  const stepMs = 10_000;
  const segments = tallyStepSegments({
    startMs: START_MID_DAY_JST,
    windowStartMs: first - 4 * stepMs,
    steps: 5,
    stepMs,
  });
  assert.deepEqual(segments, [
    { steps: 4, atMs: first - 4 * stepMs },
    { steps: 1, atMs: first },
  ]);
});

test('a window that crosses two boundaries gets three segments', () => {
  const first = firstTallyAt(START_MID_DAY_JST);
  const stepMs = HOUR_MS;
  const segments = tallyStepSegments({
    startMs: START_MID_DAY_JST,
    windowStartMs: first - 2 * HOUR_MS,
    steps: 3 * 24,
    stepMs,
  });
  assert.deepEqual(
    segments.map((segment) => segment.steps),
    [2, 48, 3 * 24 - 50],
  );
  assert.equal(segments[2].atMs, first + 2 * DAY_MS);
});

test('no steps means no segments', () => {
  assert.deepEqual(
    tallyStepSegments({
      startMs: START_MID_DAY_JST,
      windowStartMs: START_MID_DAY_JST,
      steps: 0,
      stepMs: 10_000,
    }),
    [],
  );
});
