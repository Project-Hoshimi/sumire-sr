// Pure derivation of a race draft from master lookups. The database reads live
// in `plugin.importFromMaster`; keeping the derivation pure lets the tests run
// against the checked-in `phaseA2/out/structured/*.json` without Postgres.
import {
  RACE_ACTIVITY_LESSON_DEFAULTS,
  RACE_AREA_QUEST_REWARD_DEFAULTS,
  RACE_DEFAULT_CARD_COOL_TIME_MINUTES,
  RACE_DEFAULT_GRADE_DIFFICULTY,
  RACE_DEFAULT_INITIAL_RACE_POINT_AMOUNT,
  RACE_DEFAULT_LIVE_PANEL_DIFFICULTY_NUMBER,
  RACE_DEFAULT_NPC_ROSTER_ID,
  RACE_DEFAULT_REQUIRED_CARD_COOL_TIME_RACE_POINT_AMOUNT,
  RACE_LIVE_BONUS_GROUP_ID,
  RACE_RANK_GRADE_DEFAULTS,
  RACE_RIVAL_COUNT,
  raceDateSuffix,
  raceEventAssetId,
  raceQuestIdPrefix,
  type RaceDraft,
} from './types.ts';

export { RACE_DEFAULT_GRADE_DIFFICULTY };

/** Master rows a race draft is derived from, as plain values. */
export interface RaceDraftLookups {
  /** `Item.Id` values that exist in master. */
  existingItemIds: readonly string[];
  /** Emblem title whose `AssetId` is the race id, when one exists. */
  emblemName: string | null;
  /** `master_EventStory.Id` of the story whose `AssetId` is `event-<raceId>`. */
  eventStoryId: string | null;
  /** `master_EventMission.Name` of `event-<raceId>`, when the row exists. */
  eventMissionName: string | null;
  /** Board area ids of the race, sorted ascending. */
  areaIds: readonly string[];
  /** Area quest ids (pt / medal) that exist in master for this race. */
  areaQuestIds: readonly string[];
}

/** Race point item id of a race date, e.g. `item-race_point-26-0226`. */
export function racePointItemIdFor(raceId: string): string {
  const suffix = raceDateSuffix(raceId);
  return suffix === '' ? '' : `item-race_point-${suffix}`;
}

/** Race medal item id of a race date, e.g. `item-race_medal-26-0226`. */
export function raceMedalItemIdFor(raceId: string): string {
  const suffix = raceDateSuffix(raceId);
  return suffix === '' ? '' : `item-race_medal-${suffix}`;
}

/** Live-bonus reset item id, e.g. `item-race_reset-live-bonus-26-0226`. */
export function raceLiveBonusResetItemIdFor(raceId: string): string {
  const suffix = raceDateSuffix(raceId);
  return suffix === '' ? '' : `item-race_reset-live-bonus-${suffix}`;
}

/** The pt area quest id of a race, e.g. `race-qt-26-0226-pt`. */
export function racePointQuestIdFor(raceId: string): string {
  const prefix = raceQuestIdPrefix(raceId);
  return prefix === '' ? '' : `${prefix}pt`;
}

/** The medal area quest id of a race, e.g. `race-qt-26-0226-medal`. */
export function raceMedalQuestIdFor(raceId: string): string {
  const prefix = raceQuestIdPrefix(raceId);
  return prefix === '' ? '' : `${prefix}medal`;
}

/**
 * Build the draft for `raceId`. Missing master rows become empty ids so the
 * plugin's `validate` can report them; nothing is invented beyond the authored
 * defaults for the rank ladder, activity lesson and area-quest payouts.
 */
export function deriveRaceDraft(raceId: string, lookups: RaceDraftLookups): RaceDraft {
  const existing = new Set(lookups.existingItemIds);
  const pickItem = (id: string) => (id !== '' && existing.has(id) ? id : '');
  const questIds = new Set(lookups.areaQuestIds);
  const pickQuest = (id: string) => (id !== '' && questIds.has(id) ? id : '');
  const assetId = raceEventAssetId(raceId);
  // Mirrors marathon: the banner has no master table of its own, so its asset
  // follows the checked-in `img_banner_l_<event>` naming whenever the event
  // asset exists. `assetId` itself stays the EventStory asset id.
  const hasEventAsset = lookups.eventStoryId !== null || lookups.eventMissionName !== null;
  const eventMissionId = lookups.eventMissionName === null ? '' : assetId;

  return {
    raceId,
    name: lookups.emblemName ?? raceId,
    assetId,
    bannerAssetId: hasEventAsset ? `img_banner_l_${eventMissionId === '' ? assetId : eventMissionId}` : '',
    racePointItemId: pickItem(racePointItemIdFor(raceId)),
    raceMedalItemId: pickItem(raceMedalItemIdFor(raceId)),
    raceLiveBonusResetItemId: pickItem(raceLiveBonusResetItemIdFor(raceId)),
    eventMissionId,
    eventStoryId: lookups.eventStoryId ?? '',
    areaIds: [...new Set(lookups.areaIds)].sort(),
    raceLiveBonusGroupId: RACE_LIVE_BONUS_GROUP_ID,
    areaQuestIds: {
      pt: pickQuest(racePointQuestIdFor(raceId)),
      medal: pickQuest(raceMedalQuestIdFor(raceId)),
    },
    livePanelDifficultyNumber: RACE_DEFAULT_LIVE_PANEL_DIFFICULTY_NUMBER,
    gradeDifficulty: { ...RACE_DEFAULT_GRADE_DIFFICULTY },
    cardCoolTimeMinutes: RACE_DEFAULT_CARD_COOL_TIME_MINUTES,
    requiredCardCoolTimeRacePointAmount: RACE_DEFAULT_REQUIRED_CARD_COOL_TIME_RACE_POINT_AMOUNT,
    initialRacePointAmount: RACE_DEFAULT_INITIAL_RACE_POINT_AMOUNT,
    rankGrades: RACE_RANK_GRADE_DEFAULTS.map((grade) => ({ ...grade })),
    activityLesson: { ...RACE_ACTIVITY_LESSON_DEFAULTS },
    areaQuestReward: { ...RACE_AREA_QUEST_REWARD_DEFAULTS },
    rivals: RACE_RIVAL_COUNT,
    npcRosterId: RACE_DEFAULT_NPC_ROSTER_ID,
    npcRosterByQuest: {},
    // Board panel rewards always import from master; an override is authored.
    panelRewards: {},
  };
}
