import { register } from './handlers.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import {
  getActivityPerformance,
  getActivityPromotion,
  getCharacterActivityLevel,
  getCostume,
  getHair,
  getItem,
  getReward,
  getSetting,
} from '../master/index.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import {
  CARD_ENHANCE_ITEM_ID,
  MAX_INT32,
  RES_GOLD,
  RES_ITEM,
  RES_MANAGER_EXP,
  accountOf,
  activityCampaignBonusAmount,
  commonResponse,
  effectsMessage,
  grantActivityReward,
  playerForAccount,
} from './activity.ts';
import { getItemAmount, spendItem } from './inventory.ts';
import { getSingleton, listElements, putElements, putSingleton } from './playerState.ts';

/**
 * Activity (timed idol activity) — promotion port.
 *
 * Solis models an activity promotion as three idle characters performing a
 * show. Starting one writes the per-step rates onto the run, complete steps are
 * consumed round-robin from the three characters' activity stamina, and rewards
 * settle on demand (`ReceivePromotionReward`) or when the run finishes
 * (`FinishPromotion`). The reference implementation lives in
 * `solis-server/internal/server/rpc/servers/activity/{load,fetch,start,finish,
 * receive}_promotion*.go` plus `common.go`; this module ports those semantics
 * (request validation, state transitions, consumption, rewards, responses).
 */

const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const PROMOTION_PROGRESS_MSG = 'Solis.Common.Proto.Api.PromotionProgress';
const ACTIVITY_CHARACTER_INFO_MSG = 'Solis.Common.Proto.Api.ActivityCharacterInfo';
const ACTIVITY_LEVEL_PROGRESS_MSG = 'Solis.Common.Proto.Api.ActivityLevelProgress';
const ACTIVITY_LEVEL_INFO_MSG = 'Solis.Common.Proto.Api.ActivityLevelInfo';
const ACTIVITY_PROMOTION_REWARD_MSG = 'Solis.Common.Proto.Api.ActivityPromotionReward';
const ACTIVE_PROMOTION_MSG = 'Solis.Common.Proto.Api.ActivePromotion';
const REWARD_MSG = 'Solis.Common.Proto.Transaction.Reward';

const EFFECT_PROMOTION_CARD_ENHANCE_ITEM_UP = 2001;
const EFFECT_PROMOTION_GOLD_UP = 2002;
const EFFECT_PROMOTION_FAN_UP = 2004;

const LINEUP_SIZE = 3;
const MULTI_STEP_INTERVAL = 20;
const ITEM_TYPE_PROMOTION_SHORTEN = 1002;
const ITEM_TYPE_PROMOTION_SPECIAL_SHORTEN = 1008;

/** Per-player promotion state, stored in the generic singleton store. */
const PROMOTION_STATE_FIELD = 'ActivityPromotion';

type PromotionEntry = { Id: string; Exp: number };

type RunCharacter = { CharacterId: string; CostumeId: string; HairId: string };

type PromotionDrop = { ResourceType: number; ResourceId: string; Amount: number };

export type PromotionRun = {
  ActivityPromotionId: string;
  Name: string;
  SubName: string;
  Level: number;
  Characters: RunCharacter[];
  StartTime: number;
  FinishTime: number;
  StepConsumptionStamina: number;
  CompletedStep: number;
  StepRewardGold: number;
  StepRewardManagerExp: number;
  StepRewardActivityExp: number;
  StepRewardCharacterActivityExp: number;
  StepAdditionalRewardId: string;
  MultiStepRewardId: string;
  StepRewardCardEnhanceItem: number;
  RewardGoldAmount: number;
  RewardCardEnhanceItemAmount: number;
  Rewards: PromotionDrop[];
  NextActivityLevelUpTime: number;
  CampaignEffects: Decoded[];
  ActivityPerformanceId: string;
  SubGenre: string;
  MultiStepCampaignDropRewardIds: string[];
};

type PromotionState = {
  Promotions: PromotionEntry[];
  Run: PromotionRun | null;
  LastSettledCompletedStep: number;
  FanRewardStepRemainder: number;
  AccountingInitialized: boolean;
};

function emptyState(): PromotionState {
  return {
    Promotions: [],
    Run: null,
    LastSettledCompletedStep: 0,
    FanRewardStepRemainder: 0,
    AccountingInitialized: false,
  };
}

function int32(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > MAX_INT32) return MAX_INT32;
  if (value < -2_147_483_648) return -2_147_483_648;
  return Math.trunc(value);
}

/**
 * Solis `promotionStepExperience`: step rates are derived from step gold when
 * the master does not carry them separately.
 */
function promotionStepExperience(gold: number): [number, number, number] {
  if (gold <= 0) return [1, 1, 1];
  return [
    Math.max(1, int32(Math.trunc((gold + 4) / 5) - 3)),
    Math.max(1, int32(Math.trunc(gold / 10) + 5)),
    Math.max(1, int32(Math.trunc(gold / 10) + 10)),
  ];
}

