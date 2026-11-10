import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import type { RpcContext } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players, playerLessonProgress, type ActivityCampaignEffect } from '../db/schema.ts';
import { getItem, getSetting, listAreas } from '../master/index.ts';
import { applyGrants } from '../master/reward.ts';
import { getCurrency, spendStone } from './currency.ts';
import { getItemAmount, spendItem } from './inventory.ts';
import { listElements } from './playerState.ts';
import { isSandbox } from '../profile.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Activity (timed idol activity) — lesson idle-reward port.
 *
 * The official service reconciles lesson progress from a master-defined step
 * length, caps the paid idle interval at twelve hours, and applies live campaign
 * permil bonuses at collection time. `Activity:ReceiveLessonReward` and
 * `Activity:PromoteLesson` are server-authoritative here; the remaining Activity
 * endpoints still replay the captured corpus.
 */

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const ACTIVITY_LESSON_PROGRESS_MSG = 'Solis.Common.Proto.Api.ActivityLessonProgress';
const LESSON_INFO_MSG = 'Solis.Common.Proto.Api.LessonInfo';
const ACTIVITY_CAMPAIGN_EFFECT_MSG = 'Solis.Common.Proto.Api.ActivityCampaignEffect';
const REWARD_MSG = 'Solis.Common.Proto.Transaction.Reward';
const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';

const LESSON_REWARD_WINDOW_MS = 12 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_INT32 = 2_147_483_647;

const RES_ITEM = 1;
const RES_GOLD = 8;
const RES_MANAGER_EXP = 14;
const CARD_ENHANCE_ITEM_ID = 'item-card_enhance';

export { RES_ITEM, RES_GOLD, RES_MANAGER_EXP, CARD_ENHANCE_ITEM_ID, MAX_INT32, ACTIVITY_CAMPAIGN_EFFECT_MSG };

const EFFECT_LESSON_GOLD_UP = 4001;
const EFFECT_LESSON_EXP_UP = 4002;
const EFFECT_LESSON_CARD_ENHANCE_ITEM_UP = 4003;

const ITEM_TYPE_ACTIVITY_LESSON_PROMOTE = 1007;

// Solis `activity_defaults.go`: initial step rates, main area and the seeded
// LessonInfo campaign effect (permanent +100% lesson exp in practice).
const DEFAULT_STEP_GOLD = 5;
const DEFAULT_STEP_MANAGER_EXP = 8;
const DEFAULT_STEP_CARD_ENHANCE_ITEM = 3;
const DEFAULT_AREA_ID = 'area-main-001';
const AREA_MAIN = 1;

type LessonStepRates = { gold: number; managerExp: number; cardEnhanceItem: number };

// Official `Home:Enter` LessonProgress step rates keyed by the main area number
// (captures/2026-10-26_lesson_rate_official, captures/2026-10-09_photo_official).
// The rate depends only on CurrentAreaId. Areas without a capture use the nearest
// captured area below them; nothing is interpolated.
const LESSON_AREA_RATES: ReadonlyArray<{ area: number } & LessonStepRates> = [
  { area: 1, gold: 5, managerExp: 8, cardEnhanceItem: 3 },
  { area: 2, gold: 7, managerExp: 9, cardEnhanceItem: 5 },
  { area: 3, gold: 10, managerExp: 10, cardEnhanceItem: 7 },
  { area: 6, gold: 25, managerExp: 20, cardEnhanceItem: 16 },
  { area: 7, gold: 30, managerExp: 24, cardEnhanceItem: 19 },
  { area: 10, gold: 51, managerExp: 35, cardEnhanceItem: 29 },
];

const DEFAULT_CAMPAIGN_EFFECTS: ActivityCampaignEffect[] = [
  { Type: EFFECT_LESSON_EXP_UP, Value: 1000, EndTime: 4_124_271_599_000 },
];

type LessonProgressRow = typeof playerLessonProgress.$inferSelect;

export type LessonState = {
  progress: LessonProgressRow;
  effects: ActivityCampaignEffect[];
  stepSeconds: number;
};

