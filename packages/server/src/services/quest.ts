import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import type { RpcContext } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import {
  getArea,
  getMusic,
  getQuest,
  getSetting,
  listAreas,
  listAreaGroups,
  listCardLevels,
  listCardsByIds,
  listCharacters,
  listItemsByType,
  getFunctionLock,
  getCard,
  getCardRarity,
  getCardRank,
  getManagerLevel,
  listQuests,
} from '../master/index.ts';
import { addManagerExp, resolveRewardRefs, ResourceTypeValue, type Grant } from '../master/reward.ts';
import { MAX_INT32, RES_ITEM } from './activity.ts';
import { applyCardStats } from './card.ts';
import { applyCardRelease, cardReleaseForCard } from './cardRelease.ts';
import { unlockCardStories } from './cardStories.ts';
import { ConditionEvaluator } from './conditions.ts';
import { HIERARCHY_PRIVATE_SERVER_RANK, reconcileHierarchyNotification } from './hierarchy.ts';
import { NPCRoster } from '../live/preparation.ts';
import { advanceUserMissions, MissionType, reachUserMissions } from './missionProgress.ts';
import { getItemAmount, spendItem } from './inventory.ts';
import {
  grantLiveMastery,
  grantLiveResource,
  liveClearRankPatterns,
  liveDeckCharacterAssets,
  liveResultCharacterIds,
  loadLiveFormation,
  prepareExtraLiveAppearances,
  prepareLiveInput,
} from './liveInput.ts';
import { listElements, getSingleton, putElements, putSingleton } from './playerState.ts';
import { unlockLiveMusic } from './liveMusic.ts';
import { commonResponse, reconcileLessonState } from './activity.ts';
import { PCG, Rand } from '../live/pcg.ts';
import { simulate } from '../live/engine.ts';
import type { Input } from '../live/input.ts';
import type { LiveResult } from '../live/types.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Quest — server-authoritative port of Solis
 * `internal/server/rpc/servers/quest/{common.go,top.go,list_main.go,
 * list_asset.go,list_latest_clear.go,get_latest_clear_live_result.go}`.
 *
 * Storage mapping (Solis `internal/viber/quest_state.go`):
 * - `Areas`  -> Transaction.UserArea per area (ClearQuestCount / DailyClearCount /
 *              LastClearedTime), with daily counters reconciled per JST day.
 * - `Quests` -> Transaction.UserQuest per quest (DailyClearCount / LastClearedTime /
 *              HighestScore / HighestScoreTime / HighestRank / HighestScoreRank).
 * - Latest clear live result -> one playerState field per quest
 *              (`QuestLatestClearLiveResult:<questId>` holding the full
 *              GetLatestClearLiveResultResponse), no new table.
 *
 * Main quests are sequential: an area unlocks once every earlier main area has
 * every quest cleared (Solis `loadQuestCatalog`). Contest/tower rankings,
 * StartBulkDaily, ListDaily, ListContest, ListTower*, TowerTop and the score
 * replay endpoints remain unported.
 */

const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const QUEST_START_RESPONSE_MSG = 'Solis.Common.Proto.Api.QuestStartResponse';
const QUEST_TOP_RESPONSE_MSG = 'Solis.Common.Proto.Api.QuestTopResponse';
const QUEST_LIST_MAIN_RESPONSE_MSG = 'Solis.Common.Proto.Api.QuestListMainResponse';
const QUEST_LIST_ASSET_RESPONSE_MSG = 'Solis.Common.Proto.Api.QuestListAssetResponse';
const QUEST_LIST_LATEST_CLEAR_RESPONSE_MSG = 'Solis.Common.Proto.Api.QuestListLatestClearResponse';
const QUEST_GET_LATEST_CLEAR_LIVE_RESULT_RESPONSE_MSG =
  'Solis.Common.Proto.Api.QuestGetLatestClearLiveResultResponse';
const QUEST_CLEAR_INFO_MSG = 'Solis.Common.Proto.Api.QuestClearInfo';
const QUEST_REWARD_MSG = 'Solis.Common.Proto.Api.QuestReward';
const QUEST_REWARD_CARD_MSG = 'Solis.Common.Proto.Api.QuestRewardCard';
const QUEST_RANK_PATTERN_MSG = 'Solis.Common.Proto.Api.QuestRankPattern';
const QUEST_AREA_GROUP_INFO_MSG = 'Solis.Common.Proto.Api.QuestAreaGroupInfo';
const QUEST_AREA_INFO_MSG = 'Solis.Common.Proto.Api.QuestAreaInfo';
const QUEST_INFO_MSG = 'Solis.Common.Proto.Api.QuestInfo';
const QUEST_TOP_PVP_INFO_MSG = 'Solis.Common.Proto.Api.QuestTopPvpInfo';
const QUEST_TOWER_AREA_INFO_MSG = 'Solis.Common.Proto.Api.QuestTowerAreaInfo';
const QUEST_AREA_MSG = 'Solis.Common.Proto.Transaction.UserArea';
const USER_QUEST_MSG = 'Solis.Common.Proto.Transaction.UserQuest';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';
const USER_CARD_MSG = 'Solis.Common.Proto.Transaction.UserCard';
const USER_CHARACTER_MSG = 'Solis.Common.Proto.Transaction.UserCharacter';

const AREA_MAIN = 1;
const AREA_CONTEST = 2;
const AREA_DAILY = 3;
const AREA_TOWER = 4;
const AREA_SUB_TOWER = 5;
const AREA_TUTORIAL = 101;
const AREA_EXERCISE = 102;

const RANK_D = 1;
const RANK_C = 2;
const RANK_B = 3;
const RANK_A = 4;
const RANK_S = 5;
const RANK_S_PLUS = 6;

const FREE_DAILY_PASS_COUNT = 5;
const TOWER_PAGE_SIZE = 5;
const FUNCTION_LOCK_QUEST_SUB_TOWER = 20;
const QUEST_CONTEST_RANK_GROWTH = 0.003;
const QUEST_OPTIONAL_ITEM_DROP_CHANCE_PERMIL = 200;
const QUEST_FAN_CATCHUP_PERMIL = 50;
const QUEST_FAN_CATCHUP_CAPACITY_FACTOR = 2;
const ITEM_TYPE_QUEST_CONTEST_TICKET = 2004;
const RANK_UNKNOWN = 0;

// PhotoAbilityType values read from live card bonuses.
const PHOTO_ABILITY_MANAGER_EXP = 14;
const PHOTO_ABILITY_GOLD = 15;
const PHOTO_ABILITY_CARD_EXP = 16;

const RES_GOLD = ResourceTypeValue.gold;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

function toArray(value: unknown): Decoded[] {
  return Array.isArray(value) ? (value as Decoded[]) : [];
}

