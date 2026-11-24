// `UserRaceInfo` builder: the per-player slice every race RPC returns.
import { db } from '../../db/client.ts';
import type { Executor } from '../../db/tx.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { racePlayerRank } from './ranking.ts';
import { getRacePanel, listRaceQuestDifficulties } from './master.ts';
import type { RaceState } from './state.ts';
import { talliedClearTier } from './tally.ts';
import { clearedTierCountOf, tierNumbers } from './tiers.ts';
import type { RaceConfig, RaceRankGrade } from './types.ts';

/** `RacePanel.Type`: 3 is the VENUS live panel. */
const PANEL_VENUS = 3;

const USER_RACE_INFO_MSG = 'Solis.Common.Proto.Api.UserRaceInfo';
const ACTIVITY_LESSON_PROGRESS_MSG = 'Solis.Common.Proto.Api.RaceActivityLessonProgress';
const LIVE_BONUS_INFO_MSG = 'Solis.Common.Proto.Api.RaceLiveBonusInfo';
const CARD_COOL_TIME_INFO_MSG = 'Solis.Common.Proto.Api.RaceUserCardCoolTimeInfo';
export const RACE_STEP_INTERVAL_MS = 10_000;

/**
 * Grade reached at `totalClearPanelCount`: the highest grade whose
 * `hierarchyPointFrom` is met, plus its 1-based number. Grades are authored in
 * ascending order; a `totalClearPanelCount` below the first grade still reads
 * as grade 1.
 */
export function raceRankGradeFor(
  config: RaceConfig,
  totalClearPanelCount: number,
): { grade: RaceRankGrade; number: number } {
  const grades = config.rankGrades;
  if (grades.length === 0) {
    return {
      grade: { id: '', name: '', hierarchyPointFrom: 0, topColorCode: '', bottomColorCode: '' },
      number: 1,
    };
  }
  let index = 0;
  for (let i = 0; i < grades.length; i++) {
    if (totalClearPanelCount >= grades[i].hierarchyPointFrom) index = i;
  }
  return { grade: grades[index], number: index + 1 };
}

/** Cleared tier *counts* of the pt / medal area quests. */
export interface RaceClearedTiers {
  pt: number;
  medal: number;
}

/** Existing difficulty numbers of the pt / medal area quests. */
export interface RaceAreaQuestTiers {
  pt: number[];
  medal: number[];
}

/** Existing difficulty numbers of both area quests, for tally resolution. */
export async function loadRaceAreaQuestTiers(config: RaceConfig): Promise<RaceAreaQuestTiers> {
  const ptRows = (await listRaceQuestDifficulties(config.areaQuestIds.pt)) as unknown as Decoded[];
  const medalRows = (await listRaceQuestDifficulties(config.areaQuestIds.medal)) as unknown as Decoded[];
  return { pt: tierNumbers(ptRows), medal: tierNumbers(medalRows) };
}

/**
 * Cleared tier counts of both area quests. Race tiers start at
 * `DifficultyNumber` 2, so the count (not the raw number) is what the activity
 * lesson reward scales with.
 */
export async function loadRaceClearedTiers(
  config: RaceConfig,
  state: RaceState,
): Promise<RaceClearedTiers> {
  const tiers = await loadRaceAreaQuestTiers(config);
  return {
    pt: clearedTierCountOf(tiers.pt, state.areaQuestClear[config.areaQuestIds.pt] ?? 0),
    medal: clearedTierCountOf(
      tiers.medal,
      state.areaQuestClear[config.areaQuestIds.medal] ?? 0,
    ),
  };
}

/**
 * Cleared tier counts as the 2-day tally has applied them at `atMs`: a clear
 * only counts from the tally boundary after it happened.
 */
export function buildRaceEffectiveClearedTiers(
  config: RaceConfig,
  state: RaceState,
  tiers: RaceAreaQuestTiers,
  startMs: number,
  atMs: number,
): RaceClearedTiers {
  const reachedAt = state.areaQuestTierReachedAt ?? { pt: {}, medal: {} };
  const ptClear = talliedClearTier(
    {
      clear: state.areaQuestClear[config.areaQuestIds.pt] ?? 0,
      reachedAt: reachedAt.pt ?? {},
    },
    startMs,
    atMs,
  );
  const medalClear = talliedClearTier(
    {
      clear: state.areaQuestClear[config.areaQuestIds.medal] ?? 0,
      reachedAt: reachedAt.medal ?? {},
    },
    startMs,
    atMs,
  );
  return {
    pt: clearedTierCountOf(tiers.pt, ptClear),
    medal: clearedTierCountOf(tiers.medal, medalClear),
  };
}

/** Same as `buildRaceEffectiveClearedTiers`, loading the quest tiers itself. */
export async function loadRaceEffectiveClearedTiers(
  config: RaceConfig,
  state: RaceState,
  startMs: number,
  atMs: number,
): Promise<RaceClearedTiers> {
  const tiers = await loadRaceAreaQuestTiers(config);
  return buildRaceEffectiveClearedTiers(config, state, tiers, startMs, atMs);
}

/** Lesson tiers (>= 1) of cleared tier counts: a fresh player still accrues. */
export function lessonTiersOf(clearedTiers: RaceClearedTiers): RaceClearedTiers {
  return {
    pt: Math.max(1, clearedTiers.pt),
    medal: Math.max(1, clearedTiers.medal),
  };
}

/** Per-step activity-lesson payout at the given lesson tiers. */
export interface RaceLessonStepReward {
  racePoint: number;
  raceMedal: number;
}

/**
 * Activity-lesson payout per 10 s step. The step reward scales with the number
 * of cleared tiers of the pt / medal area quest, floored at 1 so a fresh player
 * still accrues. Both race points and medals grow linearly from a per-step base
 * (fractional per-tier bonus).
 */
