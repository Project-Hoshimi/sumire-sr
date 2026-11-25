// Event builder plugin for the Race (レース) event kind. The draft is authored
// in the admin UI (or imported from master data) and compiled to the
// `RaceConfig` the race services read at runtime.
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import * as master from '../../db/masterSchema.ts';
import { getEventMission, getEventStoryByAssetId, listExistingItemIds } from '../../master/index.ts';
import { rosterById } from '../rosters/cache.ts';
import {
  registerEventPlugin,
  type EventPlugin,
  type EventScheduleInput,
  type EditorSchema,
  type StateImpact,
  type ValidationIssue,
} from '../events/plugin.ts';
import {
  deriveRaceDraft,
  raceLiveBonusResetItemIdFor,
  raceMedalItemIdFor,
  racePointItemIdFor,
  type RaceDraftLookups,
} from './importDraft.ts';
import {
  raceBoardRewardPanelKeys,
  raceBoardVenusQuestIds,
  rewardPanelKeysOfPanels,
  setRaceBoardRewardPanelKeys,
  setRaceBoardVenusQuestIds,
  venusQuestIdsOfPanels,
} from './boardPreview.ts';
import { listRaceAreaIds, listRaceAreaQuests, listRacePanelsByAreas } from './master.ts';
import {
  RACE_ACTIVITY_LESSON_DEFAULTS,
  RACE_AREA_QUEST_REWARD_DEFAULTS,
  RACE_BOT_DEFAULT_COUNT,
  RACE_BOT_DEFAULT_MAX_PANELS_PER_DAY,
  RACE_BOT_DEFAULT_MIN_PANELS_PER_DAY,
  RACE_BOT_MAX_COUNT,
  RACE_BOT_MAX_NAMES,
  RACE_BOT_MAX_NAME_LENGTH,
  RACE_DEFAULT_CARD_COOL_TIME_MINUTES,
  RACE_DEFAULT_GRADE_DIFFICULTY,
  RACE_DEFAULT_INITIAL_RACE_POINT_AMOUNT,
  RACE_DEFAULT_LIVE_PANEL_DIFFICULTY_NUMBER,
  RACE_DEFAULT_NPC_ROSTER_ID,
  RACE_DEFAULT_REQUIRED_CARD_COOL_TIME_RACE_POINT_AMOUNT,
  RACE_LIVE_BONUS_GROUP_ID,
  RACE_RANK_GRADE_DEFAULTS,
  RACE_RIVAL_COUNT,
  raceEventAssetId,
  raceQuestIdPrefix,
  type RaceBotConfig,
  type RaceConfig,
  type RaceDraft,
  type RaceGradeDifficultyConfig,
  type RaceRankGrade,
} from './types.ts';

export { RACE_DEFAULT_GRADE_DIFFICULTY };

const KIND = 'race';
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** `<areaId>:<panelNumber>` key of a board reward override. */
const PANEL_REWARD_KEY = /^(.+):([1-9]\d*)$/;

function s(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => s(entry)).filter((entry) => entry !== '');
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameRosterMap(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const keys = Object.keys(left).sort();
  const draftKeys = Object.keys(right).sort();
  return sameStrings(keys, draftKeys) && keys.every((key) => left[key] === right[key]);
}

function samePanelRewards(
  left: RaceDraft['panelRewards'],
  right: RaceDraft['panelRewards'],
): boolean {
  const leftRewards = left ?? {};
  const rightRewards = right ?? {};
  const keys = Object.keys(leftRewards).sort();
  const draftKeys = Object.keys(rightRewards).sort();
  return (
    sameStrings(keys, draftKeys) &&
    keys.every((key) => sameStrings(leftRewards[key] ?? [], rightRewards[key] ?? []))
  );
}

function sameLesson(
  left: RaceDraft['activityLesson'],
  right: RaceDraft['activityLesson'],
): boolean {
  return (
    left.racePointPerStepBase === right.racePointPerStepBase &&
    left.racePointPerStepPerTier === right.racePointPerStepPerTier &&
    left.raceMedalPerStepBase === right.raceMedalPerStepBase &&
    left.raceMedalPerStepPerTier === right.raceMedalPerStepPerTier &&
    left.maxHours === right.maxHours
  );
}

function sameReward(
  left: RaceDraft['areaQuestReward'],
  right: RaceDraft['areaQuestReward'],
): boolean {
  return (
    left.racePointPerTier === right.racePointPerTier &&
    left.raceMedalPerTier === right.raceMedalPerTier
  );
}

/**
 * Grade → difficulty leaves in schema order (lowest VENUS grade first). Parsing,
 * validation and the publish impact all walk the mapping through this list so a
 * new grade cannot be forgotten in one of them.
 */
