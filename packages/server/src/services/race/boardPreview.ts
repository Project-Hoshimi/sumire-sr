// Read-only preview of a race board for the admin Board tab. The board itself
// is master data (`master_RacePanel` + `master_RacePanelReward`), so this module
// turns those rows into the ordered, per-area list the editor renders. Reward
// contents are resolved by the lookup route (it already owns reward expansion
// and name tables) and attached to each panel afterwards.
//
// The builder is pure. `setRaceBoardVenusQuestIds` keeps a small synchronous
// snapshot of the VENUS (type 3) panel quests of a race so the synchronous
// plugin `validate` can warn about roster overrides that target a panel type
// that never uses a roster. The snapshot is filled by the board lookup and by
// `importFromMaster`.

/** `master_RacePanel.Type`: 1 empty, 2 reward, 3 VENUS, 4 story. */
export const RACE_PANEL_TYPE_EMPTY = 1;
export const RACE_PANEL_TYPE_REWARD = 2;
export const RACE_PANEL_TYPE_VENUS = 3;
export const RACE_PANEL_TYPE_STORY = 4;

const PANEL_TYPE_LABELS: Record<number, string> = {
  [RACE_PANEL_TYPE_EMPTY]: 'Empty',
  [RACE_PANEL_TYPE_REWARD]: 'Reward',
  [RACE_PANEL_TYPE_VENUS]: 'VENUS',
  [RACE_PANEL_TYPE_STORY]: 'Story',
};

/** Human-readable label for a panel type; unknown types keep their number. */
export function racePanelTypeLabel(type: number): string {
  return PANEL_TYPE_LABELS[type] ?? `Type ${type}`;
}

/** `master_RacePanel` row (or the subset the preview reads). */
export interface RaceBoardPanelSource {
  RaceAreaId: string;
  Number: number | null;
  Type: number | null;
  RaceQuestId: string | null;
  EventStoryEpisode: number | null;
  RequiredRacePointAmount: number | null;
  RacePanelRewardId: string | null;
}

/** `master_RacePanelReward` row; `Id` is reused across races, so match `RaceId`. */
export interface RaceBoardPanelRewardSource {
  Id: string;
  RaceId: string | null;
  RewardId: string | null;
}

/** `master_RaceQuest` row (only the name is needed for the preview). */
export interface RaceBoardQuestSource {
  Id: string;
  Name: string | null;
}

/** `master_RaceQuestDifficulty` row of one VENUS quest tier. */
export interface RaceBoardDifficultySource {
  RaceQuestId: string;
  DifficultyNumber: number | null;
  DifficultyLevel: number | null;
  ClearScore: number | null;
}

/** One grant of a resolved reward, named like the admin lookup rewards. */
export interface RaceBoardRewardResource {
  resourceType: number;
  typeLabel: string;
  resourceId: string;
  amount: number;
  name: string | null;
  nameEn: string | null;
}

/** A resolved `RacePanelReward.RewardId` (inline `rd_auto;...` or master row). */
export interface RaceBoardReward {
  id: string;
  found: boolean;
  resources: RaceBoardRewardResource[];
}

/** VENUS panel details: the quest and its configured difficulty tier. */
export interface RaceBoardVenus {
  questId: string;
  questName: string | null;
  difficultyNumber: number;
  difficultyLevel: number | null;
  clearScore: number | null;
  /** False when the race quest has no row for `difficultyNumber`. */
  difficultyFound: boolean;
}

/** One board panel, in `Number` order. */
export interface RaceBoardPanel {
  number: number;
  type: number;
  typeLabel: string;
  requiredRacePointAmount: number;
  /** Raw `RacePanelReward.RewardId` of a type 2 panel. */
  rewardId: string | null;
  /** Resolved reward contents; filled by the lookup route. */
  reward: RaceBoardReward | null;
  /** `EventStoryEpisode` of a type 4 panel. */
  storyEpisode: number | null;
  /** Event story id of a type 4 panel (from the draft's event story). */
  storyId: string | null;
  venus: RaceBoardVenus | null;
}