async function loadState(playerId: string, exec: Executor): Promise<PromotionState> {
  const raw = await getSingleton(playerId, PROMOTION_STATE_FIELD, exec);
  if (!raw) return emptyState();
  const stored = raw as unknown as Partial<PromotionState>;
  return {
    Promotions: Array.isArray(stored.Promotions)
      ? stored.Promotions.map((p) => ({ Id: String(p.Id), Exp: Number(p.Exp ?? 0) }))
      : [],
    Run: stored.Run ? (stored.Run as PromotionRun) : null,
    LastSettledCompletedStep: Number(stored.LastSettledCompletedStep ?? 0),
    FanRewardStepRemainder: Number(stored.FanRewardStepRemainder ?? 0),
    AccountingInitialized: stored.AccountingInitialized !== false,
  };
}

async function saveState(playerId: string, state: PromotionState, exec: Executor): Promise<void> {
  await putSingleton(playerId, PROMOTION_STATE_FIELD, state as unknown as Decoded, exec);
}

function requireRun(state: PromotionState): PromotionRun {
  if (!state.Run) throw new Error('no promotion is active');
  return state.Run;
}

function promotionExp(state: PromotionState, id: string): number {
  return Number(state.Promotions.find((p) => p.Id === id)?.Exp ?? 0);
}

function setPromotionExp(state: PromotionState, id: string, exp: number): void {
  const entry = state.Promotions.find((p) => p.Id === id);
  if (entry) entry.Exp = int32(exp);
  else state.Promotions.push({ Id: id, Exp: int32(exp) });
}

function progressMessage(run: PromotionRun): Decoded {
  return {
    __msg: PROMOTION_PROGRESS_MSG,
    ActivityPromotionId: run.ActivityPromotionId,
    ActivityPromotionName: run.Name,
    ActivityPromotionSubName: run.SubName,
    ActivityPromotionLevel: run.Level,
    Characters: run.Characters.map(
      (c) =>
        ({
          __msg: ACTIVITY_CHARACTER_INFO_MSG,
          CharacterId: c.CharacterId,
          CostumeId: c.CostumeId,
          HairId: c.HairId,
        }) as Decoded,
    ),
    StartTime: run.StartTime,
    FinishTime: run.FinishTime,
    StepConsumptionStamina: run.StepConsumptionStamina,
    CompletedStep: run.CompletedStep,
    StepRewardGold: run.StepRewardGold,
    StepRewardManagerExp: run.StepRewardManagerExp,
    StepRewardActivityExp: run.StepRewardActivityExp,
    StepRewardCharacterActivityExp: run.StepRewardCharacterActivityExp,
    StepAdditionalRewardId: run.StepAdditionalRewardId,
    MultiStepRewardId: run.MultiStepRewardId,
    StepRewardCardEnhanceItem: run.StepRewardCardEnhanceItem,
    RewardGoldAmount: run.RewardGoldAmount,
    RewardCardEnhanceItemAmount: run.RewardCardEnhanceItemAmount,
    Rewards: run.Rewards.map(
      (r) =>
        ({
          __msg: ACTIVITY_PROMOTION_REWARD_MSG,
          ResourceType: r.ResourceType,
          ResourceId: r.ResourceId,
          Amount: r.Amount,
        }) as Decoded,
    ),
    NextActivityLevelUpTime: run.NextActivityLevelUpTime,
    CampaignEffects: effectsMessage(run.CampaignEffects as never),
    ActivityPerformanceId: run.ActivityPerformanceId,
    SubGenre: run.SubGenre,
    MultiStepCampaignDropRewardIds: run.MultiStepCampaignDropRewardIds,
  } as Decoded;
}

function rewardMessage(reward: { resourceType: number; resourceId: string; amount: number }): Decoded {
  return {
    __msg: REWARD_MSG,
    ResourceType: reward.resourceType,
    ResourceId: reward.resourceId,
    Amount: reward.amount,
  } as Decoded;
}

/** `Home`-style message builder: keeps singleton/progress shapes consistent. */
function activityLevelInfo(level: number, exp: number, nextLocked: boolean): Decoded {
  return { __msg: ACTIVITY_LEVEL_INFO_MSG, Level: level, Exp: exp, NextLevelLocked: nextLocked } as Decoded;
}

function activityLevelProgress(maxLevel: number, before: Decoded, after: Decoded): Decoded {
  return {
    __msg: ACTIVITY_LEVEL_PROGRESS_MSG,
    MaxActivityLevel: maxLevel,
    Before: before,
    After: after,
  } as Decoded;
}

/**
 * Solis `ReconcileActivityCharacterStamina`. Returns true when the character
 * post-image changed and therefore has to be persisted.
 */