const GRADE_DIFFICULTY_KEYS = [
  'challenger',
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'big4',
] as const satisfies readonly (keyof RaceGradeDifficultyConfig)[];

/** The grade mapping, tolerating hand-written configs that predate it. */
function gradeDifficultyOf(draft: RaceDraft | undefined): RaceGradeDifficultyConfig {
  const raw = draft?.gradeDifficulty as
    | Partial<Record<keyof RaceGradeDifficultyConfig, unknown>>
    | undefined;
  const source = objectValue(raw);
  const result = { ...RACE_DEFAULT_GRADE_DIFFICULTY };
  for (const key of GRADE_DIFFICULTY_KEYS) {
    result[key] = num(source[key], RACE_DEFAULT_GRADE_DIFFICULTY[key]);
  }
  return result;
}

function sameGradeDifficulty(
  left: RaceGradeDifficultyConfig,
  right: RaceGradeDifficultyConfig,
): boolean {
  return GRADE_DIFFICULTY_KEYS.every((key) => left[key] === right[key]);
}

function parseSchedule(value: unknown): EventScheduleInput | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('race draft: schedule must be an object');
  }
  const raw = value as Record<string, unknown>;
  return {
    startsAt: s(raw.startsAt ?? raw.StartsAt),
    endsAt: s(raw.endsAt ?? raw.EndsAt),
    exchangeEndsAt: s(raw.exchangeEndsAt ?? raw.ExchangeEndsAt),
  };
}

/** Per-quest roster overrides; empty values are dropped so defaults apply. */
function parseNpcRosterByQuest(value: unknown): Record<string, string> {
  const raw = objectValue(value);
  const rosters: Record<string, string> = {};
  for (const [questId, rosterId] of Object.entries(raw)) {
    const id = s(rosterId);
    if (questId !== '' && id !== '') rosters[questId] = id;
  }
  return rosters;
}

/**
 * Board reward overrides keyed `<areaId>:<panelNumber>`. Empty lists are
 * dropped so the panel keeps its master `RacePanelReward` row.
 */
function parsePanelRewards(value: unknown): Record<string, string[]> {
  const raw = objectValue(value);
  const rewards: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const refs = strArray(entry);
    if (key !== '' && refs.length > 0) rewards[key] = refs;
  }
  return rewards;
}

function parseRankGrades(value: unknown): RaceRankGrade[] {
  if (!Array.isArray(value) || value.length === 0) {
    return RACE_RANK_GRADE_DEFAULTS.map((grade) => ({ ...grade }));
  }
  return value.map((entry) => {
    const raw = objectValue(entry);
    return {
      id: s(raw.id),
      name: s(raw.name),
      hierarchyPointFrom: num(raw.hierarchyPointFrom, 0),
      topColorCode: s(raw.topColorCode),
      bottomColorCode: s(raw.bottomColorCode),
    };
  });
}

function scheduleMs(value: string): number {
  return ISO_UTC.test(value) ? Date.parse(value) : Number.NaN;
}

function validateSchedule(schedule: EventScheduleInput | undefined): ValidationIssue[] {
  if (!schedule) return [];
  const issues: ValidationIssue[] = [];
  const start = scheduleMs(schedule.startsAt);
  const end = scheduleMs(schedule.endsAt);
  const exchangeEnd = scheduleMs(schedule.exchangeEndsAt);
  if (!Number.isFinite(start)) {
    issues.push({ path: 'schedule.startsAt', message: 'must be an ISO-8601 UTC timestamp', severity: 'error' });
  }
  if (!Number.isFinite(end)) {
    issues.push({ path: 'schedule.endsAt', message: 'must be an ISO-8601 UTC timestamp', severity: 'error' });
  }
  if (!Number.isFinite(exchangeEnd)) {
    issues.push({ path: 'schedule.exchangeEndsAt', message: 'must be an ISO-8601 UTC timestamp', severity: 'error' });
  }
  if (Number.isFinite(start) && Number.isFinite(end) && !(start < end)) {
    issues.push({ path: 'schedule.endsAt', message: 'must be after startsAt', severity: 'error' });
  }
  if (Number.isFinite(end) && Number.isFinite(exchangeEnd) && !(end <= exchangeEnd)) {
    issues.push({ path: 'schedule.exchangeEndsAt', message: 'must not be before endsAt', severity: 'error' });
  }
  return issues;
}

/** A race with no authored bot block: bots exist in the draft but are off. */
export function defaultRaceBotConfig(): RaceBotConfig {
  return {
    enabled: false,
    count: RACE_BOT_DEFAULT_COUNT,
    minPanelsPerDay: RACE_BOT_DEFAULT_MIN_PANELS_PER_DAY,
    maxPanelsPerDay: RACE_BOT_DEFAULT_MAX_PANELS_PER_DAY,
    names: [],
  };
}