/** One area of the board with its panels and point total. */
export interface RaceBoardArea {
  /** Position in the draft's `areaIds` (0-based). */
  index: number;
  areaId: string;
  panelCount: number;
  totalRacePointCost: number;
  panels: RaceBoardPanel[];
}

export interface RaceBoardPreview {
  raceId: string;
  eventStoryId: string | null;
  areas: RaceBoardArea[];
}

/** Raw rows the preview is built from (DB loader output). */
export interface RaceBoardSource {
  raceId: string;
  /** Display order; areas without panels still appear (empty panel list). */
  areaIds: readonly string[];
  panels: readonly RaceBoardPanelSource[];
  quests?: readonly RaceBoardQuestSource[];
  difficulties?: readonly RaceBoardDifficultySource[];
  panelRewards?: readonly RaceBoardPanelRewardSource[];
  eventStoryId?: string | null;
  /** Difficulty tier shown for VENUS panels (draft's live panel difficulty). */
  difficultyNumber?: number;
}

function panelType(panel: RaceBoardPanelSource): number {
  return panel.Type == null ? RACE_PANEL_TYPE_EMPTY : Number(panel.Type);
}

function panelCost(panel: RaceBoardPanelSource): number {
  const cost = Number(panel.RequiredRacePointAmount ?? 0);
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/**
 * Build the ordered area/panel preview. Areas follow `areaIds`; panels follow
 * `Number`. Reward ids are matched to their race's `RacePanelReward` row, VENUS
 * panels to their quest name and the requested difficulty tier.
 */
export function buildRaceBoardPreview(source: RaceBoardSource): RaceBoardPreview {
  const questById = new Map((source.quests ?? []).map((row) => [row.Id, row]));
  const difficultyByKey = new Map(
    (source.difficulties ?? []).map((row) => [
      `${row.RaceQuestId}|${Number(row.DifficultyNumber ?? 0)}`,
      row,
    ]),
  );
  // `master_RacePanelReward` is keyed by (Id, RaceId), so prefer this race's row.
  const rewardIdByKey = new Map<string, string>();
  for (const row of source.panelRewards ?? []) {
    if (row.RewardId == null || row.RewardId === '') continue;
    const existing = rewardIdByKey.get(row.Id);
    if (existing === undefined || row.RaceId === source.raceId) {
      rewardIdByKey.set(row.Id, row.RewardId);
    }
  }

  const panelsByArea = new Map<string, RaceBoardPanelSource[]>();
  for (const panel of source.panels) {
    const areaId = String(panel.RaceAreaId ?? '');
    if (areaId === '') continue;
    const list = panelsByArea.get(areaId) ?? [];
    list.push(panel);
    panelsByArea.set(areaId, list);
  }

  const difficultyNumber = source.difficultyNumber ?? 1;
  const eventStoryId = source.eventStoryId ?? null;

  const areas: RaceBoardArea[] = [];
  source.areaIds.forEach((areaId, index) => {
    const rows = [...(panelsByArea.get(areaId) ?? [])].sort(
      (left, right) => Number(left.Number ?? 0) - Number(right.Number ?? 0),
    );
    const panels: RaceBoardPanel[] = rows.map((row) => {
      const type = panelType(row);
      const rewardKey = row.RacePanelRewardId == null ? '' : String(row.RacePanelRewardId);
      const rewardId = rewardKey === '' ? null : (rewardIdByKey.get(rewardKey) ?? null);
      const questId =
        type === RACE_PANEL_TYPE_VENUS && row.RaceQuestId != null ? String(row.RaceQuestId) : '';
      const quest = questId === '' ? undefined : questById.get(questId);
      const difficulty =
        questId === ''
          ? undefined
          : difficultyByKey.get(`${questId}|${Number(difficultyNumber)}`);
      return {
        number: Number(row.Number ?? 0),
        type,
        typeLabel: racePanelTypeLabel(type),
        requiredRacePointAmount: panelCost(row),
        rewardId,
        reward: null,
        storyEpisode:
          type === RACE_PANEL_TYPE_STORY && row.EventStoryEpisode != null
            ? Number(row.EventStoryEpisode)
            : null,
        storyId: type === RACE_PANEL_TYPE_STORY ? eventStoryId : null,
        venus:
          questId === ''
            ? null
            : {
                questId,
                questName: quest?.Name ?? null,
                difficultyNumber,
                difficultyLevel:
                  difficulty?.DifficultyLevel == null ? null : Number(difficulty.DifficultyLevel),
                clearScore: difficulty?.ClearScore == null ? null : Number(difficulty.ClearScore),
                difficultyFound: difficulty !== undefined,
              },
      };
    });
    areas.push({
      index,
      areaId,
      panelCount: panels.length,
      totalRacePointCost: panels.reduce((sum, panel) => sum + panel.requiredRacePointAmount, 0),
      panels,
    });
  });

  return { raceId: source.raceId, eventStoryId, areas };
}

/** VENUS quest ids of a preview, in area/panel order. */
export function venusQuestIdsOf(preview: RaceBoardPreview): string[] {
  const ids: string[] = [];
  for (const area of preview.areas) {
    for (const panel of area.panels) {
      if (panel.venus !== null && !ids.includes(panel.venus.questId)) {
        ids.push(panel.venus.questId);
      }
    }
  }
  return ids;
}

/** VENUS quest ids among raw board rows (used when only panels are loaded). */
export function venusQuestIdsOfPanels(
  panels: readonly RaceBoardPanelSource[],
): string[] {
  const ids: string[] = [];
  for (const panel of panels) {
    if (panelType(panel) !== RACE_PANEL_TYPE_VENUS || panel.RaceQuestId == null) continue;
    const questId = String(panel.RaceQuestId);
    if (questId !== '' && !ids.includes(questId)) ids.push(questId);
  }
  return ids;
}

/**
 * Reward (type 2) panel keys (`<areaId>:<panelNumber>`) among raw board rows,
 * the key space of the draft's `panelRewards` overrides.
 */
export function rewardPanelKeysOfPanels(
  panels: readonly RaceBoardPanelSource[],
): string[] {
  const keys: string[] = [];
  for (const panel of panels) {
    if (panelType(panel) !== RACE_PANEL_TYPE_REWARD) continue;
    const areaId = String(panel.RaceAreaId ?? '');
    const number = Number(panel.Number ?? 0);
    if (areaId === '' || !Number.isInteger(number) || number < 1) continue;
    const key = `${areaId}:${number}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Last known VENUS panel quests per race id. `validate` is synchronous and the
 * draft carries no board, so this snapshot lets it warn about roster overrides
 * that target a quest that never rolls a versus match.
 */
const venusQuestIdsByRace = new Map<string, ReadonlySet<string>>();

/** Replace the snapshot for one race (board lookup / import path). */
export function setRaceBoardVenusQuestIds(
  raceId: string,
  questIds: Iterable<string>,
): void {
  if (raceId === '') return;
  venusQuestIdsByRace.set(raceId, new Set(questIds));
}

/** Snapshot for one race, or undefined when the board was never loaded. */
export function raceBoardVenusQuestIds(raceId: string): ReadonlySet<string> | undefined {
  return venusQuestIdsByRace.get(raceId);
}

/**
 * Last known reward (type 2) panel keys per race id, same contract as the
 * VENUS snapshot: it lets `validate` reject a `panelRewards` override that
 * targets a panel which never grants a reward.
 */
const rewardPanelKeysByRace = new Map<string, ReadonlySet<string>>();

/** Replace the reward-panel snapshot for one race (board lookup / import). */
export function setRaceBoardRewardPanelKeys(
  raceId: string,
  keys: Iterable<string>,
): void {
  if (raceId === '') return;
  rewardPanelKeysByRace.set(raceId, new Set(keys));
}

/** Reward-panel snapshot for one race, or undefined when never loaded. */
export function raceBoardRewardPanelKeys(raceId: string): ReadonlySet<string> | undefined {
  return rewardPanelKeysByRace.get(raceId);
}

/** Drop every snapshot (tests). */
export function resetRaceBoardVenusQuestIdsForTests(): void {
  venusQuestIdsByRace.clear();
  rewardPanelKeysByRace.clear();
}