export function accountOf(ctx: RpcContext): string {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error('unauthenticated');
  return accountId;
}

export async function playerForAccount(accountId: string, rpc: string, exec: Executor = db) {
  const [pl] = await exec.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

export function commonResponse(updated: Decoded): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: updated,
    DeletedData: { __msg: 'Solis.Common.Proto.Api.DeletedData' },
  } as Decoded;
}

export function mergeUpdated(target: Decoded, source: Decoded | null): void {
  if (!source) return;
  for (const [k, v] of Object.entries(source)) {
    if (k === '__msg' || k === '__unknown') continue;
    target[k] = v as Decoded;
  }
}

/** JST calendar day key (`2006-01-02` in Asia/Tokyo). */
function jstDay(now: number): string {
  return new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10);
}

async function loadOrSeedProgress(playerId: string, now: number, exec: Executor): Promise<LessonProgressRow> {
  const [existing] = await exec
    .select()
    .from(playerLessonProgress)
    .where(eq(playerLessonProgress.playerId, playerId))
    .limit(1);
  if (existing) return existing;

  await exec
    .insert(playerLessonProgress)
    .values({
      id: randomUUID(),
      playerId,
      stepRewardGold: DEFAULT_STEP_GOLD,
      stepRewardManagerExp: DEFAULT_STEP_MANAGER_EXP,
      stepRewardCardEnhanceItem: DEFAULT_STEP_CARD_ENHANCE_ITEM,
      rewardGold: 0,
      rewardManagerExp: 0,
      rewardCardEnhanceItem: 0,
      lastReceiveTime: now,
      maxRewardTime: now + LESSON_REWARD_WINDOW_MS,
      dailyPromoteCount: 0,
      currentAreaId: DEFAULT_AREA_ID,
      campaignEffects: DEFAULT_CAMPAIGN_EFFECTS.map((e) => ({ ...e })),
      dailyStateDay: jstDay(now),
    })
    .onConflictDoNothing();

  const [row] = await exec
    .select()
    .from(playerLessonProgress)
    .where(eq(playerLessonProgress.playerId, playerId))
    .limit(1);
  if (!row) throw new Error('Activity: failed to seed lesson progress');
  return row;
}

export function lessonRatesForArea(areaId: string): LessonStepRates {
  const match = /^area-main-(\d+)$/.exec(areaId);
  const area = match ? Number(match[1]) : 0;
  let rates: LessonStepRates = LESSON_AREA_RATES[0]!;
  for (const row of LESSON_AREA_RATES) {
    if (row.area <= area) rates = row;
  }
  return { gold: rates.gold, managerExp: rates.managerExp, cardEnhanceItem: rates.cardEnhanceItem };
}

/**
 * The official CurrentAreaId is the main area holding the next uncleared main
 * quest (after the last quest of area 002 clears it is already area-main-003).
 * Once every main quest is cleared it stays on the last main area.
 */
export async function currentLessonAreaId(playerId: string, exec: Executor = db): Promise<string> {
  const [areas, userAreas, userQuests] = await Promise.all([
    listAreas(),
    listElements(playerId, 'Areas', exec),
    listElements(playerId, 'Quests', exec),
  ]);
  const cleared = new Set(
    userQuests.filter((q) => Number(q.LastClearedTime ?? 0) > 0).map((q) => String(q.QuestId ?? '')),
  );
  const clearCount = new Map(userAreas.map((a) => [String(a.AreaId ?? ''), Number(a.ClearQuestCount ?? 0)]));
  let last = DEFAULT_AREA_ID;
  for (const area of areas) {
    if (Number(area.Type) !== AREA_MAIN) continue;
    const ids = Array.isArray(area.QuestIds) ? area.QuestIds.map(String) : [];
    if (ids.length === 0) continue;
    const id = String(area.Id);
    last = id;
    if ((clearCount.get(id) ?? 0) >= ids.length) continue;
    if (ids.some((q) => !cleared.has(q))) return id;
  }
  return last;
}