/**
 * Coerce the authored bot block. A missing block means disabled with the
 * defaults; an empty name list (the default) names the bots after master idols.
 */
function parseBots(value: unknown): RaceBotConfig {
  const raw = objectValue(value);
  const names = strArray(raw.names)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return {
    enabled: raw.enabled === true,
    count: num(raw.count, RACE_BOT_DEFAULT_COUNT),
    minPanelsPerDay: num(raw.minPanelsPerDay, RACE_BOT_DEFAULT_MIN_PANELS_PER_DAY),
    maxPanelsPerDay: num(raw.maxPanelsPerDay, RACE_BOT_DEFAULT_MAX_PANELS_PER_DAY),
    names,
  };
}

/** Starting draft for a brand-new race definition with no master rows. */
export function defaultRaceDraft(raceId: string): RaceDraft {
  const assetId = raceEventAssetId(raceId);
  return {
    raceId,
    name: raceId,
    assetId,
    // The banner follows marathon's `img_banner_l_<event>` convention and is
    // filled by `importFromMaster` once the event asset exists; a draft that was
    // never imported keeps it empty rather than pointing at a missing image.
    bannerAssetId: '',
    racePointItemId: '',
    raceMedalItemId: '',
    raceLiveBonusResetItemId: '',
    eventMissionId: '',
    eventStoryId: '',
    areaIds: [],
    raceLiveBonusGroupId: RACE_LIVE_BONUS_GROUP_ID,
    areaQuestIds: { pt: '', medal: '' },
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
    // Board panel rewards stay on master until the admin authors an override.
    panelRewards: {},
    bots: defaultRaceBotConfig(),
  };
}

const SCHEMA: EditorSchema = {
  fields: [
    // Master-derived: imported from master data and displayed read-only.
    { path: 'raceId', type: 'string', label: 'Race id', readOnly: true },
    { path: 'name', type: 'string', label: 'Name', readOnly: true },
    { path: 'assetId', type: 'string', label: 'Asset id', readOnly: true },
    { path: 'bannerAssetId', type: 'string', label: 'Banner asset id', readOnly: true },
    { path: 'racePointItemId', type: 'string', label: 'Race point item', readOnly: true },
    { path: 'raceMedalItemId', type: 'string', label: 'Race medal item', readOnly: true },
    { path: 'raceLiveBonusResetItemId', type: 'string', label: 'Live bonus reset item', readOnly: true },
    { path: 'eventMissionId', type: 'string', label: 'Event mission id', readOnly: true },
    { path: 'eventStoryId', type: 'string', label: 'Event story id', readOnly: true },
    { path: 'areaIds', type: 'array', label: 'Board areas', readOnly: true },
    { path: 'raceLiveBonusGroupId', type: 'string', label: 'Live bonus group id', readOnly: true },
    { path: 'areaQuestIds.pt', type: 'string', label: 'Race point area quest', readOnly: true },
    { path: 'areaQuestIds.medal', type: 'string', label: 'Race medal area quest', readOnly: true },
    // Authored tuning.
    { path: 'livePanelDifficultyNumber', type: 'number', label: 'Live panel difficulty (fallback)' },
    { path: 'gradeDifficulty', type: 'object', label: 'Difficulty by VENUS grade' },
    { path: 'gradeDifficulty.challenger', type: 'number', label: 'Difficulty for Challenger' },
    { path: 'gradeDifficulty.bronze', type: 'number', label: 'Difficulty for Bronze' },
    { path: 'gradeDifficulty.silver', type: 'number', label: 'Difficulty for Silver' },
    { path: 'gradeDifficulty.gold', type: 'number', label: 'Difficulty for Gold' },
    { path: 'gradeDifficulty.platinum', type: 'number', label: 'Difficulty for Platinum' },
    { path: 'gradeDifficulty.diamond', type: 'number', label: 'Difficulty for Diamond' },
    { path: 'gradeDifficulty.big4', type: 'number', label: 'Difficulty for BIG4' },
    { path: 'cardCoolTimeMinutes', type: 'number', label: 'Card cool time (minutes)' },
    { path: 'requiredCardCoolTimeRacePointAmount', type: 'number', label: 'Card cool time reset cost' },
    { path: 'initialRacePointAmount', type: 'number', label: 'Starting race points' },
    { path: 'rivals', type: 'number', label: 'Opponents shown (real players)' },
    { path: 'npcRosterId', type: 'string', label: 'Versus NPC roster' },
    // Structured sections. The admin renders these with race-specific editors
    // (rank-grade table, lesson preview); the scalar leaves are still listed so
    // their labels and validation paths are visible in the schema.
    { path: 'rankGrades', type: 'array', label: 'Rank grades' },
    { path: 'activityLesson', type: 'object', label: 'Activity lesson' },
    { path: 'activityLesson.racePointPerStepBase', type: 'number', label: 'Race points per step (base)' },
    { path: 'activityLesson.racePointPerStepPerTier', type: 'number', label: 'Race points per step per tier' },
    { path: 'activityLesson.raceMedalPerStepBase', type: 'number', label: 'Race medals per step (base)' },
    { path: 'activityLesson.raceMedalPerStepPerTier', type: 'number', label: 'Race medals per step per tier' },
    { path: 'activityLesson.maxHours', type: 'number', label: 'Activity lesson cap (hours)' },
    { path: 'areaQuestReward', type: 'object', label: 'Area quest reward' },
    { path: 'areaQuestReward.racePointPerTier', type: 'number', label: 'Race points per tier' },
    { path: 'areaQuestReward.raceMedalPerTier', type: 'number', label: 'Race medals per tier' },
    { path: 'npcRosterByQuest', type: 'object', label: 'Per-quest NPC rosters' },
    { path: 'panelRewards', type: 'object', label: 'Per-panel board rewards' },
    { path: 'bots', type: 'object', label: 'Bots' },
    { path: 'bots.enabled', type: 'boolean', label: 'Generate bots' },
    { path: 'bots.count', type: 'number', label: 'Bot count' },
    { path: 'bots.minPanelsPerDay', type: 'number', label: 'Slowest bot (panels/day)' },
    { path: 'bots.maxPanelsPerDay', type: 'number', label: 'Fastest bot (panels/day)' },
    { path: 'bots.names', type: 'array', label: 'Bot names' },
    { path: 'schedule', type: 'object', label: 'Schedule' },
  ],
};