/** JST calendar day key, matching `activity.ts` / Solis `timeutil.Today`. */
function jstDay(now: number): string {
  return new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** True when the stored epoch timestamp falls on the same JST day as `now`. */
function clearedToday(lastClearedTime: unknown, now: number): boolean {
  const at = n(lastClearedTime);
  return at > 0 && jstDay(at) === jstDay(now);
}

function idArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => s(v)) : [];
}

const LATEST_CLEAR_FIELD = 'QuestLatestClearLiveResult:';

function latestClearField(questId: string): string {
  return `${LATEST_CLEAR_FIELD}${questId}`;
}

type Catalog = {
  main: Decoded[];
  daily: Decoded[];
  contest: Decoded | null;
  tower: Decoded | null;
  subTowers: Decoded[];
  contestScore: number;
  hasUnplayedContest: boolean;
  dailyPlayable: boolean;
  towerUnlocked: boolean;
};

type QuestReward = Decoded;

/** Port of Solis `loadQuestCatalog` (quest/common.go). */
export async function loadQuestCatalog(
  playerId: string,
  now: number,
  updated: Decoded,
  exec: Executor = db,
): Promise<Catalog> {
  const [areas, groups, quests, userAreas, userQuests] = await Promise.all([
    listAreas(),
    listAreaGroups(),
    listQuests(),
    listElements(playerId, 'Areas', exec),
    listElements(playerId, 'Quests', exec),
  ]);
  await reconcileQuestDailyCounters(playerId, now, areas as unknown as Decoded[], userAreas, userQuests, updated, exec);
  const byQuest = new Map(quests.map((q) => [s(q.Id), q as unknown as Decoded]));
  const byUserQuest = new Map(userQuests.map((q) => [s(q.QuestId), q]));
  const byUserArea = new Map(userAreas.map((a) => [s(a.AreaId), a]));
  const cleared = (id: string) => n(byUserQuest.get(id)?.LastClearedTime) > 0;
  const areaCleared = (area: Decoded) => {
    const ids = idArray(area.QuestIds);
    if (ids.length === 0) return false;
    if (n(byUserArea.get(s(area.Id))?.ClearQuestCount) >= ids.length) return true;
    return ids.every(cleared);
  };
  const sortedAreas = [...(areas as unknown as Decoded[])].sort((a, b) =>
    n(a.Order) === n(b.Order) ? (s(a.Id) < s(b.Id) ? -1 : s(a.Id) > s(b.Id) ? 1 : 0) : n(a.Order) - n(b.Order),
  );
  const sortedGroups = [...(groups as unknown as Decoded[])].sort((a, b) => n(a.Order) - n(b.Order));
  const evaluator = new ConditionEvaluator(playerId, now, exec);
  const conditionIds: string[] = [];
  for (const area of sortedAreas) {
    if (!catalogAreaSupported(area)) continue;
    conditionIds.push(s(area.ViewConditionId), s(area.UnlockConditionId));
    for (const id of idArray(area.QuestIds)) {
      const q = byQuest.get(id);
      conditionIds.push(s(q?.ViewConditionId), s(q?.UnlockConditionId));
    }
  }
  await evaluator.prime(conditionIds);

  const result: Catalog = {
    main: [],
    daily: [],
    contest: null,
    tower: null,
    subTowers: [],
    contestScore: 0,
    hasUnplayedContest: false,
    dailyPlayable: false,
    towerUnlocked: false,
  };
  const mainInfos = new Map<string, Decoded>();
  const groupOrder = new Map(sortedGroups.map((g) => [s(g.Id), n(g.Order)]));
  let reachedGroup = 0;
  let allPreviousCleared = true;
  for (const area of sortedAreas) {
    if (!catalogAreaSupported(area)) continue;
    if (!(await evaluator.satisfied(s(area.ViewConditionId)))) continue;
    const unlocked = await evaluator.satisfied(s(area.UnlockConditionId));
    const type = n(area.Type);
    const ids = idArray(area.QuestIds);
    const info = { __msg: QUEST_AREA_INFO_MSG, AreaId: s(area.Id), Unlocked: unlocked, Quests: [] as Decoded[] };
    const isTower = type === AREA_TOWER || type === AREA_SUB_TOWER;
    const currentIndex = isTower ? ids.findIndex((id) => !cleared(id)) : -1;
    if (type === AREA_MAIN) {
      if (allPreviousCleared) reachedGroup = Math.max(reachedGroup, groupOrder.get(s(area.AreaGroupId)) ?? 0);
      info.Unlocked = (allPreviousCleared && unlocked) || areaCleared(area);
      allPreviousCleared = allPreviousCleared && areaCleared(area);
    }
    let visibleLimit = ids.length;
    if (isTower && currentIndex >= 0) {
      visibleLimit = Math.min(visibleLimit, (Math.trunc(currentIndex / TOWER_PAGE_SIZE) + 1) * TOWER_PAGE_SIZE);
    }
    for (let i = 0; i < ids.length && i < visibleLimit; i++) {
      const id = ids[i];
      const q = byQuest.get(id);
      if (!q) throw new Error(`area "${s(area.Id)}" references missing quest "${id}"`);
      if (!(await evaluator.satisfied(s(q.ViewConditionId)))) continue;
      const canPlay = await evaluator.satisfied(s(q.UnlockConditionId));
      const row: Decoded = { __msg: QUEST_INFO_MSG, QuestId: id, Cleared: cleared(id), IsPlayable: info.Unlocked && canPlay } as Decoded;
      if (n(q.ClearScore) === 0 && (type === AREA_MAIN || type === AREA_TOWER)) {
        // Known boss rosters are safe to preview; a missing roster must not hide the catalog.
        try {
          row.OpponentInfo = NPCRoster(id) as unknown as Decoded;
        } catch {
          // Start performs its own unsupported-opponent preflight.
        }
      }
      switch (type) {
        case AREA_MAIN:
          row.IsPlayable = row.IsPlayable === true && row.Cleared !== true;
          break;
        case AREA_TOWER:
        case AREA_SUB_TOWER:
          row.IsPlayable = row.IsPlayable === true && i === currentIndex && row.Cleared !== true;
          break;
        case AREA_DAILY:
        case AREA_CONTEST: {
          const stored = byUserQuest.get(id);
          row.HighestScore = n(stored?.HighestScore);
          row.RankType = n(stored?.HighestScoreRank);
          if (n(row.HighestScore) > 0) {
            const rank = questStartScoreRank(questStartRankPatterns(q, type), n(row.HighestScore));
            row.RankType = rank.rankType;
            row.Plus = rank.plus;
          }
          if (type === AREA_CONTEST) row.HighestRank = Math.min(MAX_INT32, Math.max(0, n(stored?.HighestRank)));
          if (type === AREA_DAILY && row.IsPlayable === true) {
            const state = byUserArea.get(s(area.Id));
            const used = clearedToday(state?.LastClearedTime, now) ? Math.max(0, n(state?.DailyClearCount)) : 0;
            row.PlayableCount = Math.max(0, FREE_DAILY_PASS_COUNT - used);
            // Top's notification tracks remaining FREE attempts only.
            result.dailyPlayable = result.dailyPlayable || n(row.PlayableCount) > 0;
          }
          if (type === AREA_CONTEST) {
            result.contestScore += n(row.HighestScore);
            result.hasUnplayedContest = result.hasUnplayedContest || (row.IsPlayable === true && row.Cleared !== true);
          }
          break;
        }
      }
      info.Quests.push(row);
    }
    switch (type) {
      case AREA_MAIN:
        mainInfos.set(s(area.Id), info as Decoded);
        break;
      case AREA_TUTORIAL:
        if (!areaCleared(area)) mainInfos.set(s(area.Id), info as Decoded);
        break;
      case AREA_DAILY:
        result.daily.push(info as Decoded);
        break;
      case AREA_CONTEST:
        result.contest = info as Decoded;
        break;
      case AREA_TOWER:
      case AREA_SUB_TOWER: {
        let currentId = '';
        if (ids.length > 0) currentId = ids[currentIndex < 0 ? ids.length - 1 : currentIndex];
        const tower = { __msg: QUEST_TOWER_AREA_INFO_MSG, Area: info, CurrentTowerQuestId: currentId } as Decoded;
        if (type === AREA_TOWER) result.tower = tower;
        else result.subTowers.push(tower);
        break;
      }
    }
  }
  const tutorialIds = new Set(sortedAreas.filter((a) => n(a.Type) === AREA_TUTORIAL).map((a) => s(a.Id)));
  for (const group of sortedGroups) {
    const entry = { __msg: QUEST_AREA_GROUP_INFO_MSG, AreaGroupId: s(group.Id), Areas: [] as Decoded[] };
    for (const id of idArray(group.AreaIds)) {
      const info = mainInfos.get(id);
      if (!info) continue;
      // Tutorial is a separate non-progression group in the captured menus.
      if (n(group.Order) > reachedGroup && !tutorialIds.has(id)) continue;
      entry.Areas.push(info);
    }
    if (entry.Areas.length > 0) result.main.push(entry as Decoded);
  }
  const lock = await getFunctionLock(FUNCTION_LOCK_QUEST_SUB_TOWER);
  result.towerUnlocked = await evaluator.satisfied(s(lock?.UnlockConditionId));
  // not ported: UserCurrentQuestArea (CurrentMainAreaId/CurrentTowerQuestId) persistence.
  return result;
}