/**
 * Move the lesson to `areaId` at `at`. Whole steps already elapsed are banked at
 * the old rate (up to the 12h cap); later steps accrue at the new area's rate.
 */
export function applyLessonArea(
  progress: LessonProgressRow,
  areaId: string,
  at: number,
  stepMillis: number,
): boolean {
  const rates = lessonRatesForArea(areaId);
  const sameRates =
    progress.stepRewardGold === rates.gold &&
    progress.stepRewardManagerExp === rates.managerExp &&
    progress.stepRewardCardEnhanceItem === rates.cardEnhanceItem;
  if (progress.currentAreaId === areaId && sameRates) return false;

  if (!sameRates) {
    const base = Math.max(progress.lastReceiveTime, progress.rateAnchorTime);
    const end = Math.min(at, progress.maxRewardTime);
    const steps = end > base ? Math.floor((end - base) / stepMillis) : 0;
    progress.bankedRewardGold = checkedLessonSum(
      progress.bankedRewardGold,
      checkedActivityAmount(steps, progress.stepRewardGold),
    );
    progress.bankedRewardManagerExp = checkedLessonSum(
      progress.bankedRewardManagerExp,
      checkedActivityAmount(steps, progress.stepRewardManagerExp),
    );
    progress.bankedRewardCardEnhanceItem = checkedLessonSum(
      progress.bankedRewardCardEnhanceItem,
      checkedActivityAmount(steps, progress.stepRewardCardEnhanceItem),
    );
    // 0 means no steps are banked since lastReceiveTime.
    const anchor = base + steps * stepMillis;
    progress.rateAnchorTime = anchor > progress.lastReceiveTime ? anchor : 0;
    progress.stepRewardGold = rates.gold;
    progress.stepRewardManagerExp = rates.managerExp;
    progress.stepRewardCardEnhanceItem = rates.cardEnhanceItem;
  }
  progress.currentAreaId = areaId;
  return true;
}

function checkedLessonSum(a: number, b: number): number {
  if (a > MAX_INT32 - b) throw new Error('activity reward amount overflows');
  return a + b;
}

/** Clear the banked old-rate reward once pending lesson rewards are paid out. */
function resetLessonPending(progress: LessonProgressRow): void {
  progress.rewardGold = 0;
  progress.rewardManagerExp = 0;
  progress.rewardCardEnhanceItem = 0;
  progress.bankedRewardGold = 0;
  progress.bankedRewardManagerExp = 0;
  progress.bankedRewardCardEnhanceItem = 0;
  progress.rateAnchorTime = 0;
}

async function lessonStepSeconds(): Promise<number> {
  const setting = await getSetting();
  const seconds = Number(setting?.SecondsPerActivityLessonStep ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('lesson step duration is invalid');
  }
  return Math.floor(seconds);
}

function checkedActivityAmount(steps: number, perStep: number): number {
  if (
    !Number.isInteger(steps) ||
    !Number.isInteger(perStep) ||
    steps < 0 ||
    perStep < 0 ||
    (perStep > 0 && steps > Math.floor(MAX_INT32 / perStep))
  ) {
    throw new Error('activity reward amount overflows');
  }
  return steps * perStep;
}

export function activityCampaignBonusAmount(
  base: number,
  effectType: number,
  effects: ActivityCampaignEffect[],
): number {
  let coefficient = 1000;
  for (const effect of effects) {
    if (Number(effect.Type) !== effectType) continue;
    const value = Number(effect.Value);
    if (!Number.isInteger(value) || value < 0 || coefficient > Number.MAX_SAFE_INTEGER - value) {
      throw new Error('activity campaign coefficient is invalid');
    }
    coefficient += value;
  }
  if (base <= 0 || coefficient === 1000) return base;
  if (base > Math.floor(Number.MAX_SAFE_INTEGER / coefficient)) {
    throw new Error('activity campaign reward overflows');
  }
  return Math.floor((base * coefficient) / 1000);
}