async function reconcileCharacterStamina(
  character: Decoded,
  now: number,
): Promise<boolean> {
  if (!character || character.InActivity || !(now > 0)) return false;
  let level = Number(character.ActivityLevel ?? 0);
  if (level <= 0) level = 1;
  const masterLevel = await getCharacterActivityLevel(level);
  const maxStamina = Number(masterLevel?.MaxStamina ?? 0);
  if (Number(character.ActivityStamina ?? 0) >= maxStamina) return false;
  const setting = await getSetting();
  const seconds = Number(setting?.CharacterSecondToRecover ?? 0);
  const updatedTime = Number(character.StaminaUpdatedTime ?? 0);
  if (seconds <= 0 || updatedTime <= 0 || now <= updatedTime) return false;
  const recovered = Math.floor((now - updatedTime) / (seconds * 1000));
  if (recovered <= 0) return false;
  const before = Number(character.ActivityStamina ?? 0);
  character.ActivityStamina = Math.min(maxStamina, before + recovered);
  if (Number(character.ActivityStamina) >= maxStamina) {
    character.StaminaUpdatedTime = now;
  } else {
    character.StaminaUpdatedTime = updatedTime + recovered * seconds * 1000;
  }
  return true;
}

function characterMap(characters: Decoded[]): Map<string, Decoded> {
  const map = new Map<string, Decoded>();
  for (const c of characters) map.set(String(c.CharacterId), c);
  return map;
}

/**
 * Solis `validateActivityLineup`: exactly three owned characters with matching,
 * owned and wear-compatible costumes and hairs, and the performance's costume
 * type restriction. Stamina is reconciled as a side effect.
 */
async function validateLineup(
  playerId: string,
  performanceId: string,
  characterIds: string[],
  costumeIds: string[],
  hairIds: string[],
  now: number,
  exec: Executor,
): Promise<{ characters: Decoded[]; infos: RunCharacter[] }> {
  if (
    characterIds.length !== LINEUP_SIZE ||
    costumeIds.length !== LINEUP_SIZE ||
    hairIds.length !== LINEUP_SIZE
  ) {
    throw new Error(`activity lineup must contain exactly ${LINEUP_SIZE} characters`);
  }
  const performance = await getActivityPerformance(performanceId);
  if (!performance) throw new Error(`activity performance ${performanceId} is missing`);
  let allowedCostumeTypes = Array.isArray(performance.CostumeTypeIds)
    ? (performance.CostumeTypeIds as string[])
    : [];
  if (allowedCostumeTypes.length === 0 && performance.ForceCostumeTypeId) {
    allowedCostumeTypes = [String(performance.ForceCostumeTypeId)];
  }

  const roster = characterMap(await listElements(playerId, 'Characters', exec));
  const costumes = new Set((await listElements(playerId, 'Costumes', exec)).map((c) => String(c.CostumeId)));
  const hairs = new Set((await listElements(playerId, 'Hairs', exec)).map((h) => String(h.HairId)));

  const seen = new Set<string>();
  const characters: Decoded[] = [];
  const infos: RunCharacter[] = [];
  const dirty: Decoded[] = [];

  for (let index = 0; index < LINEUP_SIZE; index++) {
    const characterId = String(characterIds[index] ?? '');
    const costumeId = String(costumeIds[index] ?? '');
    const hairId = String(hairIds[index] ?? '');
    if (!characterId || !costumeId || !hairId) {
      throw new Error('character, costume and hair ids are required');
    }
    if (seen.has(characterId)) throw new Error('activity characters must be unique');
    seen.add(characterId);

    const character = roster.get(characterId);
    if (!character) throw new Error('character is not owned');
    if (character.InActivity) throw new Error('character is already in an activity');
    if (await reconcileCharacterStamina(character, now)) dirty.push(character);
    if (!costumes.has(costumeId)) throw new Error('costume is not owned');
    if (!hairs.has(hairId)) throw new Error('hair is not owned');

    const costume = await getCostume(costumeId);
    const hair = await getHair(hairId);
    if (!costume || !hair) throw new Error('costume or hair master is missing');
    if (String(costume.CharacterId ?? '') !== characterId || String(hair.CharacterId ?? '') !== characterId) {
      throw new Error('costume or hair belongs to another character');
    }
    if (allowedCostumeTypes.length > 0 && !allowedCostumeTypes.includes(String(costume.CostumeTypeId ?? ''))) {
      throw new Error('costume type is unavailable for this activity');
    }
    const notWearable = Array.isArray(hair.NotWearableCostumeIds)
      ? (hair.NotWearableCostumeIds as string[])
      : [];
    const wearable = Array.isArray(hair.WearableCostumeIds) ? (hair.WearableCostumeIds as string[]) : [];
    if (notWearable.includes(costumeId) || (wearable.length > 0 && !wearable.includes(costumeId))) {
      throw new Error('hair cannot be worn with costume');
    }

    characters.push(character);
    infos.push({ CharacterId: characterId, CostumeId: costumeId, HairId: hairId });
  }
  if (dirty.length) await putElements(playerId, 'Characters', dirty, exec);
  return { characters, infos };
}