/** Solis `questAreaSupported`: areas the catalog lists (Start additionally rejects contests). */
function catalogAreaSupported(area: Decoded): boolean {
  return n(area.Type) === AREA_CONTEST || isSupportedArea(area);
}

/** Port of Solis `viber.ReconcileQuestDailyCounters`. */
async function reconcileQuestDailyCounters(
  playerId: string,
  now: number,
  masters: Decoded[],
  areas: Decoded[],
  quests: Decoded[],
  updated: Decoded,
  exec: Executor,
): Promise<void> {
  const dailyAreas = new Set<string>();
  const dailyQuests = new Set<string>();
  for (const area of masters) {
    if (n(area.Type) !== AREA_DAILY || s(area.DailySpecialTicketItemId) !== '') continue;
    dailyAreas.add(s(area.Id));
    for (const id of idArray(area.QuestIds)) dailyQuests.add(id);
  }
  const staleAreas = areas.filter(
    (a) => dailyAreas.has(s(a.AreaId)) && n(a.DailyClearCount) !== 0 && !clearedToday(a.LastClearedTime, now),
  );
  const staleQuests = quests.filter(
    (q) => dailyQuests.has(s(q.QuestId)) && n(q.DailyClearCount) !== 0 && !clearedToday(q.LastClearedTime, now),
  );
  for (const row of staleAreas) row.DailyClearCount = 0;
  for (const row of staleQuests) row.DailyClearCount = 0;
  if (staleAreas.length) await putElements(playerId, 'Areas', staleAreas, exec);
  if (staleQuests.length) await putElements(playerId, 'Quests', staleQuests, exec);
  for (const row of staleAreas) pushUpdated(updated, 'Areas', row);
  for (const row of staleQuests) pushUpdated(updated, 'Quests', row);
}

/** Setting rows are generated proto objects; ticket ids are currently null in master. */
async function loadSetting(_exec: Executor): Promise<Decoded | null> {
  const row = await getSetting();
  return (row as unknown as Decoded | null) ?? null;
}

function pushUpdated(updated: Decoded, key: string, row: Decoded): void {
  const rows = Array.isArray(updated[key]) ? (updated[key] as Decoded[]) : [];
  updated[key] = [...rows, row] as Decoded;
}

/** Solis `questAreaSupported` minus contest (ranking seasons are not ported). */
function isSupportedArea(area: Decoded): boolean {
  switch (n(area.Type)) {
    case AREA_MAIN:
    case AREA_TOWER:
    case AREA_SUB_TOWER:
    case AREA_TUTORIAL:
      return true;
    case AREA_DAILY:
      return s(area.DailySpecialTicketItemId) === '';
  }
  return false;
}

/** Solis `questStartCost`: returns the pass item and amount consumed on clear. */
async function questStartCost(
  playerId: string,
  req: Decoded,
  quest: Decoded,
  area: Decoded,
  areaState: Decoded,
  setting: Decoded | null,
  now: number,
  exec: Executor,
): Promise<{ itemId: string; amount: number }> {
  const count = n(req.PlayCount);
  let itemType: number;
  switch (n(area.Type)) {
    case AREA_DAILY:
      if (count > Math.max(1, n(setting?.QuestDailyTicketLimitUseCount))) {
        throw new Error('daily playCount exceeds the master limit');
      }
      if (req.UseDailyTicket !== true) {
        if (count > Math.max(0, FREE_DAILY_PASS_COUNT - n(areaState.DailyClearCount))) {
          throw new Error('insufficient FREE daily plays; select owned passes');
        }
        return { itemId: '', amount: 0 };
      }
      if (n(areaState.DailyClearCount) < FREE_DAILY_PASS_COUNT) {
        throw new Error('use remaining FREE daily plays before selecting owned passes');
      }
      itemType = n(area.DailyTicketItemType);
      break;
    case AREA_CONTEST:
      if (count > Math.max(1, n(setting?.QuestContestTicketLimitUseCount))) {
        throw new Error('contest playCount exceeds the master limit');
      }
      itemType = ITEM_TYPE_QUEST_CONTEST_TICKET;
      break;
    default:
      if (count !== 1) throw new Error('this live permits exactly one play');
      return { itemId: '', amount: 0 };
  }
  if (n(quest.TicketAmount) <= 0) throw new Error('paid live has an invalid master ticket cost');
  const masters = await listItemsByType(itemType);
  if (masters.length !== 1) throw new Error(`live pass type ${itemType} has no unique master item`);
  const itemId = String(masters[0].Id);
  const amount = n(quest.TicketAmount) * count;
  // sumire-sr items carry no expiry, so the whole owned amount is usable.
  void now;
  if ((await getItemAmount(playerId, itemId, exec)) < amount) throw new Error('insufficient unexpired live passes');
  return { itemId, amount };
}