function advanceLessonReceiveAnchor(
  progress: LessonProgressRow,
  now: number,
  stepSeconds: number,
): void {
  if (!progress || stepSeconds <= 0) {
    throw new Error('lesson step duration is invalid');
  }
  const stepMillis = stepSeconds * 1000;
  if (now <= progress.lastReceiveTime) return;
  const steps = Math.floor((now - progress.lastReceiveTime) / stepMillis);
  if (steps <= 0) return;
  if (!Number.isSafeInteger(progress.lastReceiveTime + steps * stepMillis)) {
    throw new Error('lesson receive time overflows');
  }
  progress.lastReceiveTime += steps * stepMillis;
  if (!Number.isSafeInteger(progress.lastReceiveTime + LESSON_REWARD_WINDOW_MS)) {
    throw new Error('lesson reward window overflows');
  }
  progress.maxRewardTime = progress.lastReceiveTime + LESSON_REWARD_WINDOW_MS;
}

async function saveProgress(progress: LessonProgressRow, exec: Executor): Promise<void> {
  await exec
    .update(playerLessonProgress)
    .set({
      stepRewardGold: progress.stepRewardGold,
      stepRewardManagerExp: progress.stepRewardManagerExp,
      stepRewardCardEnhanceItem: progress.stepRewardCardEnhanceItem,
      rewardGold: progress.rewardGold,
      rewardManagerExp: progress.rewardManagerExp,
      rewardCardEnhanceItem: progress.rewardCardEnhanceItem,
      bankedRewardGold: progress.bankedRewardGold,
      bankedRewardManagerExp: progress.bankedRewardManagerExp,
      bankedRewardCardEnhanceItem: progress.bankedRewardCardEnhanceItem,
      rateAnchorTime: progress.rateAnchorTime,
      lastReceiveTime: progress.lastReceiveTime,
      maxRewardTime: progress.maxRewardTime,
      dailyPromoteCount: progress.dailyPromoteCount,
      currentAreaId: progress.currentAreaId,
      campaignEffects: progress.campaignEffects,
      dailyStateDay: progress.dailyStateDay,
      updatedAt: new Date(),
    })
    .where(eq(playerLessonProgress.id, progress.id));
}

/**
 * Load/seed + reconcile the player's lesson state. Mirrors
 * `ReconcileActivityLessonProgress` / `ReconcileActivityLessonInfo`: JST daily
 * reset, 12h reward cap, pending step amounts and expired-effect removal.
 * In the official profile the step rates and CurrentAreaId follow Main Live
 * progress (`applyLessonArea`); the sandbox profile keeps the seeded rates and
 * area unchanged.
 */
export async function reconcileLessonState(
  playerId: string,
  now: number,
  exec: Executor,
): Promise<LessonState> {
  const progress = await loadOrSeedProgress(playerId, now, exec);
  let changed = false;

  const day = jstDay(now);
  if (progress.dailyStateDay !== day) {
    progress.dailyStateDay = day;
    progress.dailyPromoteCount = 0;
    changed = true;
  }

  const stepSeconds = await lessonStepSeconds();
  const stepMillis = stepSeconds * 1000;

  if (progress.lastReceiveTime <= 0) {
    progress.lastReceiveTime = now;
    progress.maxRewardTime = now + LESSON_REWARD_WINDOW_MS;
    changed = true;
  }

  // Official profile only: follow Main Live progress. Sandbox keeps the seeded
  // rate/area, so this branch (and the banked old-rate columns) never runs there.
  if (!isSandbox()) {
    if (applyLessonArea(progress, await currentLessonAreaId(playerId, exec), now, stepMillis)) {
      changed = true;
    }
  }

  const base = Math.max(progress.lastReceiveTime, progress.rateAnchorTime);
  const end = Math.min(now, progress.maxRewardTime);
  const steps = end > base ? Math.floor((end - base) / stepMillis) : 0;
  const gold = checkedLessonSum(
    progress.bankedRewardGold,
    checkedActivityAmount(steps, progress.stepRewardGold),
  );
  const managerExp = checkedLessonSum(
    progress.bankedRewardManagerExp,
    checkedActivityAmount(steps, progress.stepRewardManagerExp),
  );
  const cardEnhanceItem = checkedLessonSum(
    progress.bankedRewardCardEnhanceItem,
    checkedActivityAmount(steps, progress.stepRewardCardEnhanceItem),
  );
  if (
    progress.rewardGold !== gold ||
    progress.rewardManagerExp !== managerExp ||
    progress.rewardCardEnhanceItem !== cardEnhanceItem
  ) {
    progress.rewardGold = gold;
    progress.rewardManagerExp = managerExp;
    progress.rewardCardEnhanceItem = cardEnhanceItem;
    changed = true;
  }

  const storedEffects = Array.isArray(progress.campaignEffects) ? progress.campaignEffects : [];
  const effects = storedEffects.filter((e) => e != null && Number(e.EndTime) > now);
  if (effects.length !== storedEffects.length) {
    progress.campaignEffects = effects;
    changed = true;
  }

  if (changed) await saveProgress(progress, exec);
  return { progress, effects, stepSeconds };
}