/**
 * Solis `advancePromotion`: derives the completed step from wall-clock time,
 * then consumes one step's stamina per newly completed step round-robin. When
 * no character can pay, the run stalls at the last affordable step.
 */
async function advancePromotion(
  playerId: string,
  run: PromotionRun,
  now: number,
  exec: Executor,
): Promise<Decoded[]> {
  if (!run || run.Characters.length !== LINEUP_SIZE || run.StepConsumptionStamina <= 0) {
    throw new Error('active promotion data is invalid');
  }
  const setting = await getSetting();
  const stepSeconds = Number(setting?.SecondsPerActivityPromotionStep ?? 0);
  const stepMillis = stepSeconds * 1000;
  if (stepMillis <= 0 || run.FinishTime < run.StartTime) {
    throw new Error('promotion timing is invalid');
  }
  const maxSteps = Math.floor((run.FinishTime - run.StartTime) / stepMillis);
  let completed = now > run.StartTime ? Math.floor((now - run.StartTime) / stepMillis) : 0;
  if (completed > maxSteps) completed = maxSteps;
  if (completed > MAX_INT32) completed = MAX_INT32;
  if (completed < run.CompletedStep) completed = run.CompletedStep;

  const roster = characterMap(await listElements(playerId, 'Characters', exec));
  const characters: Decoded[] = [];
  for (const selected of run.Characters) {
    const character = roster.get(selected.CharacterId);
    if (!character) throw new Error(`character ${selected.CharacterId} is missing`);
    characters.push(character);
  }

  let delta = completed - run.CompletedStep;
  const consumption = run.StepConsumptionStamina;
  for (let step = 0; step < delta; step++) {
    const start = (run.CompletedStep + step) % characters.length;
    let consumed = false;
    for (let offset = 0; offset < characters.length; offset++) {
      const character = characters[(start + offset) % characters.length]!;
      if (Number(character.ActivityStamina ?? 0) >= consumption) {
        character.ActivityStamina = Number(character.ActivityStamina) - consumption;
        consumed = true;
        break;
      }
    }
    if (!consumed) {
      completed = run.CompletedStep + step;
      delta = step;
      break;
    }
  }

  if (delta > 0) {
    for (const character of characters) {
      character.StaminaUpdatedTime = now;
      await putElements(playerId, 'Characters', [character], exec);
    }
    run.CompletedStep = completed;
    const gold = promotionRewardDelta(
      completed - delta,
      completed,
      run.StepRewardGold,
      EFFECT_PROMOTION_GOLD_UP,
      run.CampaignEffects,
    );
    const cardEnhance = promotionRewardDelta(
      completed - delta,
      completed,
      run.StepRewardCardEnhanceItem,
      EFFECT_PROMOTION_CARD_ENHANCE_ITEM_UP,
      run.CampaignEffects,
    );
    run.RewardGoldAmount = int32(run.RewardGoldAmount + gold);
    run.RewardCardEnhanceItemAmount = int32(run.RewardCardEnhanceItemAmount + cardEnhance);
    await appendMultiStepRewards(run, completed - delta, completed);
  }
  return characters;
}

function promotionRewardDelta(
  previousStep: number,
  completedStep: number,
  perStep: number,
  effectType: number,
  effects: Decoded[],
): number {
  if (previousStep < 0 || completedStep < previousStep || perStep < 0) {
    throw new Error('promotion reward interval is invalid');
  }
  if (perStep > 0 && completedStep > Math.floor(Number.MAX_SAFE_INTEGER / perStep)) {
    throw new Error('promotion reward amount overflows');
  }
  const completed = activityCampaignBonusAmount(completedStep * perStep, effectType, effects as never);
  const previous = activityCampaignBonusAmount(previousStep * perStep, effectType, effects as never);
  return completed - previous;
}

async function appendMultiStepRewards(
  run: PromotionRun,
  previousStep: number,
  completedStep: number,
): Promise<void> {
  if (!run.MultiStepRewardId || Math.floor(completedStep / MULTI_STEP_INTERVAL) <= Math.floor(previousStep / MULTI_STEP_INTERVAL)) {
    return;
  }
  const reward = await getReward(run.MultiStepRewardId);
  const resources = Array.isArray(reward?.Resources)
    ? (reward.Resources as { ResourceType?: number; ResourceId?: string; Amount?: number }[])
    : [];
  if (resources.length === 0) {
    throw new Error(`promotion reward "${run.MultiStepRewardId}" has no resources`);
  }
  for (
    let milestone = Math.floor(previousStep / MULTI_STEP_INTERVAL) + 1;
    milestone <= Math.floor(completedStep / MULTI_STEP_INTERVAL);
    milestone++
  ) {
    const resource = resources[Math.floor(Math.random() * resources.length)];
    if (!resource || Number(resource.Amount ?? 0) < 0) {
      throw new Error(`promotion reward "${run.MultiStepRewardId}" is invalid`);
    }
    const amount = Number(resource.Amount ?? 0) || 1;
    run.Rewards.push({
      ResourceType: Number(resource.ResourceType ?? 0),
      ResourceId: String(resource.ResourceId ?? ''),
      Amount: amount,
    });
  }
}