export function raceLessonStepReward(
  config: RaceConfig,
  clearedTiers: RaceClearedTiers,
): RaceLessonStepReward {
  const tiers = lessonTiersOf(clearedTiers);
  return {
    racePoint: Math.floor(
      config.activityLesson.racePointPerStepBase +
        config.activityLesson.racePointPerStepPerTier * (tiers.pt - 1),
    ),
    raceMedal: Math.floor(
      config.activityLesson.raceMedalPerStepBase +
        config.activityLesson.raceMedalPerStepPerTier * (tiers.medal - 1),
    ),
  };
}

/**
 * Activity-lesson payout view. `clearedTiers` are the tallied cleared tier
 * counts; when omitted the step reward falls back to tier 1.
 */
export function buildRaceActivityLessonProgress(
  config: RaceConfig,
  state: RaceState,
  clearedTiers?: RaceClearedTiers,
): Decoded {
  const reward = raceLessonStepReward(config, clearedTiers ?? { pt: 0, medal: 0 });
  const lastReceiveTime = state.lastActivityReceiveMs;
  const maxRewardTime = lastReceiveTime + config.activityLesson.maxHours * 60 * 60 * 1000;
  return {
    __msg: ACTIVITY_LESSON_PROGRESS_MSG,
    StepRewardRacePoint: reward.racePoint,
    StepRewardRaceMedal: reward.raceMedal,
    LastReceiveTime: lastReceiveTime,
    MaxRewardTime: maxRewardTime,
  };
}

export interface BuildUserRaceInfoOptions {
  /** 1-based server ranking position; 0 when unknown. */
  rank: number;
  now: number;
  /** Cleared tier counts; when omitted the step reward falls back to tier 1. */
  clearedTiers?: RaceClearedTiers;
  /**
   * `RacePanel.Type` of the panel the piece stands on, when known. The VENUS
   * panel score is only reported there; every other panel (and an unknown
   * panel) reports 0.
   */
  currentPanelType?: number;
}

/**
 * `RaceLiveBonusInfo` rows of `state.liveBonuses`: only raised bonuses, in
 * live-bonus id order. Shared by the caller's own `UserRaceInfo` and the
 * opponent rows of the board.
 */
export function buildRaceLiveBonusInfos(state: RaceState): Decoded[] {
  return Object.entries(state.liveBonuses)
    .filter(([, level]) => level > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([liveBonusId, level]) => ({
      __msg: LIVE_BONUS_INFO_MSG,
      LiveBonusId: liveBonusId,
      Level: level,
    })) as Decoded[];
}

export function buildUserRaceInfo(
  config: RaceConfig,
  state: RaceState,
  options: BuildUserRaceInfoOptions,
): Decoded {
  const { grade, number } = raceRankGradeFor(config, state.totalClearPanelCount);
  const liveBonusInfos = buildRaceLiveBonusInfos(state);
  const cardCoolTimeInfos = Object.entries(state.cardCoolTimes)
    .filter(([, coolTime]) => coolTime > options.now)
    .sort(([, a], [, b]) => a - b)
    .map(([cardId, coolTime]) => ({
      __msg: CARD_COOL_TIME_INFO_MSG,
      CardId: cardId,
      CoolTime: coolTime,
    }));

  return {
    __msg: USER_RACE_INFO_MSG,
    RankGradeId: grade.id,
    RankGradeNumber: number,
    // Field name is misspelled in the protocol; keep it verbatim.
    CurrnentRank: options.rank,
    CurrentAreaId: config.areaIds[state.areaIndex] ?? '',
    CurrentPanelNumber: state.panelNumber,
    ActivityLessonProgress: buildRaceActivityLessonProgress(config, state, options.clearedTiers),
    LiveBonusInfos: liveBonusInfos,
    CardCoolTimeInfos: cardCoolTimeInfos,
    TotalClearPanelCount: state.totalClearPanelCount,
    // Only the VENUS panel the piece stands on carries a stage score. After the
    // walk leaves it (`board.ts` zeroes the stored total) and in saves written
    // before that reset, the stored value can still be stale: report 0 unless
    // the current panel is type 3.
    CurrentLivePanelScore: options.currentPanelType === PANEL_VENUS ? state.currentLivePanelScore : 0,
  } as Decoded;
}

/** `UserRaceInfo` with the player's current server rank and tallied lesson rate. */
export async function loadRaceUserRaceInfo(
  playerId: string,
  config: RaceConfig,
  state: RaceState,
  now: number,
  startMs: number,
  exec: Executor = db,
): Promise<Decoded> {
  const rank = await racePlayerRank(playerId, config.raceId, exec);
  // The client sees the rate the tally has applied, not the raw clear level.
  const clearedTiers = await loadRaceEffectiveClearedTiers(config, state, startMs, now);
  return buildUserRaceInfo(config, state, {
    rank,
    now,
    clearedTiers,
    currentPanelType: await currentPanelTypeOf(config, state),
  });
}

/**
 * `RacePanel.Type` of the panel the piece stands on, or `undefined` when the
 * board is fresh (`panelNumber` 0) or the master row is missing. Looked up from
 * the same master `RacePanel` data `board.ts` walks.
 */
async function currentPanelTypeOf(config: RaceConfig, state: RaceState): Promise<number | undefined> {
  const areaId = config.areaIds[state.areaIndex];
  if (areaId === undefined || state.panelNumber <= 0) return undefined;
  const panel = (await getRacePanel(areaId, state.panelNumber)) as unknown as Decoded | null;
  if (panel === null) return undefined;
  const type = Number(panel.Type ?? 0);
  return Number.isFinite(type) ? type : undefined;
}