export async function grantActivityReward(
  playerId: string,
  reward: { resourceType: number; resourceId: string; amount: number },
  updated: Decoded,
  exec: Executor,
): Promise<void> {
  if (!reward || reward.amount <= 0) {
    throw new Error('activity reward must be positive');
  }
  if (reward.resourceType === RES_MANAGER_EXP) {
    const applied = await applyGrants(
      playerId,
      [{ resourceType: RES_MANAGER_EXP, resourceId: '', amount: reward.amount }],
      exec,
    );
    // `applyGrants` routes manager exp through `addManagerExp`, which mirrors
    // Solis `viber.AddManagerExp`: it raises ManagerLevel and surfaces the
    // updated User (ManagerLevel + ManagerExp) in UpdatedData.
    mergeUpdated(updated, applied.updated);
    return;
  }
  if (reward.amount > MAX_INT32) {
    throw new Error('activity reward amount exceeds supported range');
  }
  const applied = await applyGrants(
    playerId,
    [{ resourceType: reward.resourceType, resourceId: reward.resourceId, amount: reward.amount }],
    exec,
  );
  mergeUpdated(updated, applied.updated);
}

async function receiveLessonRewards(
  playerId: string,
  progress: LessonProgressRow,
  bonusSteps: number,
  effects: ActivityCampaignEffect[],
  updated: Decoded,
  exec: Executor,
): Promise<Decoded[]> {
  const amounts = [
    {
      resourceType: RES_GOLD,
      resourceId: '',
      pending: progress.rewardGold,
      perStep: progress.stepRewardGold,
      effectType: EFFECT_LESSON_GOLD_UP,
    },
    {
      resourceType: RES_MANAGER_EXP,
      resourceId: '',
      pending: progress.rewardManagerExp,
      perStep: progress.stepRewardManagerExp,
      effectType: EFFECT_LESSON_EXP_UP,
    },
    {
      resourceType: RES_ITEM,
      resourceId: CARD_ENHANCE_ITEM_ID,
      pending: progress.rewardCardEnhanceItem,
      perStep: progress.stepRewardCardEnhanceItem,
      effectType: EFFECT_LESSON_CARD_ENHANCE_ITEM_UP,
    },
  ];

  const rewards: Decoded[] = [];
  for (const value of amounts) {
    let pending = value.pending;
    if (bonusSteps > 0 && value.perStep > 0) {
      if (bonusSteps > Math.floor(Number.MAX_SAFE_INTEGER / value.perStep)) {
        throw new Error('lesson reward amount overflows');
      }
      const bonus = bonusSteps * value.perStep;
      if (pending > Number.MAX_SAFE_INTEGER - bonus) {
        throw new Error('lesson reward amount overflows');
      }
      pending += bonus;
    }
    pending = activityCampaignBonusAmount(pending, value.effectType, effects);
    if (pending <= 0) continue;

    const reward = {
      resourceType: value.resourceType,
      resourceId: value.resourceId,
      amount: pending,
    };
    await grantActivityReward(playerId, reward, updated, exec);
    rewards.push({
      __msg: REWARD_MSG,
      ResourceType: reward.resourceType,
      ...(reward.resourceId ? { ResourceId: reward.resourceId } : {}),
      Amount: reward.amount,
    } as Decoded);
  }
  return rewards;
}