function addPromotionFans(character: Decoded, maxFanAmount: number, amount: number): void {
  if (!character || maxFanAmount <= 0 || amount <= 0) return;
  const total =
    Number(character.LightFanAmount ?? 0) +
    Number(character.MiddleFanAmount ?? 0) +
    Number(character.HeavyFanAmount ?? 0);
  if (total < 0) throw new Error('character fan amount is invalid');
  const remaining = maxFanAmount - total;
  if (remaining <= 0) return;
  const gained = Math.min(amount, remaining);
  const light = Number(character.LightFanAmount ?? 0);
  if (light > MAX_INT32 - gained) throw new Error('character fan amount overflows');
  character.LightFanAmount = light + gained;
}

async function updateCharacterActivityLevel(character: Decoded): Promise<void> {
  for (;;) {
    const next = await getCharacterActivityLevel(Number(character.ActivityLevel ?? 0) + 1);
    if (!next) return;
    if (Number(character.ActivityExp ?? 0) < Number(next.RequiredExp ?? 0)) return;
    character.ActivityLevel = Number(next.Level);
  }
}

/** Solis `settlePromotionDropRewards`: group by resource, preserve order. */
async function settleDropRewards(
  playerId: string,
  drops: PromotionDrop[],
  updated: Decoded,
  exec: Executor,
): Promise<Decoded[]> {
  const amounts = new Map<string, { resourceType: number; resourceId: string; amount: number }>();
  for (const drop of drops) {
    if (!drop || Number(drop.Amount) <= 0) throw new Error('promotion drop reward is invalid');
    const key = `${drop.ResourceType}\u0001${drop.ResourceId}`;
    const existing = amounts.get(key);
    if (existing) {
      if (existing.amount > Number.MAX_SAFE_INTEGER - Number(drop.Amount)) {
        throw new Error('promotion drop reward overflows');
      }
      existing.amount += Number(drop.Amount);
    } else {
      amounts.set(key, {
        resourceType: Number(drop.ResourceType),
        resourceId: String(drop.ResourceId ?? ''),
        amount: Number(drop.Amount),
      });
    }
  }
  const rewards: Decoded[] = [];
  for (const reward of amounts.values()) {
    await grantActivityReward(playerId, reward, updated, exec);
    rewards.push(rewardMessage(reward));
  }
  return rewards;
}

type Settlement = { rewards: Decoded[]; levelProgress: Decoded; updated: Decoded };

/**
 * Solis `settlePromotionRewards`: pays every step completed since the last
 * settlement, grants drop/multi-step rewards, advances promotion exp and
 * character activity levels, and finally moves the settlement cursor.
 */
