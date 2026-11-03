import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import type { RpcContext } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players, playerLessonProgress, type ActivityCampaignEffect } from '../db/schema.ts';
import { getSetting } from '../master/index.ts';
import { applyGrants } from '../master/reward.ts';
import { getSingleton } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Activity (timed idol activity) — lesson idle-reward port.
 *
 * The official service reconciles lesson progress from a master-defined step
 * length, caps the paid idle interval at twelve hours, and applies live campaign
 * permil bonuses at collection time. Only `Activity:ReceiveLessonReward` is
 * server-authoritative here; the remaining Activity endpoints still replay the
 * captured corpus.
 */

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const ACTIVITY_LESSON_PROGRESS_MSG = 'Solis.Common.Proto.Api.ActivityLessonProgress';
const LESSON_INFO_MSG = 'Solis.Common.Proto.Api.LessonInfo';
const ACTIVITY_CAMPAIGN_EFFECT_MSG = 'Solis.Common.Proto.Api.ActivityCampaignEffect';
const REWARD_MSG = 'Solis.Common.Proto.Transaction.Reward';

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

// Solis `activity_defaults.go`: initial step rates, main area and the seeded
// LessonInfo campaign effect (permanent +100% lesson exp in practice).
const DEFAULT_STEP_GOLD = 5;
const DEFAULT_STEP_MANAGER_EXP = 8;
const DEFAULT_STEP_CARD_ENHANCE_ITEM = 3;
const DEFAULT_AREA_ID = 'area-main-001';
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

  const end = Math.min(now, progress.maxRewardTime);
  const steps =
    end > progress.lastReceiveTime ? Math.floor((end - progress.lastReceiveTime) / stepMillis) : 0;
  const gold = checkedActivityAmount(steps, progress.stepRewardGold);
  const managerExp = checkedActivityAmount(steps, progress.stepRewardManagerExp);
  const cardEnhanceItem = checkedActivityAmount(steps, progress.stepRewardCardEnhanceItem);
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
    await applyGrants(
      playerId,
      [{ resourceType: RES_MANAGER_EXP, resourceId: '', amount: reward.amount }],
      exec,
    );
    // Mirror `viber.AddManagerExp`: surface the post-grant manager exp to the
    // client while leaving level progression to the common manager-exp path.
    const [row] = await exec
      .select({ exp: players.exp })
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);
    const user = await getSingleton(playerId, 'User', exec);
    if (user) {
      user.ManagerExp = Number(row?.exp ?? 0);
      updated.User = user;
    }
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
        state.progress.rewardGold = 0;
        state.progress.rewardManagerExp = 0;
        state.progress.rewardCardEnhanceItem = 0;
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