/** Solis `questStartRankPatterns`. */
export function questStartRankPatterns(quest: Decoded, areaType: number): Decoded[] {
  const clear = n(quest.ClearScore);
  if (areaType !== AREA_DAILY && areaType !== AREA_CONTEST) {
    // Main/tower lives show these three thresholds even though their final
    // rankType stays Unknown and they have no score-grade rewards.
    return liveClearRankPatterns(clear) as Decoded[];
  }
  if (clear <= 0) return [];
  const pattern = (rankType: number, threshold: number, plus = 0): Decoded =>
    ({ __msg: QUEST_RANK_PATTERN_MSG, RankType: rankType, Plus: plus, ThresholdScore: threshold }) as Decoded;
  const result: Decoded[] = [];
  let ratio = 1.3;
  const limit = areaType === AREA_CONTEST ? 99 : 20;
  for (let plus = 1; plus <= limit; plus++) {
    let threshold = clear * (plus + 1);
    if (areaType === AREA_CONTEST) {
      ratio += 0.1 + QUEST_CONTEST_RANK_GROWTH * plus + 4 * QUEST_CONTEST_RANK_GROWTH * Math.trunc(plus / 5);
      threshold = Math.round(clear * ratio);
    }
    result.push(pattern(RANK_S_PLUS, Math.min(Number.MAX_SAFE_INTEGER - 1024, threshold), plus));
  }
  for (const [rank, tenths] of [[RANK_S, 13], [RANK_A, 12], [RANK_B, 11], [RANK_C, 10]] as const) {
    result.push(pattern(rank, Math.floor((clear * tenths) / 10)));
  }
  result.push(pattern(RANK_D, areaType === AREA_DAILY ? Math.trunc(clear / 1000) : 0));
  // Go's sort.Slice is not stable; equal thresholds only occur for tiny clear scores.
  return result.sort((a, b) => n(b.ThresholdScore) - n(a.ThresholdScore));
}

/** Solis `questStartScoreRank`: patterns are ordered by descending threshold. */
export function questStartScoreRank(patterns: Decoded[], score: number): { rankType: number; plus: number } {
  for (const p of patterns) {
    if (score >= n(p.ThresholdScore)) return { rankType: n(p.RankType), plus: n(p.Plus) };
  }
  return { rankType: patterns.length > 0 ? RANK_D : RANK_UNKNOWN, plus: 0 };
}

/** Solis `questStartRankReward`. */
function questStartRankReward(quest: Decoded, rank: number): string {
  switch (rank) {
    case RANK_S:
    case RANK_S_PLUS:
      return s(quest.RankSRewardId);
    case RANK_A:
      return s(quest.RankARewardId);
    case RANK_B:
      return s(quest.RankBRewardId);
    case RANK_C:
      return s(quest.RankCRewardId);
    case RANK_D:
      return s(quest.RankDRewardId);
  }
  return '';
}

/** Solis `questBoostedAmount`. */
function questBoostedAmount(amount: number, bonusPermil: number): number {
  if (bonusPermil < 0 || amount < 0) throw new Error('live reward bonus overflows');
  const boosted = Math.floor((amount * (1000 + bonusPermil)) / 1000);
  if (!Number.isSafeInteger(boosted)) throw new Error('live reward bonus overflows');
  return boosted;
}

/** Solis `questRepeatedAmount`. */
function questRepeatedAmount(amount: number, count: number): number {
  if (amount < 0 || count <= 0 || !Number.isSafeInteger(amount * count)) {
    throw new Error('repeated live reward overflows');
  }
  return amount * count;
}