async function settlePromotionRewards(
  playerId: string,
  run: PromotionRun,
  state: PromotionState,
  characters: Decoded[],
  finish: boolean,
  exec: Executor,
): Promise<Settlement> {
  const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
  if (!state.AccountingInitialized) {
    const legacyPendingSteps =
      run.StepRewardGold > 0 ? Math.floor(run.RewardGoldAmount / run.StepRewardGold) : 0;
    state.LastSettledCompletedStep = Math.max(0, run.CompletedStep - legacyPendingSteps);
    state.FanRewardStepRemainder = state.LastSettledCompletedStep % MULTI_STEP_INTERVAL;
    state.AccountingInitialized = true;
  }
  if (state.LastSettledCompletedStep < 0 || state.LastSettledCompletedStep > run.CompletedStep) {
    throw new Error('promotion settlement cursor is invalid');
  }
  const pendingSteps = run.CompletedStep - state.LastSettledCompletedStep;

  const master = await getActivityPromotion(run.ActivityPromotionId);
  if (!master) throw new Error('active promotion definition is missing');
  const now = Date.now();
  const maxLevel = Number(master.PromotionLevel ?? 1);
  const beforeExp = promotionExp(state, run.ActivityPromotionId);
  const before = activityLevelInfo(Number(run.Level ?? 0), beforeExp, false);
  const activityExpGain = pendingSteps * run.StepRewardActivityExp;
  setPromotionExp(state, run.ActivityPromotionId, beforeExp + activityExpGain);
  const after = activityLevelInfo(Number(run.Level ?? 0), promotionExp(state, run.ActivityPromotionId), false);

  const fanSteps = state.FanRewardStepRemainder + pendingSteps;
  let fanGain = Math.floor(fanSteps / MULTI_STEP_INTERVAL);
  state.FanRewardStepRemainder = fanSteps % MULTI_STEP_INTERVAL;
  fanGain = activityCampaignBonusAmount(fanGain, EFFECT_PROMOTION_FAN_UP, run.CampaignEffects as never);

  const maxFanAmount = Number(master.MaxFanAmount ?? 0);
  for (const character of characters) {
    const characterExpGain = pendingSteps * run.StepRewardCharacterActivityExp;
    if (characterExpGain > 0 && Number(character.ActivityExp ?? 0) > Number.MAX_SAFE_INTEGER - characterExpGain) {
      throw new Error('character activity exp overflows');
    }
    character.ActivityExp = Number(character.ActivityExp ?? 0) + characterExpGain;
    addPromotionFans(character, maxFanAmount, fanGain);
    if (finish) {
      character.InActivity = false;
      character.StaminaUpdatedTime = now;
    }
    await updateCharacterActivityLevel(character);
    await putElements(playerId, 'Characters', [character], exec);
  }
  updated.Characters = characters;

  const rewards: Decoded[] = [];
  const managerExp = pendingSteps * run.StepRewardManagerExp;
  if (managerExp > 0) {
    const reward = { resourceType: RES_MANAGER_EXP, resourceId: '', amount: managerExp };
    await grantActivityReward(playerId, reward, updated, exec);
    rewards.push(rewardMessage(reward));
  }
  if (run.RewardGoldAmount > 0) {
    const reward = { resourceType: RES_GOLD, resourceId: '', amount: run.RewardGoldAmount };
    await grantActivityReward(playerId, reward, updated, exec);
    rewards.push(rewardMessage(reward));
  }
  if (run.RewardCardEnhanceItemAmount > 0) {
    const reward = {
      resourceType: RES_ITEM,
      resourceId: CARD_ENHANCE_ITEM_ID,
      amount: run.RewardCardEnhanceItemAmount,
    };
    await grantActivityReward(playerId, reward, updated, exec);
    rewards.push(rewardMessage(reward));
  }
  rewards.push(...(await settleDropRewards(playerId, run.Rewards, updated, exec)));

  if (pendingSteps > 0) {
    const setting = await getSetting();
    const minutes = Math.floor((pendingSteps * Number(setting?.SecondsPerActivityPromotionStep ?? 0)) / 60);
    const totalCount = await getSingleton(playerId, 'TotalCount', exec);
    if (totalCount) {
      const current = Number(totalCount.ActivityPromotionMinutes ?? 0);
      totalCount.ActivityPromotionMinutes = current + minutes;
      await putSingleton(playerId, 'TotalCount', totalCount, exec);
      updated.TotalCount = totalCount;
    }
  }

  run.RewardGoldAmount = 0;
  run.RewardCardEnhanceItemAmount = 0;
  run.Rewards = [];
  state.LastSettledCompletedStep = run.CompletedStep;

  return {
    rewards,
    levelProgress: activityLevelProgress(maxLevel, before, after),
    updated,
  };
}

async function findPerformanceForPromotion(promotionId: string, exec: Executor) {
  const promotion = await getActivityPromotion(promotionId);
  if (!promotion) return null;
  const performance = await getActivityPerformance(String(promotion.ActivityPerformanceId ?? ''));
  return performance ? { promotion, performance } : null;
}

/** Solis `promotionNextLevelLocked` (next-level data is not modelled here). */

function highestPromotionLevelName(levels: unknown): string {
  if (!Array.isArray(levels)) return '';
  const sorted = [...levels].sort((a, b) => Number(a?.Level ?? 0) - Number(b?.Level ?? 0));
  return String(sorted[sorted.length - 1]?.Name ?? '');
}

// --- RPC handlers -----------------------------------------------------------

