// Two-day activity-lesson tally (レース特訓 efficiency level).
//
// The client help (`help_content-tips-race-05`) says the efficiency level
// ("効率Lv") reaches the activity lesson only once every 2 days at 0:00 JST:
//
//   効率Lvは2日に一度0:00にレース特訓の獲得効率に反映されます
//
// The tally is anchored on the race: the boundaries are the JST midnights at
// day offsets 2, 4, 6, … counted from the JST calendar day that contains the
// race `StartTime`
//
//   boundary_k = JST midnight of startDay + 2k days, k >= 1
//
// so a clear only raises the lesson rate at the next boundary, and `Race:Top`
// can show the matching countdown (`NextDailyAggregationTime`). JST is UTC+9
// all year (Japan has no DST), so no timezone table is needed.
//
// The helpers here are pure; callers pass the race schedule start (the same
// `StartTime` `raceWindowFor` reports) and the times they want resolved.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** JST is UTC+9 all year. */
const JST_OFFSET_MS = 9 * HOUR_MS;
/** Boundaries are two JST days apart. */
export const TALLY_INTERVAL_MS = 2 * DAY_MS;

/** JST midnight at or before `ms`. */
export function jstMidnightOnOrBefore(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
}

/** First tally boundary: two JST days after the start day's midnight. */
export function firstTallyAt(startMs: number): number {
  return jstMidnightOnOrBefore(startMs) + TALLY_INTERVAL_MS;
}

/**
 * Tally boundaries strictly after `startMs`, every 2 JST days. The sequence is
 * infinite; iterate it with a guard (e.g. a bounded `for … of` and `break`).
 */
export function* lessonTallyBoundaries(startMs: number): Generator<number, void, void> {
  const dayStart = jstMidnightOnOrBefore(startMs);
  for (let k = 1; ; k += 1) yield dayStart + k * TALLY_INTERVAL_MS;
}

/**
 * Latest tally boundary at or before `nowMs`, or `null` when `nowMs` is still
 * before the first boundary (nothing has been tallied yet).
 */
export function lastTallyAt(startMs: number, nowMs: number): number | null {
  const dayStart = jstMidnightOnOrBefore(startMs);
  const k = Math.floor((nowMs - dayStart) / TALLY_INTERVAL_MS);
  return k >= 1 ? dayStart + k * TALLY_INTERVAL_MS : null;
}

/** First tally boundary strictly after `nowMs`. */
export function nextTallyAt(startMs: number, nowMs: number): number {
  const dayStart = jstMidnightOnOrBefore(startMs);
  const k = Math.max(1, Math.floor((nowMs - dayStart) / TALLY_INTERVAL_MS) + 1);
  return dayStart + k * TALLY_INTERVAL_MS;
}

/** Cleared-tier history of one area quest type. */
export interface RaceTierReach {
  /** Highest cleared difficulty number (`RaceState.areaQuestClear[questId]`). */
  clear: number;
  /** difficulty number → epoch ms when it was first cleared. */
  reachedAt: Readonly<Record<string, number>>;
}

/**
 * Highest difficulty tier whose clear had reached the lesson rate at `atMs`.
 *
 * Only tiers reached at or before the latest tally boundary count. Two cases
 * are effective immediately: entries stamped at time 0 (states saved before
 * the tally existed, and the previous highest of a legacy state stamped when
 * its next tier is cleared), and a state with clears but no `reachedAt`
 * history at all (never re-saved since the tally shipped) — the latter keeps
 * its rate instead of dropping back to tier 1.
 */
export function talliedClearTier(
  reach: RaceTierReach,
  startMs: number,
  atMs: number,
): number {
  const threshold = lastTallyAt(startMs, atMs) ?? 0;
  const hasHistory = Object.keys(reach.reachedAt).length > 0;
  let best = reach.clear > 0 && !hasHistory ? reach.clear : 0;
  for (const [tier, reachedAt] of Object.entries(reach.reachedAt)) {
    const number = Number(tier);
    if (!Number.isFinite(number) || number <= 0) continue;
    if (!Number.isFinite(reachedAt)) continue;
    if (reachedAt <= threshold) best = Math.max(best, number);
  }
  return best;
}

/** One run of equal-rate steps inside a lesson claim window. */
export interface TallyStepSegment {
  /** Steps paid at this segment's rate. */
  steps: number;
  /**
   * Start time of the segment's first step. Resolve the effective tier at this
   * instant: a step that starts exactly on a boundary already uses the new
   * tier.
   */
  atMs: number;
}

/**
 * Split `steps` steps of `stepMs` each, starting at `windowStartMs`, into
 * segments of constant tallied tier. Steps are counted from the window start
 * (as the cap always has), so the segment lengths are a partition of `steps`.
 */
export function tallyStepSegments(args: {
  startMs: number;
  windowStartMs: number;
  steps: number;
  stepMs: number;
}): TallyStepSegment[] {
  const { startMs, windowStartMs, steps, stepMs } = args;
  if (steps <= 0) return [];
  const segments: TallyStepSegment[] = [];
  let firstIndex = 0;
  let atMs = windowStartMs;
  let boundary = nextTallyAt(startMs, windowStartMs);
  for (let index = 0; index < steps; index += 1) {
    const stepStart = windowStartMs + index * stepMs;
    if (stepStart >= boundary) {
      segments.push({ steps: index - firstIndex, atMs });
      while (boundary <= stepStart) boundary = nextTallyAt(startMs, boundary);
      firstIndex = index;
      atMs = stepStart;
    }
  }
  segments.push({ steps: steps - firstIndex, atMs });
  return segments.filter((segment) => segment.steps > 0);
}
