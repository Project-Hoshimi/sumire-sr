// Authored race (レース) event shape. The draft is what the admin API stores
// and edits; the compiled runtime is what the RPC handlers read. The two are
// structurally identical today because every derived value can be derived
// again at compile time, so `RaceConfig` is an alias kept for clarity at the
// call sites (mirrors `MarathonConfig`).
import type { EventScheduleInput } from '../events/plugin.ts';

/** One rank grade of the race ladder (ブロンズ → チャレンジャー). */
export interface RaceRankGrade {
  id: string;
  name: string;
  /** `TotalClearPanelCount` at which this grade starts. */
  hierarchyPointFrom: number;
  topColorCode: string;
  bottomColorCode: string;
}

/** Activity-lesson payout, scaled by the cleared pt/medal quest tier. */
export interface RaceActivityLessonConfig {
  /** Race points paid per step at tier 1 (before the per-tier bonus). */
  racePointPerStepBase: number;
  /** Extra race points per step for each cleared pt tier above 1 (may be fractional). */
  racePointPerStepPerTier: number;
  /** Race medals paid per step at tier 1 (before the per-tier bonus). */
  raceMedalPerStepBase: number;
  /** Extra race medals per step for each cleared medal tier above 1 (may be fractional). */
  raceMedalPerStepPerTier: number;
  maxHours: number;
}

/**
 * VENUS live-panel difficulty per player VENUS grade. The grade is the master
 * `HierarchyGrade` id the player stands in (BIG4 → Challenger); each grade maps
 * to one of the quest's difficulty tiers. A race freezes the tier into the
 * player's state the first time they open it.
 */
export interface RaceGradeDifficultyConfig {
  challenger: number;
  bronze: number;
  silver: number;
  gold: number;
  platinum: number;
  diamond: number;
  big4: number;
}

/** Reward for clearing one tier of the pt / medal area quest. */
export interface RaceAreaQuestRewardConfig {
  racePointPerTier: number;
  raceMedalPerTier: number;
}

/** Ids of the two area quests every race owns. */
export interface RaceAreaQuestIds {
  pt: string;
  medal: string;
}

export interface RaceDraft {
  /** Event id of the race definition; the race id itself. */
  raceId: string;
  name: string;
  assetId: string;
  bannerAssetId: string;
  racePointItemId: string;
  raceMedalItemId: string;
  raceLiveBonusResetItemId: string;
  eventMissionId: string;
  eventStoryId: string;
  /** Board areas in play order; each maps to one `RaceAreaInfo`. */
  areaIds: string[];
  raceLiveBonusGroupId: string;
  areaQuestIds: RaceAreaQuestIds;
  /** Difficulty tier used for the VENUS (live panel) quests. */
  livePanelDifficultyNumber: number;
  /**
   * Difficulty tier of the VENUS (live panel) quests per player VENUS grade.
   * Read once, when the player first opens the race, and frozen into their
   * race state; `livePanelDifficultyNumber` above is the fallback.
   */
  gradeDifficulty: RaceGradeDifficultyConfig;
  cardCoolTimeMinutes: number;
  requiredCardCoolTimeRacePointAmount: number;
  /**
   * Race-point stock granted the first time a player's race state is created,
   * so the board is playable before the activity lesson has accrued anything.
   */
  initialRacePointAmount: number;
  rankGrades: RaceRankGrade[];
  activityLesson: RaceActivityLessonConfig;
  areaQuestReward: RaceAreaQuestRewardConfig;
  /** Number of real players shown next to the player on the board. */
  rivals: number;
  /**
   * NPC roster played by the versus (ClearScore 0) race quests. Race quests
   * carry no opponent column in master, so every versus tier uses this roster,
   * scaled to the tier's `DifficultyLevel`.
   */
  npcRosterId: string;
  /** Per-quest roster override, keyed by race quest id (`race-qt-...`). */
  npcRosterByQuest: Record<string, string>;
  /**
   * Reward override per reward (type 2) panel, keyed `<areaId>:<panelNumber>`.
   * The value lists the reward references to grant, in the same shape the
   * marathon reward picker stores (a master `Reward` id or an inline
   * `rd_auto;<snake type>;<resourceId>;<amount>`). An absent key keeps the
   * panel's master `RacePanelReward` row, which always stays the source.
   */
  panelRewards?: Record<string, string[]>;
  /**
   * Synthetic players padded into the ranking and the board rival list so a
   * small server looks populated. They are generated on read and never stored;
   * a missing block behaves exactly like `enabled: false`.
   */
  bots?: RaceBotConfig;
  schedule?: EventScheduleInput;
}

/**
 * Synthetic race participants ("bots"). They appear in `Race:Ranking` and the
 * board rival list with a deterministic pace, but own no player row and never
 * receive rewards.
 */
export interface RaceBotConfig {
  enabled: boolean;
  /** How many bots the race generates at all; 0 disables them too. */
  count: number;
  /** Slowest bot pace, in cleared panels per day. */
  minPanelsPerDay: number;
  /** Fastest bot pace, in cleared panels per day. */
  maxPanelsPerDay: number;
  /**
   * Display handles, rotated per bot. An empty list (the default) names each
   * bot after a master idol and shows that idol's icon; a non-empty list keeps
   * the custom handles (the icon is then picked by `displayCharacterIndex`).
   */
  names: string[];
}