register(
  'Activity:LoadPromotion',
  async (ctx) => {
    const player = await playerForAccount(accountOf(ctx), 'Activity:LoadPromotion');
    return withPlayerTx(player.id, async (tx) => {
      const state = await loadState(player.id, tx);
      const run = requireRun(state);
      await advancePromotion(player.id, run, Date.now(), tx);
      await saveState(player.id, state, tx);
      return {
        __msg: 'Solis.Common.Proto.Api.ActivityLoadPromotionResponse',
        Progress: progressMessage(run),
        CommonResponse: commonResponse({} as Decoded),
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Activity:FetchPromotionSteps',
  async (ctx) => {
    const req = ctx.request;
    if (!req || Number(req.Step ?? 0) < 0) throw new Error('step must not be negative');
    const player = await playerForAccount(accountOf(ctx), 'Activity:FetchPromotionSteps');
    return withPlayerTx(player.id, async (tx) => {
      const state = await loadState(player.id, tx);
      const run = requireRun(state);
      await advancePromotion(player.id, run, Date.now(), tx);
      await saveState(player.id, state, tx);
      return {
        __msg: 'Solis.Common.Proto.Api.ActivityFetchPromotionStepsResponse',
        Steps: [],
        CommonResponse: commonResponse({} as Decoded),
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Activity:StartPromotion',
  async (ctx) => {
    const req = ctx.request;
    if (!req || !req.ActivityPromotionId) throw new Error('activityPromotionId is required');
    const player = await playerForAccount(accountOf(ctx), 'Activity:StartPromotion');
    return withPlayerTx(player.id, async (tx) => {
      const state = await loadState(player.id, tx);
      if (state.Run) throw new Error('a promotion is already active');

      const promotionId = String(req.ActivityPromotionId);
      const def = await getActivityPromotion(promotionId);
      if (!def) throw new Error(`promotion "${promotionId}" is not unlocked`);

      const now = Date.now();
      const characterIds = Array.isArray(req.CharacterIds) ? (req.CharacterIds as string[]) : [];
      const costumeIds = Array.isArray(req.CostumeIds) ? (req.CostumeIds as string[]) : [];
      const hairIds = Array.isArray(req.HairIds) ? (req.HairIds as string[]) : [];
      const performanceId = String(def.ActivityPerformanceId ?? '');
      const { characters, infos } = await validateLineup(
        player.id,
        performanceId,
        characterIds,
        costumeIds,
        hairIds,
        now,
        tx,
      );

      const setting = await getSetting();
      const secondsPerStep = Number(setting?.SecondsPerActivityPromotionStep ?? 0);
      const consumption = Number(def.StepConsumptionStamina ?? 0);
      if (secondsPerStep <= 0 || consumption <= 0) {
        throw new Error('promotion timing is not configured');
      }
      const requiredStamina = Number(def.RequiredStamina ?? 0);
      let availableSteps = 0;
      for (const character of characters) {
        if (Number(character.ActivityStamina ?? 0) < requiredStamina) {
          throw new Error(`character "${String(character.CharacterId)}" has insufficient activity stamina`);
        }
        availableSteps += Math.floor(Number(character.ActivityStamina ?? 0) / consumption);
      }
      if (availableSteps <= 0) {
        throw new Error('the selected characters have insufficient activity stamina');
      }
      if (availableSteps > MAX_INT32) availableSteps = MAX_INT32;
      if (availableSteps > Math.floor((Number.MAX_SAFE_INTEGER - now) / (secondsPerStep * 1000))) {
        throw new Error('promotion finish time overflows');
      }
      const finishTime = now + availableSteps * secondsPerStep * 1000;
      const gold = Number(def.StepRewardGold ?? 0);
      const [managerExp, activityExp, characterExp] = promotionStepExperience(gold);

      const run: PromotionRun = {
        ActivityPromotionId: promotionId,
        Name: String(def.Name ?? ''),
        SubName: highestPromotionLevelName(def.Levels),
        Level: Number(def.PromotionLevel ?? 1),
        Characters: infos,
        StartTime: now,
        FinishTime: finishTime,
        StepConsumptionStamina: consumption,
        CompletedStep: 0,
        StepRewardGold: gold,
        StepRewardManagerExp: managerExp,
        StepRewardActivityExp: activityExp,
        StepRewardCharacterActivityExp: characterExp,
        StepAdditionalRewardId: '',
        MultiStepRewardId: String(def.MultiStepRewardId ?? ''),
        StepRewardCardEnhanceItem: Number(def.StepRewardCardEnhanceItem ?? 0),
        RewardGoldAmount: 0,
        RewardCardEnhanceItemAmount: 0,
        Rewards: [],
        NextActivityLevelUpTime: 0,
        CampaignEffects: [],
        ActivityPerformanceId: performanceId,
        SubGenre: String(def.SubGenre ?? ''),
        MultiStepCampaignDropRewardIds: [],
      };

      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      for (const character of characters) {
        character.InActivity = true;
        await putElements(player.id, 'Characters', [character], tx);
      }
      updated.Characters = characters;
      if (!state.Promotions.some((p) => p.Id === promotionId)) {
        state.Promotions.push({ Id: promotionId, Exp: 0 });
      }
      state.Run = run;
      state.LastSettledCompletedStep = 0;
      state.FanRewardStepRemainder = 0;
      state.AccountingInitialized = true;
      await saveState(player.id, state, tx);

      return {
        __msg: 'Solis.Common.Proto.Api.ActivityStartPromotionResponse',
        Progress: progressMessage(run),
        CommonResponse: commonResponse(updated),
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Activity:FinishPromotion',
  async (ctx) => {
    const player = await playerForAccount(accountOf(ctx), 'Activity:FinishPromotion');
    return withPlayerTx(player.id, async (tx) => {
      const state = await loadState(player.id, tx);
      const run = requireRun(state);
      const now = Date.now();
      const characters = await advancePromotion(player.id, run, now, tx);
      const settled = await settlePromotionRewards(player.id, run, state, characters, true, tx);
      state.Run = null;
      await saveState(player.id, state, tx);
      return {
        __msg: 'Solis.Common.Proto.Api.ActivityFinishPromotionResponse',
        Rewards: settled.rewards,
        BonusRewards: [],
        ActivityLevelProgress: settled.levelProgress,
        TotalSteps: run.CompletedStep,
        Characters: run.Characters.map(
          (c) =>
            ({
              __msg: ACTIVITY_CHARACTER_INFO_MSG,
              CharacterId: c.CharacterId,
              CostumeId: c.CostumeId,
              HairId: c.HairId,
            }) as Decoded,
        ),
        CampaignEffects: effectsMessage(run.CampaignEffects as never),
        CampaignDropRewards: [],
        CommonResponse: commonResponse(settled.updated),
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Activity:ReceivePromotionReward',
  async (ctx) => {
    const player = await playerForAccount(accountOf(ctx), 'Activity:ReceivePromotionReward');
    return withPlayerTx(player.id, async (tx) => {
      const state = await loadState(player.id, tx);
      const run = requireRun(state);
      const characters = await advancePromotion(player.id, run, Date.now(), tx);
      const settled = await settlePromotionRewards(player.id, run, state, characters, false, tx);
      await saveState(player.id, state, tx);
      return {
        __msg: 'Solis.Common.Proto.Api.ActivityReceivePromotionRewardResponse',
        Rewards: settled.rewards,
        BonusRewards: [],
        CompletedStep: run.CompletedStep,
        Progress: progressMessage(run),
        CampaignEffects: effectsMessage(run.CampaignEffects as never),
        CampaignDropRewards: [],
        CommonResponse: commonResponse(settled.updated),
      } as Decoded;
    });
  },
  { ownsState: true },
);

register(
  'Activity:UsePromotionItem',
  async (ctx) => {
    const req = ctx.request;
    if (!req || !req.ItemId || Number(req.Amount ?? 0) <= 0) {
      throw new Error('a positive promotion item amount is required');
    }
    const itemId = String(req.ItemId);
    const amount = Number(req.Amount);
    const player = await playerForAccount(accountOf(ctx), 'Activity:UsePromotionItem');
    return withPlayerTx(player.id, async (tx) => {
      const state = await loadState(player.id, tx);
      const run = requireRun(state);

      const item = await getItem(itemId);
      const itemType = Number(item?.Type ?? 0);
      if (itemType !== ITEM_TYPE_PROMOTION_SHORTEN && itemType !== ITEM_TYPE_PROMOTION_SPECIAL_SHORTEN) {
        throw new Error(`item "${itemId}" cannot shorten promotions`);
      }
      const value = Number(item?.Value ?? 0);
      if (value <= 0) throw new Error('promotion item has no shortening value');
      if ((await getItemAmount(player.id, itemId, tx)) < amount) {
        throw new Error('promotion shortening item is insufficient');
      }
      const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
      await spendItem(player.id, itemId, amount, tx);
      updated.Items = [
        {
          __msg: 'Solis.Common.Proto.Transaction.UserItem',
          ItemId: itemId,
          Amount: (await getItemAmount(player.id, itemId, tx)),
        } as Decoded,
      ];

      const minutes = value * amount;
      if (minutes > Math.floor(Number.MAX_SAFE_INTEGER / 60_000)) {
        throw new Error('shortening duration overflows');
      }
      const shortened = minutes * 60_000;
      if (run.StartTime < -Number.MAX_SAFE_INTEGER + shortened || run.FinishTime < -Number.MAX_SAFE_INTEGER + shortened) {
        throw new Error('promotion shortening overflows');
      }
      run.StartTime -= shortened;
      run.FinishTime -= shortened;
      await advancePromotion(player.id, run, Date.now(), tx);
      if (!state.Run) throw new Error('active promotion summary is missing');
      state.Run.FinishTime = run.FinishTime;
      await saveState(player.id, state, tx);

      return {
        __msg: 'Solis.Common.Proto.Api.ActivityUsePromotionItemResponse',
        Progress: progressMessage(run),
        CommonResponse: commonResponse(updated),
      } as Decoded;
    });
  },
  { ownsState: true },
);

/**
 * The home screen's Promotion slot (`Home:Enter` PromotionInfo.ActivePromotion)
 * for the player's own run, or null when no promotion is running.
 */
async function activePromotionForHome(playerId: string, exec: Executor): Promise<Decoded | null> {
  const run = (await loadState(playerId, exec)).Run;
  if (!run) return null;
  return {
    __msg: ACTIVE_PROMOTION_MSG,
    CharacterIds: run.Characters.map((c) => c.CharacterId),
    Name: run.Name,
    SubName: run.SubName,
    Level: run.Level,
    FinishTime: run.FinishTime,
    CampaignEffects: run.CampaignEffects,
  } as Decoded;
}

export { activePromotionForHome, findPerformanceForPromotion };