export const racePlugin: EventPlugin<RaceDraft, RaceConfig> = {
  kind: KIND,
  schema: SCHEMA,

  parseDraft(raw: unknown): RaceDraft {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('race draft: expected a JSON object');
    }
    const obj = raw as Record<string, unknown>;
    const areaQuest = objectValue(obj.areaQuestIds);
    const activityLesson = objectValue(obj.activityLesson);
    const areaQuestReward = objectValue(obj.areaQuestReward);
    const gradeDifficulty = objectValue(obj.gradeDifficulty);
    const defaults = defaultRaceDraft(s(obj.raceId));
    return {
      raceId: s(obj.raceId),
      name: s(obj.name),
      assetId: s(obj.assetId),
      bannerAssetId: s(obj.bannerAssetId),
      racePointItemId: s(obj.racePointItemId),
      raceMedalItemId: s(obj.raceMedalItemId),
      raceLiveBonusResetItemId: s(obj.raceLiveBonusResetItemId),
      eventMissionId: s(obj.eventMissionId),
      eventStoryId: s(obj.eventStoryId),
      areaIds: strArray(obj.areaIds),
      raceLiveBonusGroupId: s(obj.raceLiveBonusGroupId),
      areaQuestIds: { pt: s(areaQuest.pt), medal: s(areaQuest.medal) },
      livePanelDifficultyNumber: num(obj.livePanelDifficultyNumber, defaults.livePanelDifficultyNumber),
      gradeDifficulty: {
        challenger: num(gradeDifficulty.challenger, RACE_DEFAULT_GRADE_DIFFICULTY.challenger),
        bronze: num(gradeDifficulty.bronze, RACE_DEFAULT_GRADE_DIFFICULTY.bronze),
        silver: num(gradeDifficulty.silver, RACE_DEFAULT_GRADE_DIFFICULTY.silver),
        gold: num(gradeDifficulty.gold, RACE_DEFAULT_GRADE_DIFFICULTY.gold),
        platinum: num(gradeDifficulty.platinum, RACE_DEFAULT_GRADE_DIFFICULTY.platinum),
        diamond: num(gradeDifficulty.diamond, RACE_DEFAULT_GRADE_DIFFICULTY.diamond),
        big4: num(gradeDifficulty.big4, RACE_DEFAULT_GRADE_DIFFICULTY.big4),
      },
      cardCoolTimeMinutes: num(obj.cardCoolTimeMinutes, defaults.cardCoolTimeMinutes),
      requiredCardCoolTimeRacePointAmount: num(
        obj.requiredCardCoolTimeRacePointAmount,
        defaults.requiredCardCoolTimeRacePointAmount,
      ),
      initialRacePointAmount: num(
        obj.initialRacePointAmount,
        defaults.initialRacePointAmount,
      ),
      rankGrades: parseRankGrades(obj.rankGrades),
      activityLesson: {
        // Older drafts predate `racePointPerStepBase`; fall back to the default.
        racePointPerStepBase: num(
          activityLesson.racePointPerStepBase,
          RACE_ACTIVITY_LESSON_DEFAULTS.racePointPerStepBase,
        ),
        racePointPerStepPerTier: num(activityLesson.racePointPerStepPerTier, RACE_ACTIVITY_LESSON_DEFAULTS.racePointPerStepPerTier),
        // Older drafts predate `raceMedalPerStepBase`; fall back to the default.
        raceMedalPerStepBase: num(
          activityLesson.raceMedalPerStepBase,
          RACE_ACTIVITY_LESSON_DEFAULTS.raceMedalPerStepBase,
        ),
        raceMedalPerStepPerTier: num(activityLesson.raceMedalPerStepPerTier, RACE_ACTIVITY_LESSON_DEFAULTS.raceMedalPerStepPerTier),
        maxHours: num(activityLesson.maxHours, RACE_ACTIVITY_LESSON_DEFAULTS.maxHours),
      },
      areaQuestReward: {
        racePointPerTier: num(areaQuestReward.racePointPerTier, RACE_AREA_QUEST_REWARD_DEFAULTS.racePointPerTier),
        raceMedalPerTier: num(areaQuestReward.raceMedalPerTier, RACE_AREA_QUEST_REWARD_DEFAULTS.raceMedalPerTier),
      },
      rivals: num(obj.rivals, RACE_RIVAL_COUNT),
      npcRosterId: s(obj.npcRosterId) || defaults.npcRosterId,
      npcRosterByQuest: parseNpcRosterByQuest(obj.npcRosterByQuest),
      panelRewards: parsePanelRewards(obj.panelRewards),
      bots: parseBots(obj.bots),
      schedule: parseSchedule(obj.schedule ?? obj.Schedule),
    };
  },

  draftId(draft: RaceDraft): string {
    return draft.raceId;
  },

  draftTitle(draft: RaceDraft): string {
    return draft.name;
  },

  draftSchedule(draft: RaceDraft): EventScheduleInput | undefined {
    return draft.schedule;
  },

  async importFromMaster(eventId: string): Promise<RaceDraft> {
    const assetId = raceEventAssetId(eventId);
    const [story, mission, areaIds, areaQuests, existingItemIds, emblems] = await Promise.all([
      getEventStoryByAssetId(assetId),
      getEventMission(assetId),
      listRaceAreaIds(eventId),
      listRaceAreaQuests(eventId),
      listExistingItemIds([
        racePointItemIdFor(eventId),
        raceMedalItemIdFor(eventId),
        raceLiveBonusResetItemIdFor(eventId),
      ]),
      db
        .select({ Name: master.masterEmblem.Name })
        .from(master.masterEmblem)
        .where(eq(master.masterEmblem.AssetId, eventId))
        .limit(1),
    ]);
    const lookups: RaceDraftLookups = {
      existingItemIds,
      emblemName: s(emblems[0]?.Name) === '' ? null : String(emblems[0]?.Name),
      eventStoryId: story ? String(story.Id ?? '') || null : null,
      eventMissionName: mission ? s(mission.Name) : null,
      areaIds,
      areaQuestIds: areaQuests.map((row) => String(row.Id ?? '')).filter((id) => id !== ''),
    };
    // Remember the VENUS panels so a later save can warn about roster
    // overrides that target a panel quest which never runs a versus match.
    const panels = await listRacePanelsByAreas(areaIds);
    setRaceBoardVenusQuestIds(eventId, venusQuestIdsOfPanels(panels));
    // The reward-panel keys let `validate` reject an override that targets a
    // panel which never grants a reward.
    setRaceBoardRewardPanelKeys(eventId, rewardPanelKeysOfPanels(panels));
    return deriveRaceDraft(eventId, lookups);
  },

  defaultDraft(id: string, title: string): RaceDraft {
    return { ...defaultRaceDraft(id), name: title };
  },

  validate(draft: RaceDraft): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const error = (path: string, message: string) =>
      issues.push({ path, message, severity: 'error' });
    const warn = (path: string, message: string) =>
      issues.push({ path, message, severity: 'warning' });

    if (draft.raceId === '' || !SAFE_ID.test(draft.raceId)) {
      error('raceId', 'must be a non-empty id using A-Z a-z 0-9 . _ -');
    }
    if (draft.name === '') error('name', 'must not be empty');

    // Master item rows: an import leaves the id empty when the row is missing.
    if (draft.racePointItemId === '') {
      error('racePointItemId', `race point item ${racePointItemIdFor(draft.raceId) || '(no race date)'} is missing from master Item`);
    }
    if (draft.raceMedalItemId === '') {
      error('raceMedalItemId', `race medal item ${raceMedalItemIdFor(draft.raceId) || '(no race date)'} is missing from master Item`);
    }
    if (draft.raceLiveBonusResetItemId === '') {
      error(
        'raceLiveBonusResetItemId',
        `live bonus reset item ${raceLiveBonusResetItemIdFor(draft.raceId) || '(no race date)'} is missing from master Item`,
      );
    }

    // Board: without area ids there is nothing to walk, and MovePanel would
    // have no destination.
    if (draft.areaIds.length === 0) {
      error('areaIds', `race ${draft.raceId} has no board rows (no RacePanel row references its panel quests)`);
    }

    if (draft.areaQuestIds.pt === '') error('areaQuestIds.pt', 'race point area quest is missing from master RaceQuest');
    if (draft.areaQuestIds.medal === '') error('areaQuestIds.medal', 'race medal area quest is missing from master RaceQuest');
    if (draft.raceLiveBonusGroupId === '') error('raceLiveBonusGroupId', 'must not be empty');

    if (draft.rankGrades.length === 0) {
      error('rankGrades', 'must define at least one rank grade');
    } else {
      let previous: number | null = null;
      draft.rankGrades.forEach((grade, index) => {
        const path = `rankGrades.${index}.hierarchyPointFrom`;
        if (grade.id === '') error(`rankGrades.${index}.id`, 'must not be empty');
        if (!Number.isInteger(grade.hierarchyPointFrom)) {
          error(path, 'must be a whole number of hierarchy points');
        } else if (grade.hierarchyPointFrom < 0) {
          error(path, 'must not be negative');
        } else if (index === 0 && grade.hierarchyPointFrom !== 0) {
          error(path, 'the first grade must start at 0 hierarchy points');
        } else if (previous !== null && grade.hierarchyPointFrom <= previous) {
          error(path, `must be greater than the previous grade (${previous})`);
        }
        previous = grade.hierarchyPointFrom;
      });
    }

    /** Non-negative whole number, reported under the field's own path. */
    const nonNegativeInteger = (path: string, value: number): void => {
      if (!Number.isInteger(value)) error(path, 'must be a whole number');
      else if (value < 0) error(path, 'must not be negative');
    };

    if (!Number.isInteger(draft.livePanelDifficultyNumber)) {
      error('livePanelDifficultyNumber', 'must be a whole number');
    } else if (draft.livePanelDifficultyNumber <= 0) {
      error('livePanelDifficultyNumber', 'must be a positive difficulty number');
    }

    // One tier per VENUS grade, each addressing a difficulty row the quest ships.
    const gradeDifficulty = gradeDifficultyOf(draft);
    for (const key of GRADE_DIFFICULTY_KEYS) {
      const value = gradeDifficulty[key];
      if (!Number.isInteger(value)) {
        error(`gradeDifficulty.${key}`, 'must be a whole number');
      } else if (value < 1 || value > 7) {
        error(`gradeDifficulty.${key}`, 'must be a difficulty tier between 1 and 7');
      }
    }
    nonNegativeInteger('cardCoolTimeMinutes', draft.cardCoolTimeMinutes);
    nonNegativeInteger(
      'requiredCardCoolTimeRacePointAmount',
      draft.requiredCardCoolTimeRacePointAmount,
    );
    nonNegativeInteger('initialRacePointAmount', draft.initialRacePointAmount);
    nonNegativeInteger('activityLesson.maxHours', draft.activityLesson.maxHours);
    nonNegativeInteger('areaQuestReward.racePointPerTier', draft.areaQuestReward.racePointPerTier);
    nonNegativeInteger('areaQuestReward.raceMedalPerTier', draft.areaQuestReward.raceMedalPerTier);

    if (!Number.isInteger(draft.rivals)) {
      error('rivals', 'must be a whole number');
    } else if (draft.rivals < 1 || draft.rivals > 10) {
      error('rivals', 'must be between 1 and 10 opponents');
    }
    // The activity lesson accepts fractional per-tier rates (the default is
    // 1.5), so only the sign is checked.
    if (draft.activityLesson.racePointPerStepBase < 0) {
      error('activityLesson.racePointPerStepBase', 'must not be negative');
    }
    if (draft.activityLesson.racePointPerStepPerTier < 0) {
      error('activityLesson.racePointPerStepPerTier', 'must not be negative');
    }
    if (draft.activityLesson.raceMedalPerStepBase < 0) {
      error('activityLesson.raceMedalPerStepBase', 'must not be negative');
    }
    if (draft.activityLesson.raceMedalPerStepPerTier < 0) {
      error('activityLesson.raceMedalPerStepPerTier', 'must not be negative');
    }

    // Placeholders that keep the draft importable but need authoring.
    if (draft.eventMissionId === '') {
      warn('eventMissionId', `no master EventMission ${raceEventAssetId(draft.raceId)}; the race ships without a mission panel`);
    }
    if (draft.eventStoryId === '') {
      warn('eventStoryId', `no master EventStory with AssetId ${raceEventAssetId(draft.raceId)}; the race ships without a story`);
    }
    if (draft.name === draft.raceId) {
      warn('name', `no Emblem with AssetId ${draft.raceId}; the name falls back to the race id`);
    }
    if (draft.initialRacePointAmount <= 0) {
      warn('initialRacePointAmount', 'a new player starts with no race points and must wait for the activity lesson');
    }

    // The versus (ClearScore 0) quests always need an opponent. Race master has
    // no opponent column, so the roster is authored on the draft and must name
    // a roster the server can resolve (DB row or checked-in constant).
    if (draft.npcRosterId === '') {
      error('npcRosterId', 'must name the NPC roster used by the race versus quests');
    } else if (rosterById(draft.npcRosterId) === undefined) {
      error('npcRosterId', `names unknown roster "${draft.npcRosterId}"`);
    }
    for (const [questId, rosterId] of Object.entries(draft.npcRosterByQuest)) {
      if (rosterById(rosterId) === undefined) {
        error(`npcRosterByQuest.${questId}`, `names unknown roster "${rosterId}"`);
      }
      // An override only applies to a VENUS panel (type 3). Once the board has
      // been loaded (import or Board tab) the quest set is exact; otherwise
      // only keys that can never be a VENUS panel quest are flagged.
      const boardVenusQuests = raceBoardVenusQuestIds(draft.raceId);
      const questPrefix = raceQuestIdPrefix(draft.raceId);
      const notVenusPanelQuest =
        boardVenusQuests !== undefined
          ? !boardVenusQuests.has(questId)
          : questId === draft.areaQuestIds.pt ||
            questId === draft.areaQuestIds.medal ||
            (questPrefix !== '' && !questId.startsWith(questPrefix));
      if (notVenusPanelQuest) {
        warn(
          `npcRosterByQuest.${questId}`,
          `"${questId}" is not a VENUS (type 3) panel quest of race ${draft.raceId}'s board; the override is never used`,
        );
      }
    }

    // Board reward overrides: a key must address a reward (type 2) panel of one
    // of the race's areas, and every reward must be a reference the grant path
    // can apply. Marathon's authored rewards are only required to be non-empty,
    // so the same bar applies here.
    const rewardPanelKeys = raceBoardRewardPanelKeys(draft.raceId);
    for (const [key, refs] of Object.entries(draft.panelRewards ?? {})) {
      const path = `panelRewards.${key}`;
      const match = PANEL_REWARD_KEY.exec(key);
      if (match === null) {
        error(path, 'must be "<areaId>:<panelNumber>" with a positive panel number');
      } else {
        const areaId = match[1] as string;
        const panelNumber = Number(match[2]);
        if (!draft.areaIds.includes(areaId)) {
          error(path, `area "${areaId}" is not one of race ${draft.raceId}'s board areas`);
        } else if (rewardPanelKeys !== undefined && !rewardPanelKeys.has(key)) {
          error(path, `panel ${panelNumber} of area "${areaId}" is not a reward (type 2) panel`);
        }
      }
      refs.forEach((ref, index) => {
        if (ref.trim() === '') {
          error(`${path}.${index}`, 'must be a reward id or an inline rd_auto reference');
        }
      });
    }

    issues.push(...validateSchedule(draft.schedule));

    // Synthetic bots: they only feed the ranking / rival list, but a bad block
    // would still generate nonsense names and paces.
    const bots = draft.bots;
    if (bots !== undefined) {
      if (!Number.isInteger(bots.count) || bots.count < 0 || bots.count > RACE_BOT_MAX_COUNT) {
        error('bots.count', `must be a whole number of bots between 0 and ${RACE_BOT_MAX_COUNT}`);
      }
      if (!Number.isFinite(bots.minPanelsPerDay) || bots.minPanelsPerDay < 0) {
        error('bots.minPanelsPerDay', 'must not be negative');
      }
      if (!Number.isFinite(bots.maxPanelsPerDay) || bots.maxPanelsPerDay < 0) {
        error('bots.maxPanelsPerDay', 'must not be negative');
      } else if (bots.maxPanelsPerDay < bots.minPanelsPerDay) {
        error(
          'bots.maxPanelsPerDay',
          `must be at least the slowest pace (${bots.minPanelsPerDay} panels/day)`,
        );
      }
      if (bots.names.length > RACE_BOT_MAX_NAMES) {
        error('bots.names', `must list at most ${RACE_BOT_MAX_NAMES} names`);
      }
      bots.names.forEach((name, index) => {
        const trimmed = name.trim();
        if (trimmed === '') {
          error(`bots.names.${index}`, 'must not be empty');
        } else if (trimmed.length > RACE_BOT_MAX_NAME_LENGTH) {
          error(
            `bots.names.${index}`,
            `must be at most ${RACE_BOT_MAX_NAME_LENGTH} characters`,
          );
        }
      });
    }

    return issues;
  },

  compile(draft: RaceDraft): RaceConfig {
    const errors = this.validate(draft).filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      throw new Error(
        `race draft ${draft.raceId || '(no id)'}: ${errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      );
    }
    return draft;
  },

  stateImpact(published: RaceDraft | undefined, draft: RaceDraft): StateImpact[] {
    // First publish has no existing player state to disturb.
    if (published === undefined) return [];

    const impacts: StateImpact[] = [];
    const block = (code: string, message: string): void => {
      impacts.push({ code, severity: 'block', message, requiresPlayerCheck: true });
    };
    const warn = (code: string, message: string): void => {
      impacts.push({ code, severity: 'warn', message, requiresPlayerCheck: false });
    };

    // Board shape and rank thresholds determine where a player currently is,
    // so changing them can strand or regrade an existing player.
    if (!sameStrings(published.areaIds, draft.areaIds)) {
      block(
        'area-board-changed',
        `the board changed (${published.areaIds.length} → ${draft.areaIds.length} areas); players may be standing on a removed or renumbered area`,
      );
    }
    if (
      published.areaQuestIds.pt !== draft.areaQuestIds.pt ||
      published.areaQuestIds.medal !== draft.areaQuestIds.medal
    ) {
      block(
        'area-quest-changed',
        'the area quests changed; players keep progress on quests that may no longer exist',
      );
    }
    if (published.livePanelDifficultyNumber !== draft.livePanelDifficultyNumber) {
      block(
        'live-panel-difficulty-changed',
        `live panel difficulty changed (${published.livePanelDifficultyNumber} → ${draft.livePanelDifficultyNumber}); live scores are not comparable across difficulties`,
      );
    }
    if (!sameGradeDifficulty(gradeDifficultyOf(published), gradeDifficultyOf(draft))) {
      warn(
        'grade-difficulty-changed',
        'grade difficulty mapping changed; players who already opened the race keep their frozen difficulty and only new players use the new mapping',
      );
    }
    if (published.raceLiveBonusGroupId !== draft.raceLiveBonusGroupId) {
      block(
        'live-bonus-group-changed',
        `live bonus group changed (${published.raceLiveBonusGroupId} → ${draft.raceLiveBonusGroupId}); players may lose live bonuses they already collected`,
      );
    }

    const thresholdsBefore = published.rankGrades.map((grade) => grade.hierarchyPointFrom);
    const thresholdsAfter = draft.rankGrades.map((grade) => grade.hierarchyPointFrom);
    if (!sameNumbers(thresholdsBefore, thresholdsAfter)) {
      block(
        'rank-grades-changed',
        'rank grade thresholds changed; existing players can move to a different grade',
      );
    } else if (
      published.rankGrades.some(
        (grade, index) =>
          grade.id !== draft.rankGrades[index].id ||
          grade.name !== draft.rankGrades[index].name ||
          grade.topColorCode !== draft.rankGrades[index].topColorCode ||
          grade.bottomColorCode !== draft.rankGrades[index].bottomColorCode,
      )
    ) {
      warn(
        'rank-grade-labels-changed',
        'rank grade names or colours changed; players keep their grade thresholds',
      );
    }

    // Tuning only affects new gains: existing progress is stored per player, so
    // changing it never needs a player-by-player review.
    const tuning: string[] = [];
    if (published.cardCoolTimeMinutes !== draft.cardCoolTimeMinutes) tuning.push('card cool time');
    if (published.requiredCardCoolTimeRacePointAmount !== draft.requiredCardCoolTimeRacePointAmount) {
      tuning.push('card cool time reset cost');
    }
    if (published.initialRacePointAmount !== draft.initialRacePointAmount) {
      tuning.push('starting race points');
    }
    if (
      published.rivals !== draft.rivals ||
      published.npcRosterId !== draft.npcRosterId ||
      !sameRosterMap(published.npcRosterByQuest, draft.npcRosterByQuest)
    ) {
      tuning.push('opponents');
    }
    if (!sameLesson(published.activityLesson, draft.activityLesson)) tuning.push('activity lesson rates');
    if (!sameReward(published.areaQuestReward, draft.areaQuestReward)) {
      tuning.push('area quest rewards');
    }
    if (!samePanelRewards(published.panelRewards, draft.panelRewards)) {
      tuning.push('board panel rewards');
    }
    if (tuning.length > 0) {
      warn(
        'race-tuning-changed',
        `${tuning.join(', ')} changed; existing players keep their progress and are not reset`,
      );
    }

    return impacts;
  },
};

registerEventPlugin(racePlugin);