function progressMessage(progress: LessonProgressRow): Decoded {
  return {
    __msg: ACTIVITY_LESSON_PROGRESS_MSG,
    StepRewardGold: progress.stepRewardGold,
    StepRewardManagerExp: progress.stepRewardManagerExp,
    StepRewardCardEnhanceItem: progress.stepRewardCardEnhanceItem,
    RewardGoldAmount: progress.rewardGold,
    RewardManagerExpAmount: progress.rewardManagerExp,
    RewardCardEnhanceItemAmount: progress.rewardCardEnhanceItem,
    LastReceiveTime: progress.lastReceiveTime,
    MaxRewardTime: progress.maxRewardTime,
    DailyPromoteCount: progress.dailyPromoteCount,
    CurrentAreaId: progress.currentAreaId,
  } as Decoded;
}

export function effectsMessage(effects: ActivityCampaignEffect[]): Decoded[] {
  return effects.map(
    (e) =>
      ({
        __msg: ACTIVITY_CAMPAIGN_EFFECT_MSG,
        Type: Number(e.Type),
        Value: Number(e.Value),
        EndTime: Number(e.EndTime),
      }) as Decoded,
  );
}

/** `ActivityLessonProgress` plus the enclosing `LessonInfo` for `Home:Enter`. */
export function lessonHomeFields(state: LessonState): { LessonProgress: Decoded; LessonInfo: Decoded } {
  const progress = progressMessage(state.progress);
  return {
    LessonProgress: progress,
    LessonInfo: {
      __msg: LESSON_INFO_MSG,
      LessonProgress: progress,
      CampaignEffects: effectsMessage(state.effects),
      CampaignDropRewardIds: [],
    } as Decoded,
  };
}

register(
  'Activity:ReceiveLessonReward',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const pl = await playerForAccount(accountId, 'Activity:ReceiveLessonReward');
    const out = await withPlayerTx(pl.id, async (tx) => {
      const now = Date.now();
      const state = await reconcileLessonState(pl.id, now, tx);
      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      const rewards = await receiveLessonRewards(
        pl.id,
        state.progress,
        0,
        state.effects,
        updated,
        tx,
      );
      if (rewards.length > 0) {
        advanceLessonReceiveAnchor(state.progress, now, state.stepSeconds);
        resetLessonPending(state.progress);
        await saveProgress(state.progress, tx);
      }
      return { rewards, progress: state.progress, effects: state.effects, updated };
    });

    return {
      __msg: '',
      Rewards: out.rewards,
      Progress: progressMessage(out.progress),
      CampaignEffects: effectsMessage(out.effects),
      CampaignDropRewards: [],
      CommonResponse: commonResponse(out.updated),
    } as Decoded;
  },
  { ownsState: true },
);

type PromoteSettings = {
  limitCount: number;
  freeLimitCount: number;
  requiredStoneAmount: number;
  effectHours: number;
};

async function promoteSettings(): Promise<PromoteSettings> {
  const setting = await getSetting();
  return {
    limitCount: Number(setting?.ActivityLessonPromoteLimitCount ?? 0),
    freeLimitCount: Number(setting?.ActivityLessonPromoteFreeLimitCount ?? 0),
    requiredStoneAmount: Number(setting?.ActivityLessonPromoteRequiredStoneAmount ?? 0),
    effectHours: Number(setting?.ActivityLessonPromoteEffectHours ?? 0),
  };
}