/**
 * Reward references overriding one reward (type 2) panel, or `undefined` when
 * the master `RacePanelReward` row still applies.
 */
export function panelRewardOverride(
  draft: Pick<RaceDraft, 'panelRewards'>,
  areaId: string,
  panelNumber: number,
): readonly string[] | undefined {
  const refs = draft.panelRewards?.[`${areaId}:${panelNumber}`];
  return refs === undefined || refs.length === 0 ? undefined : refs;
}

/** Compiled runtime handed to the RPC handlers. */
export type RaceConfig = RaceDraft;

/**
 * Default rank ladder. `hierarchyPointFrom` is compared against
 * `TotalClearPanelCount`, so the first grade starts at zero.
 */
export const RACE_RANK_GRADE_DEFAULTS: readonly RaceRankGrade[] = [
  { id: 'race_rank_grade-bronze', name: 'ブロンズ', hierarchyPointFrom: 0, topColorCode: '#C08A5A', bottomColorCode: '#7A4E2A' },
  { id: 'race_rank_grade-silver', name: 'シルバー', hierarchyPointFrom: 50, topColorCode: '#D8D8D8', bottomColorCode: '#8C8C8C' },
  { id: 'race_rank_grade-gold', name: 'ゴールド', hierarchyPointFrom: 120, topColorCode: '#F4D35E', bottomColorCode: '#B8860B' },
  { id: 'race_rank_grade-platinum', name: 'プラチナ', hierarchyPointFrom: 200, topColorCode: '#CFE8F0', bottomColorCode: '#7FA8B8' },
  { id: 'race_rank_grade-diamond1', name: 'ダイヤモンドⅠ', hierarchyPointFrom: 300, topColorCode: '#A8E6FF', bottomColorCode: '#3A8DDE' },
  { id: 'race_rank_grade-diamond2', name: 'ダイヤモンドⅡ', hierarchyPointFrom: 450, topColorCode: '#C9B6FF', bottomColorCode: '#6A4CDE' },
  { id: 'race_rank_grade-challenger', name: 'チャレンジャー', hierarchyPointFrom: 600, topColorCode: '#FF9AA2', bottomColorCode: '#C2185B' },
];

export const RACE_ACTIVITY_LESSON_DEFAULTS: RaceActivityLessonConfig = {
  racePointPerStepBase: 34,
  racePointPerStepPerTier: 4.5,
  raceMedalPerStepBase: 17,
  raceMedalPerStepPerTier: 3.3,
  maxHours: 36,
};

export const RACE_AREA_QUEST_REWARD_DEFAULTS: RaceAreaQuestRewardConfig = {
  racePointPerTier: 2000,
  raceMedalPerTier: 100,
};

/** The only live-bonus group race quests reference. */
export const RACE_LIVE_BONUS_GROUP_ID = 'race_live_bonus_group-001';

export const RACE_RIVAL_COUNT = 4;

export const RACE_BOT_DEFAULT_COUNT = 30;
export const RACE_BOT_DEFAULT_MIN_PANELS_PER_DAY = 20;
export const RACE_BOT_DEFAULT_MAX_PANELS_PER_DAY = 120;
/** Validation ceilings for the authored bot block. */
export const RACE_BOT_MAX_COUNT = 500;
export const RACE_BOT_MAX_NAMES = 200;
export const RACE_BOT_MAX_NAME_LENGTH = 20;

/**
 * Default opponent roster of the race versus quests. It is a checked-in NPC
 * roster (`src/live/data/npcRosters.ts`), so it resolves without a DB row.
 */
export const RACE_DEFAULT_NPC_ROSTER_ID = 'qt-main-1-007-04';

export const RACE_DEFAULT_LIVE_PANEL_DIFFICULTY_NUMBER = 1;

/**
 * Default VENUS difficulty ladder: Challenger (lowest VENUS grade) plays the
 * easiest tier and BIG4 the hardest. Seven tiers match the seven grades.
 */
export const RACE_DEFAULT_GRADE_DIFFICULTY: RaceGradeDifficultyConfig = {
  challenger: 1,
  bronze: 2,
  silver: 3,
  gold: 4,
  platinum: 5,
  diamond: 6,
  big4: 7,
};
export const RACE_DEFAULT_CARD_COOL_TIME_MINUTES = 60;
export const RACE_DEFAULT_REQUIRED_CARD_COOL_TIME_RACE_POINT_AMOUNT = 100;

/** Starting race points handed out when a player first opens the race. */
export const RACE_DEFAULT_INITIAL_RACE_POINT_AMOUNT = 3000;

/** `YY-MMDD` suffix of a race id, e.g. `26-0226` for `race-26-0226`. */
export function raceDateSuffix(raceId: string): string {
  return /(\d{2}-\d{4})$/.exec(raceId)?.[1] ?? '';
}

/** Prefix shared by every quest id of a race, e.g. `race-qt-26-0226-`. */
export function raceQuestIdPrefix(raceId: string): string {
  const suffix = raceDateSuffix(raceId);
  return suffix === '' ? '' : `race-qt-${suffix}-`;
}

/** Event asset id of a race (`event-race-26-0226` for `race-26-0226`). */
export function raceEventAssetId(raceId: string): string {
  return `event-${raceId}`;
}