/** Solis `grantQuestReward`: fixed resources, then rolled films and optional items. */
async function grantQuestReward(
  playerId: string,
  rewardId: string,
  count: number,
  goldBonus: number,
  rng: Rand,
  updated: Decoded,
  exec: Executor,
): Promise<Decoded[]> {
  if (rewardId === '' || count <= 0) return [];
  const resources = await resolveRewardRefs([rewardId]);
  const randomFilms: Grant[] = [];
  const randomItems: Grant[] = [];
  for (const r of resources) {
    if (r.amount < 0) throw new Error(`reward "${rewardId}" contains an invalid resource amount`);
    if (r.amount > 0) continue;
    if (r.resourceType !== RES_ITEM || r.resourceId === '') {
      throw new Error(`reward "${rewardId}" contains an unsupported random resource`);
    }
    if (r.resourceId.startsWith('item-photo_shooting-')) randomFilms.push(r);
    else randomItems.push(r);
  }
  const results: Decoded[] = [];
  for (const r of resources) {
    if (r.amount === 0) continue;
    let amount = r.amount;
    if (r.resourceType === RES_GOLD) amount = questBoostedAmount(amount, goldBonus);
    results.push(...(await grantLiveResource(playerId, r.resourceType, r.resourceId, questRepeatedAmount(amount, count), updated, exec)));
  }
  const counts = new Map<string, number>();
  for (let i = 0; i < count && randomFilms.length > 0; i++) {
    const id = randomFilms[rng.intN(randomFilms.length)].resourceId;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (let i = 0; i < count && randomItems.length > 0; i++) {
    if (rng.intN(1000) < QUEST_OPTIONAL_ITEM_DROP_CHANCE_PERMIL) {
      const id = randomItems[rng.intN(randomItems.length)].resourceId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  for (const candidate of resources) {
    if (candidate.amount !== 0) continue;
    const amount = counts.get(candidate.resourceId) ?? 0;
    if (amount <= 0) continue;
    results.push(...(await grantLiveResource(playerId, candidate.resourceType, candidate.resourceId, amount, updated, exec)));
    counts.delete(candidate.resourceId);
  }
  return aggregateRewardResults(results);
}

function aggregateRewardResults(results: Decoded[]): Decoded[] {
  const byKey = new Map<string, Decoded>();
  for (const result of results) {
    const key = `${n(result.ResourceType)}:${s(result.ResourceId)}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...result, AmountI64: n(result.AmountI64) } as Decoded);
      continue;
    }
    current.AmountI64 = n(current.AmountI64) + n(result.AmountI64);
    current.AfterAmount = result.AfterAmount;
  }
  return [...byKey.values()];
}

/** Solis `settleQuestCharacters`: fan catch-up, card exp, music mastery. */
async function settleQuestCharacters(
  playerId: string,
  req: Decoded,
  quest: Decoded,
  setting: Decoded | null,
  input: Input,
  result: LiveResult,
  reward: Decoded,
  updated: Decoded,
  exec: Executor,
): Promise<void> {
  const playCount = n(req.PlayCount);
  const byId = new Map((await listElements(playerId, 'Characters', exec)).map((row) => [s(row.CharacterId), row]));
  const ids = liveResultCharacterIds(input, result);
  const fanGains = new Map<string, number>();
  for (const id of ids) {
    const character = byId.get(id);
    if (!character) throw new Error(`live character "${id}" is not owned`);
    // Inferred catch-up policy (Solis): earn 5% of the gap to twice the venue
    // capacity per clear, minimum one; only light fans increase.
    const target = n(quest.MaxCapacity) * QUEST_FAN_CATCHUP_CAPACITY_FACTOR;
    let total = n(character.LightFanAmount) + n(character.MiddleFanAmount) + n(character.HeavyFanAmount);
    let gained = 0;
    for (let i = 0; i < playCount && total < target; i++) {
      const step = Math.min(target - total, Math.max(1, Math.trunc(((target - total) * QUEST_FAN_CATCHUP_PERMIL) / 1000)));
      gained += step;
      total += step;
    }
    if (gained > MAX_INT32 - n(character.LightFanAmount)) throw new Error('fan amount overflows');
    if (gained > 0) {
      character.LightFanAmount = n(character.LightFanAmount) + gained;
      const candidate = Math.max(
        n(setting?.LiveMinimumGuaranteedAudienceAmount),
        Math.trunc((n(character.LightFanAmount) * n(setting?.LiveLightFanAmountWeightPermil)) / 1000) +
          Math.trunc((n(character.MiddleFanAmount) * n(setting?.LiveMiddleFanAmountWeightPermil)) / 1000) +
          Math.trunc((n(character.HeavyFanAmount) * n(setting?.LiveHeavyFanAmountWeightPermil)) / 1000),
      );
      if (candidate < 0 || candidate > MAX_INT32) throw new Error('live audience candidate amount overflows');
      character.AudienceCandidateAmount = candidate;
      if (!character.__msg) character.__msg = USER_CHARACTER_MSG;
      await putElements(playerId, 'Characters', [character], exec);
    }
    fanGains.set(id, gained);
    pushUpdated(updated, 'Characters', character);
  }
  const cardExp = n(quest.RewardCardExp);
  const levels = cardExp > 0 ? await listCardLevels() : [];
  for (const card of result.UserInfos?.[0]?.UserDeck?.Cards ?? []) {
    const data = input.Cards.get(n(card.Index));
    const gain = fanGains.get(data?.CharacterID ?? '') ?? 0;
    let exp = 0;
    let truncated = false;
    if (cardExp > 0) {
      const amount = questRepeatedAmount(questBoostedAmount(cardExp, n(data?.Bonuses.get(PHOTO_ABILITY_CARD_EXP))), playCount);
      ({ exp, truncated } = await grantQuestCardExp(playerId, s(card.CardId), amount, levels as unknown as Decoded[], updated, exec));
    }
    if (gain > 0 || cardExp > 0) {
      const rows = Array.isArray(reward.RewardCards) ? (reward.RewardCards as Decoded[]) : [];
      reward.RewardCards = [
        ...rows,
        { __msg: QUEST_REWARD_CARD_MSG, CardId: s(card.CardId), FunAmount: gain, Exp: exp, IsExpTruncated: truncated },
      ] as Decoded;
    }
  }
  // not ported: viber.ReconcileCardSupportLevel (support-card level sync).
  await grantLiveMastery(playerId, s(quest.MusicId), ids, playCount, reward, updated, exec);
}

/** Solis `grantQuestCardExp`: exp capped by rarity/rank/manager level limits. */
async function grantQuestCardExp(
  playerId: string,
  cardId: string,
  amount: number,
  levels: Decoded[],
  updated: Decoded,
  exec: Executor,
): Promise<{ exp: number; truncated: boolean }> {
  const card = (await listElements(playerId, 'Cards', exec)).find((row) => s(row.CardId) === cardId);
  if (!card) throw new Error(`card not owned: ${cardId}`);
  // Assistance forbids direct training; keep the preserved base level intact.
  if (card.Supported === true) return { exp: 0, truncated: true };
  const rarity = await getCardRarity(n(card.Rarity));
  const user = await getSingleton(playerId, 'User', exec);
  const manager = await getManagerLevel(n(user?.ManagerLevel) || 1);
  let limit = n(rarity?.LevelLimit);
  if (n(card.Rank) > 0) limit += n((await getCardRank(n(card.Rank)))?.LevelLimitUpAmount);
  limit = Math.min(limit, n(manager?.MaxCardLevel));
  const maxExp = n(levels.find((row) => n(row.Level) === limit)?.RequiredExp);
  if (maxExp <= n(card.TotalExp)) return { exp: 0, truncated: true };
  const gain = Math.min(amount, maxExp - n(card.TotalExp), MAX_INT32);
  card.TotalExp = n(card.TotalExp) + gain;
  const previousLevel = n(card.BaseLevel) || n(card.Level);
  let level = previousLevel;
  for (const row of levels) {
    if (n(row.Level) <= limit && n(row.RequiredExp) <= n(card.TotalExp)) level = Math.max(level, n(row.Level));
  }
  if (level !== previousLevel) {
    const master = await getCard(cardId);
    if (!master) throw new Error(`unknown card ${cardId}`);
    card.Level = level;
    card.BaseLevel = level;
    await applyCardStats(card, master as unknown as Decoded, level);
    applyCardRelease(card, master as unknown as Decoded, await cardReleaseForCard(master as unknown as Decoded, level, n(card.EvolutionLevel)));
    for (const story of await unlockCardStories(playerId, cardId, level, exec)) pushUpdated(updated, 'Stories', story);
    for (const row of await advanceUserMissions(playerId, MissionType.CardLevelUpCount, level - previousLevel, [cardId, s(master.CharacterId)], exec)) {
      pushUpdated(updated, 'Missions', row);
    }
  }
  if (!card.__msg) card.__msg = USER_CARD_MSG;
  await putElements(playerId, 'Cards', [card], exec);
  pushUpdated(updated, 'Cards', card);
  // not ported: viber.ReachCharacterCardTrainingMissions.
  return { exp: gain, truncated: gain < amount };
}

const QUEST_CLEAR_MISSION: Record<number, number> = {
  [AREA_MAIN]: MissionType.QuestMainClearCount,
  [AREA_TUTORIAL]: MissionType.QuestMainClearCount,
  [AREA_DAILY]: MissionType.QuestDailyClearCount,
  [AREA_CONTEST]: MissionType.QuestContestClearCount,
  [AREA_TOWER]: MissionType.QuestTowerClearCount,
  [AREA_SUB_TOWER]: MissionType.QuestSubTowerClearCount,
};

const AREA_CLEAR_ACHIEVEMENT: Record<number, number> = {
  [AREA_MAIN]: MissionType.AreaAllMainQuestClearCountAchievement,
  [AREA_TOWER]: MissionType.AreaAllTowerQuestClearCountAchievement,
  [AREA_SUB_TOWER]: MissionType.AreaSubTowerQuestClearCountAchievement,
};

/** Solis `settleQuestMissions` (contest score missions are not reachable: contest is unsupported). */
async function settleQuestMissions(
  playerId: string,
  req: Decoded,
  quest: Decoded,
  area: Decoded,
  input: Input,
  result: LiveResult,
  updated: Decoded,
  exec: Executor,
): Promise<void> {
  const targets = [s(quest.Id), s(area.Id), s(quest.MusicId), ...liveResultCharacterIds(input, result)];
  const put = (rows: Decoded[]) => rows.forEach((row) => pushUpdated(updated, 'Missions', row));
  for (const type of [MissionType.QuestAllClearCount, QUEST_CLEAR_MISSION[n(area.Type)] ?? 0, MissionType.CharacterQuestAllClearCount]) {
    if (type === 0) continue;
    put(await advanceUserMissions(playerId, type, n(req.PlayCount), targets, exec));
  }
  const score = n(result.UserInfos?.[0]?.UserResult?.Score);
  if (score > 0) put(await reachUserMissions(playerId, MissionType.QuestAllScoreAchievement, score, targets, exec));
  const achievement = AREA_CLEAR_ACHIEVEMENT[n(area.Type)] ?? 0;
  if (achievement === 0) return;
  const clears = new Map((await listElements(playerId, 'Areas', exec)).map((row) => [s(row.AreaId), n(row.ClearQuestCount)]));
  let total = 0;
  for (const master of await listAreas()) {
    if (n(master.Type) !== n(area.Type)) continue;
    if (n(area.Type) === AREA_SUB_TOWER && s(master.Id) !== s(area.Id)) continue;
    total += Math.min(idArray(master.QuestIds).length, Math.max(0, clears.get(s(master.Id)) ?? 0));
  }
  if (total > 0) put(await reachUserMissions(playerId, achievement, total, [s(area.Id)], exec));
}

async function questPlayable(
  playerId: string,
  questId: string,
  now: number,
  updated: Decoded,
  exec: Executor,
): Promise<void> {
  const catalog = await loadQuestCatalog(playerId, now, updated, exec);
  const areaInfo = findAreaInfo(catalog, questId);
  const questInfo = areaInfo ? (toArray(areaInfo.Quests).find((q) => s(q.QuestId) === questId) ?? null) : null;
  if (!areaInfo || !questInfo) throw new Error(`quest not found: ${questId}`);
  if (!areaInfo.Unlocked) {
    throw new Error('quest area is locked');
  }
  if (questInfo.IsPlayable !== true) throw new Error('quest is not playable');
}

function findAreaInfo(catalog: Catalog, questId: string): Decoded | null {
  const all: Decoded[] = [...catalog.main.flatMap((g) => toArray(g.Areas)), ...catalog.daily];
  if (catalog.contest) all.push(catalog.contest);
  if (catalog.tower) all.push(catalog.tower.Area as Decoded);
  all.push(...catalog.subTowers.map((t) => t.Area as Decoded));
  for (const area of all) {
    if (toArray(area.Quests).some((q) => s(q.QuestId) === questId)) return area;
  }
  return null;
}


async function withQuestPlayer<T>(ctx: RpcContext, rpc: string, fn: (playerId: string) => Promise<T>): Promise<T> {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error(`${rpc}: unauthenticated`);
  const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return fn(pl.id);
}

function emptyUpdated(): Decoded {
  return { __msg: UPDATED_DATA_MSG } as Decoded;
}

function emptyCommon(updated: Decoded): Decoded {
  return commonResponse(updated);
}

async function loadLatestClear(
  playerId: string,
  questId: string,
  exec: Executor,
): Promise<Decoded | null> {
  return getSingleton(playerId, latestClearField(questId), exec);
}

async function saveLatestClear(
  playerId: string,
  questId: string,
  response: Decoded,
  exec: Executor,
): Promise<void> {
  await putSingleton(playerId, latestClearField(questId), response, exec);
}

register(
  'Quest:Start',
  async (ctx) => {
    const req = (ctx.request ?? {}) as Decoded;
    return withQuestPlayer(ctx, 'Quest:Start', async (playerId) => {
      const questId = s(req.QuestId);
      const deckNumber = n(req.DeckNumber);
      const playCount = n(req.PlayCount);
      if (questId === '' || deckNumber <= 0 || playCount <= 0) {
        throw new Error('Quest:Start: questId, deckNumber and a positive playCount are required');
      }
      if (idArray(req.UserBuddyDeckPositions).length > 0) {
        throw new Error('Quest:Start: friend rental is unavailable in this private server');
      }
      const seed = randomBytes(8).readBigUInt64BE();
      const now = Date.now();

      const payload = await withPlayerTx(playerId, async (tx) => {
        const updated = emptyUpdated();
        const quest = (await getQuest(questId)) as unknown as Decoded | null;
        if (!quest) throw new Error(`quest not found: ${questId}`);
        const area = (await getArea(s(quest.AreaId))) as unknown as Decoded | null;
        if (!area) throw new Error(`quest area not found: ${questId}`);
        const areaType = n(area.Type);
        if (!isSupportedArea(area)) throw new Error('quest mode or time-limited daily live is unavailable');
        await questPlayable(playerId, questId, now, updated, tx);
        const setting = await loadSetting(tx);

        const areaState =
          (await listElements(playerId, 'Areas', tx)).find((row) => s(row.AreaId) === s(area.Id)) ??
          ({ __msg: QUEST_AREA_MSG, AreaId: s(area.Id) } as Decoded);
        if (!clearedToday(areaState.LastClearedTime, now)) areaState.DailyClearCount = 0;
        const old =
          (await listElements(playerId, 'Quests', tx)).find((row) => s(row.QuestId) === questId) ??
          ({ __msg: USER_QUEST_MSG, QuestId: questId } as Decoded);
        // Placement ranks only apply to contests, which are not supported here;
        // clear any placement values on other quest rows (Solis repairs them too).
        old.HighestRank = 0;
        old.CurrentRankingHighestRank = 0;
        old.CurrentRankingHighestScore = 0;
        old.CurrentRankingHighestScoreTime = 0;
        old.CurrentRankingSeasonID = '';
        if (!clearedToday(old.LastClearedTime, now)) old.DailyClearCount = 0;
        const pass = await questStartCost(playerId, req, quest, area, areaState, setting, now, tx);

        const formation = await loadLiveFormation(playerId, deckNumber, tx);
        const input = await prepareLiveInput(playerId, req, quest as Parameters<typeof prepareLiveInput>[2], seed, formation, tx);
        const result = simulate(input) as LiveResult;
        const playerResult = result.UserInfos?.[0]?.UserResult;
        if (!playerResult) throw new Error('live produced no player result');
        const score = n(playerResult.Score);
        if (score < 0) throw new Error('live score is negative');
        const patterns = questStartRankPatterns(quest, areaType);
        let { rankType, plus } = questStartScoreRank(patterns, score);
        if (areaType !== AREA_DAILY && areaType !== AREA_CONTEST) {
          rankType = RANK_UNKNOWN;
          plus = 0;
        }
        const reward = { __msg: QUEST_REWARD_MSG } as Decoded;
        const wasCleared = n(old.LastClearedTime) > 0;
        const isBest = result.Cleared === true && score > n(old.HighestScore);

        if (result.Cleared === true) {
          let managerBonus = 0;
          let goldBonus = 0;
          for (const card of result.UserInfos?.[0]?.UserDeck?.Cards ?? []) {
            const bonuses = input.Cards.get(n(card.Index))?.Bonuses;
            managerBonus += n(bonuses?.get(PHOTO_ABILITY_MANAGER_EXP));
            goldBonus += n(bonuses?.get(PHOTO_ABILITY_GOLD));
          }
          if (pass.amount > 0) {
            await spendItem(playerId, pass.itemId, pass.amount, tx);
            pushUpdated(updated, 'Items', {
              __msg: USER_ITEM_MSG,
              ItemId: pass.itemId,
              Amount: await getItemAmount(playerId, pass.itemId, tx),
            } as Decoded);
          }
          const rng = new Rand(new PCG(seed ^ 0x7175657374727764n, seed));
          reward.ClearRewards = await grantQuestReward(playerId, s(quest.ClearRewardId), playCount, goldBonus, rng, updated, tx);
          reward.ScoreRankRewards = await grantQuestReward(
            playerId, questStartRankReward(quest, rankType), playCount, goldBonus, rng, updated, tx,
          );
          if (plus > 0) {
            reward.ScoreRankAdditionalRewards = await grantQuestReward(
              playerId, s(quest.RankAdditionalRewardId), playCount * plus, goldBonus, rng, updated, tx,
            );
          }
          if (n(quest.RewardManagerExp) > 0) {
            const amount = questRepeatedAmount(questBoostedAmount(n(quest.RewardManagerExp), managerBonus), playCount);
            const granted = await addManagerExp(playerId, amount, tx);
            if (granted.user) updated.User = granted.user;
            for (const photo of granted.photos) pushUpdated(updated, 'Photos', photo);
          }
          if (n(areaState.DailyClearCount) > MAX_INT32 - playCount || n(old.DailyClearCount) > MAX_INT32 - playCount) {
            throw new Error('quest clear counter overflows');
          }
          areaState.DailyClearCount = n(areaState.DailyClearCount) + playCount;
          old.DailyClearCount = n(old.DailyClearCount) + playCount;
          areaState.LastClearedTime = now;
          old.LastClearedTime = now;
          if (!wasCleared) areaState.ClearQuestCount = n(areaState.ClearQuestCount) + 1;
          if (isBest) {
            old.HighestScore = score;
            old.HighestScoreTime = now;
            old.HighestScoreRank = rankType;
          }
          await putElements(playerId, 'Areas', [areaState], tx);
          pushUpdated(updated, 'Areas', areaState);
          await putElements(playerId, 'Quests', [old], tx);
          await settleQuestCharacters(playerId, req, quest, setting, input, result, reward, updated, tx);
          await settleQuestMissions(playerId, req, quest, area, input, result, updated, tx);
          if (areaType === AREA_MAIN && !wasCleared && n(areaState.ClearQuestCount) === idArray(area.QuestIds).length) {
            const user = await getSingleton(playerId, 'User', tx);
            if (user) {
              user.QuestMainAreaLastClearCharacterIds = liveResultCharacterIds(input, result);
              await putSingleton(playerId, 'User', user, tx);
              updated.User = user;
            }
          }
          if (areaType === AREA_MAIN || areaType === AREA_TOWER || areaType === AREA_SUB_TOWER) {
            await loadQuestCatalog(playerId, now, updated, tx);
          }
          if (areaType === AREA_MAIN && !wasCleared) {
            // A first main clear can move the home lesson to the next area: settle the
            // pending lesson reward at the old rate up to now. UpdatedData has no lesson
            // field, so the client sees the new rate on its next Home:Enter.
            await reconcileLessonState(playerId, now, tx);
          }
          await unlockLiveMusic(playerId, s(quest.MusicId), updated, tx);
          // not ported: viber.ReconcileUserMissions (condition missions) and salary.RefreshSnapshot.
        } else {
          // Failure is a replayable attempt; the official protocol still re-emits the UserQuest row.
          await putElements(playerId, 'Quests', [old], tx);
        }
        pushUpdated(updated, 'Quests', old);

        // Solis keeps both the latest and the best result; sumire-sr keeps the latest clear.
        if (result.Cleared === true) {
          await saveLatestClear(
            playerId,
            questId,
            {
              __msg: QUEST_GET_LATEST_CLEAR_LIVE_RESULT_RESPONSE_MSG,
              Result: result as unknown as Decoded,
              RankPatterns: patterns,
              CommonResponse: { __msg: 'Solis.Common.Proto.Api.CommonResponse' } as Decoded,
            } as Decoded,
            tx,
          );
        }

        return {
          __msg: QUEST_START_RESPONSE_MSG,
          QuestId: questId,
          Result: result as unknown as Decoded,
          Reward: reward,
          RankType: rankType,
          RankPlus: plus,
          RankPatterns: patterns,
          HighestScore: n(old.HighestScore),
          HighestRank: 0,
          CommonResponse: emptyCommon(compactUpdated(updated)),
        } as Decoded;
      });

      ctx.fastifyReq.log.info({ playerId, questId, deckNumber, playCount }, 'quest start (server-authoritative)');
      return payload;
    });
  },
  { ownsState: true },
);

function compactUpdated(updated: Decoded): Decoded {
  const result = { __msg: UPDATED_DATA_MSG } as Decoded;
  for (const [key, value] of Object.entries(updated)) {
    if (key === '__msg' || key === '__unknown') continue;
    if (Array.isArray(value)) {
      const seen = new Set<string>();
      const rows: Decoded[] = [];
      const identity: Record<string, string[]> = {
        Areas: ['AreaId'],
        Quests: ['QuestId'],
        Cards: ['CardId'],
        Characters: ['CharacterId'],
        Missions: ['MissionId'],
        Musics: ['MusicId'],
        Items: ['ItemId'],
        Points: ['PointType'],
        CharacterMusics: ['CharacterId', 'MusicId'],
      };
      for (const row of value as Decoded[]) {
        const keys = identity[key];
        const dedupeKey = keys ? keys.map((field) => s(row[field])).join(':') : '';
        if (keys && dedupeKey !== '' && seen.has(dedupeKey)) continue;
        if (keys) seen.add(dedupeKey);
        rows.push(row);
      }
      if (rows.length > 0) result[key] = rows as Decoded;
      continue;
    }
    if (value !== null && value !== undefined) result[key] = value as Decoded;
  }
  return result;
}

register(
  'Quest:Top',
  async (ctx) => {
    return withQuestPlayer(ctx, 'Quest:Top', async (playerId) => {
      const updated = emptyUpdated();
      const catalog = await loadQuestCatalog(playerId, Date.now(), updated, db);
      const hierarchy = await reconcileHierarchyNotification(playerId, HIERARCHY_PRIVATE_SERVER_RANK);
      if (hierarchy.hierarchy) updated.Hierarchy = hierarchy.hierarchy;
      return {
        __msg: QUEST_TOP_RESPONSE_MSG,
        MainAreaGroups: catalog.main,
        DailyAreas: catalog.daily,
        TowerArea: (catalog.tower?.Area as Decoded | undefined) ?? undefined,
        ContestArea: catalog.contest ?? undefined,
        CurrentTowerQuestId: s(catalog.tower?.CurrentTowerQuestId),
        IsDailyPlayable: catalog.dailyPlayable,
        ContestTotalScore: catalog.contestScore,
        HasUnplayedContest: catalog.hasUnplayedContest,
        IsTowerTopUnlocked: catalog.towerUnlocked,
        PvpInfo: { __msg: QUEST_TOP_PVP_INFO_MSG } as Decoded,
        HierarchyNotiInfo: hierarchy.info,
        // not ported: bulk-daily infos.
        BulkDailyInfos: [],
        CommonResponse: emptyCommon(compactUpdated(updated)),
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Quest:ListMain',
  async (ctx) => {
    return withQuestPlayer(ctx, 'Quest:ListMain', async (playerId) => {
      const updated = emptyUpdated();
      const catalog = await loadQuestCatalog(playerId, Date.now(), updated, db);
      return {
        __msg: QUEST_LIST_MAIN_RESPONSE_MSG,
        AreaGroups: catalog.main,
        CommonResponse: emptyCommon(compactUpdated(updated)),
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Quest:ListAsset',
  async (ctx) => {
    const req = ctx.request ?? {};
    return withQuestPlayer(ctx, 'Quest:ListAsset', async (playerId) => {
      const questId = s(req.QuestId);
      const deckNumber = n(req.DeckNumber);
      if (questId === '') throw new Error('Quest:ListAsset: QuestId is required');
      if (!(await getQuest(questId))) throw new Error(`quest not found: ${questId}`);
      if (deckNumber <= 0) throw new Error('Quest:ListAsset: DeckNumber is required');
      if (idArray(req.UserBuddyDeckPositions).length > 0) throw new Error('buddy deck is not supported');
      const formation = await loadLiveFormation(playerId, deckNumber, db);
      const cards = await listElements(playerId, 'Cards', db);
      const byCard = new Map(cards.map((row) => [s(row.CardId), row]));
      const masterIds = formation.Positions.map((pos) => s(byCard.get(s(pos.CardId))?.CardId));
      const masterCards = await listCardsByIds(masterIds);
      const masterById = new Map(masterCards.map((row) => [s(row.Id), row]));
      const originalIds = formation.Positions.map((pos) => s(masterById.get(s(pos.CardId))?.CharacterId));
      const characters = await listElements(playerId, 'Characters', db);
      const masterCharacters = await listCharacters();
      const byMasterCharacter = new Map(masterCharacters.map((row) => [s(row.Id), row]));
      const assets = await liveDeckCharacterAssets(formation.Positions, originalIds, characters, byMasterCharacter, db);
      const quest = await getQuest(questId);
      const music = quest && s(quest.MusicId) !== '' ? await getMusic(s(quest.MusicId)) : null;
      const extra = await prepareExtraLiveAppearances(
        playerId,
        music,
        characters,
        byMasterCharacter,
        assets,
        db,
      );
      return {
        __msg: QUEST_LIST_ASSET_RESPONSE_MSG,
        CharacterAssets: [...assets, ...extra],
        CommonResponse: emptyCommon(emptyUpdated()),
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Quest:ListLatestClear',
  async (ctx) => {
    const req = ctx.request ?? {};
    return withQuestPlayer(ctx, 'Quest:ListLatestClear', async (playerId) => {
      const questId = s(req.QuestId);
      if (questId === '') throw new Error('Quest:ListLatestClear: QuestId is required');
      if (!(await getQuest(questId))) throw new Error(`quest not found: ${questId}`);
      const updated = emptyUpdated();
      const clears: Decoded[] = [];
      const latest = await loadLatestClear(playerId, questId, db);
      const userQuest = (await listElements(playerId, 'Quests', db)).find((row) => s(row.QuestId) === questId);
      if (latest && n(userQuest?.LastClearedTime) > 0) {
        const result = (latest.Result as Decoded | undefined) ?? ({} as Decoded);
        const userInfo = toArray(result.UserInfos)[0] as Decoded | undefined;
        const userResult = (userInfo?.UserResult as Decoded | undefined) ?? ({} as Decoded);
        const user = await getSingleton(playerId, 'User', db);
        clears.push({
          __msg: QUEST_CLEAR_INFO_MSG,
          Score: n(userResult.Score),
          UserName: s(user?.Name),
          DeckName: s((userInfo?.UserDeck as Decoded | undefined)?.DeckName),
          Cards: toArray((userInfo?.UserDeck as Decoded | undefined)?.Cards),
          EmblemId: s(user?.EmblemId),
          UserId: await publicUserId(playerId),
          RankType: n(userQuest?.HighestScoreRank),
          Plus: 0,
          IsLiveResultDetailAvailable: true,
        } as Decoded);
      }
      return {
        __msg: QUEST_LIST_LATEST_CLEAR_RESPONSE_MSG,
        Clears: clears,
        CommonResponse: emptyCommon(compactUpdated(updated)),
      } as Decoded;
    });
  },
  { ownsState: true },
);

async function publicUserId(playerId: string): Promise<string> {
  const [row] = await db
    .select({ data: players.data })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  const data = row?.data as { publicUserId?: string } | null | undefined;
  return data?.publicUserId ?? playerId;
}

register(
  'Quest:GetLatestClearLiveResult',
  async (ctx) => {
    const req = ctx.request ?? {};
    return withQuestPlayer(ctx, 'Quest:GetLatestClearLiveResult', async (playerId) => {
      const questId = s(req.QuestId);
      if (questId === '') throw new Error('Quest:GetLatestClearLiveResult: QuestId is required');
      if (!(await getQuest(questId))) throw new Error(`quest not found: ${questId}`);
      const requestedUser = s(req.UserId);
      if (requestedUser !== '' && requestedUser !== (await publicUserId(playerId))) {
        throw new Error('latest clear live result belongs to another user');
      }
      const latest = await loadLatestClear(playerId, questId, db);
      if (!latest) throw new Error('latest clear live result not found');
      return {
        __msg: QUEST_GET_LATEST_CLEAR_LIVE_RESULT_RESPONSE_MSG,
        Result: latest.Result,
        RankPatterns: latest.RankPatterns ?? [],
        CommonResponse: emptyCommon(emptyUpdated()),
      } as Decoded;
    });
  },
  { ownsState: true },
);

// TEMP experiment: serve the captured official PvpInfo.
