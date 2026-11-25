// Activity-lesson rate preview math for the race Settings form.
//
// This mirrors the server formula in
// fastify-api/src/services/race/userRaceInfo.ts (`buildRaceActivityLessonProgress`):
//
//   tier                   = max(1, clearedTier)
//   race points per step   = floor(base + perTier * (tier - 1))
//   race medals per step   = floor(base + perTier * (tier - 1))
//   max steps              = maxHours * (3_600_000 / RACE_STEP_INTERVAL_MS)
//
// It is intentionally plain arithmetic (no React, no server imports) so that
// fastify-api/src/services/race/plugin.test.ts can import it and assert that
// the mirror and the server agree tier by tier.

/** Server step tick from fastify-api/src/services/race/userRaceInfo.ts. */
export const RACE_LESSON_STEP_MS = 10_000;
export const RACE_LESSON_STEPS_PER_HOUR = (60 * 60 * 1000) / RACE_LESSON_STEP_MS; // 360
/** Highest claimable board tier the admin form offers. */
export const RACE_LESSON_MAX_TIER = 55;

export interface RaceLessonConfig {
  racePointPerStepBase: number;
  racePointPerStepPerTier: number;
  raceMedalPerStepBase: number;
  raceMedalPerStepPerTier: number;
  maxHours: number;
}

export interface RaceLessonRates {
  tier: number;
  racePointPerStep: number;
  raceMedalPerStep: number;
  racePointPerHour: number;
  raceMedalPerHour: number;
  maxHours: number;
  /** Steps payable before the maxHours claim cap. */
  maxSteps: number;
  racePointAtMax: number;
  raceMedalAtMax: number;
}

/** Clamp a tier typed into the form to the 1..55 range the server grades use. */
export function normalizeLessonTier(tier: number): number {
  if (!Number.isFinite(tier)) return 1;
  return Math.min(RACE_LESSON_MAX_TIER, Math.max(1, Math.floor(tier)));
}

export function raceLessonRates(config: RaceLessonConfig, tier: number): RaceLessonRates {
  const normalized = normalizeLessonTier(tier);
  const racePointPerStep = Math.floor(
    config.racePointPerStepBase + config.racePointPerStepPerTier * (normalized - 1),
  );
  const raceMedalPerStep = Math.floor(
    config.raceMedalPerStepBase + config.raceMedalPerStepPerTier * (normalized - 1),
  );
  const maxSteps = Math.floor(Math.max(0, config.maxHours) * RACE_LESSON_STEPS_PER_HOUR);
  return {
    tier: normalized,
    racePointPerStep,
    raceMedalPerStep,
    racePointPerHour: racePointPerStep * RACE_LESSON_STEPS_PER_HOUR,
    raceMedalPerHour: raceMedalPerStep * RACE_LESSON_STEPS_PER_HOUR,
    maxHours: config.maxHours,
    maxSteps,
    racePointAtMax: racePointPerStep * maxSteps,
    raceMedalAtMax: raceMedalPerStep * maxSteps,
  };
}