/**
 * `Activity:PromoteLesson` — the home self-training "advance two hours" button.
 * Mirrors Solis `promote_lesson.go`: spend the free daily promotion, a
 * lesson-boost item or stones, then pay the pending idle rewards plus
 * `EffectHours` worth of bonus steps through the same campaign-adjusted path as
 * `ReceiveLessonReward`. Free and stone promotions count toward the daily
 * limit; item promotions do not.
 */
register(
  'Activity:PromoteLesson',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const isFree = Boolean(ctx.request?.IsFree);
    const useItemId = String(ctx.request?.UseItemId ?? '');
    const pl = await playerForAccount(accountId, 'Activity:PromoteLesson');
    const out = await withPlayerTx(pl.id, async (tx) => {
      const now = Date.now();
      const state = await reconcileLessonState(pl.id, now, tx);
      const progress = state.progress;
      const setting = await promoteSettings();
      const isItemPromotion = !isFree && useItemId !== '';
      if (!isItemPromotion && progress.dailyPromoteCount >= setting.limitCount) {
        throw new Error('Activity:PromoteLesson: daily lesson promotion limit reached');
      }

      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      const spentItems: Decoded[] = [];
      if (isFree) {
        if (useItemId !== '') {
          throw new Error('Activity:PromoteLesson: a free lesson promotion cannot use an item');
        }
        if (progress.dailyPromoteCount >= setting.freeLimitCount) {
          throw new Error('Activity:PromoteLesson: daily free lesson promotion already used');
        }
      } else if (useItemId !== '') {
        const item = await getItem(useItemId);
        if (!item) throw new Error(`Activity:PromoteLesson: unknown item ${useItemId}`);
        if (Number(item.Type) !== ITEM_TYPE_ACTIVITY_LESSON_PROMOTE) {
          throw new Error('Activity:PromoteLesson: item cannot promote lessons');
        }
        const before = await getItemAmount(pl.id, useItemId, tx);
        if (before < 1) throw new Error('Activity:PromoteLesson: lesson promotion item is insufficient');
        await spendItem(pl.id, useItemId, 1, tx);
        spentItems.push({ __msg: USER_ITEM_MSG, ItemId: useItemId, Amount: before - 1 } as Decoded);
      } else {
        const amount = setting.requiredStoneAmount;
        if (amount <= 0) throw new Error('Activity:PromoteLesson: lesson promotion stone cost is invalid');
        const stones =
          (await getCurrency(pl.id, 'freeJewel', tx)) + (await getCurrency(pl.id, 'paidJewel', tx));
        if (stones < amount) throw new Error('Activity:PromoteLesson: stones are insufficient');
        updated.Balance = await spendStone(pl.id, amount, tx);
      }

      if (state.stepSeconds <= 0 || setting.effectHours <= 0) {
        throw new Error('Activity:PromoteLesson: lesson promotion master settings are invalid');
      }
      const bonusSteps = Math.floor((setting.effectHours * 60 * 60) / state.stepSeconds);
      const rewards = await receiveLessonRewards(
        pl.id,
        progress,
        bonusSteps,
        state.effects,
        updated,
        tx,
      );
      // Reward grants replace UpdatedData.Items wholesale; keep the spent boost item.
      if (spentItems.length) {
        const granted = ((updated.Items as Decoded[] | undefined) ?? []).filter(
          (i) => String(i.ItemId ?? '') !== useItemId,
        );
        updated.Items = [...granted, ...spentItems] as Decoded[];
      }
      if (!isItemPromotion) progress.dailyPromoteCount += 1;
      advanceLessonReceiveAnchor(progress, now, state.stepSeconds);
      resetLessonPending(progress);
      await saveProgress(progress, tx);
      return { rewards, progress, effects: state.effects, updated };
    });

    return {
      __msg: '',
      Rewards: out.rewards,
      Progress: progressMessage(out.progress),
      CampaignEffects: effectsMessage(out.effects),
      CampaignDropRewards: [],
      CommonResponse: commonResponse(out.updated),
    } as Decoded;
  },
  { ownsState: true },
);
