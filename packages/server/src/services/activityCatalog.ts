import '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_FanEventInfo.ts';
import '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_RefreshInfo.ts';
import type { Executor } from '../db/tx.ts';
import type { ConditionEvaluator } from './conditions.ts';
import { getSingleton, putSingleton } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Port of Solis `viber/activity_catalog.go` plus the fan-event and refresh
 * defaults from `makino/consts/activity_defaults.go`. Home:Enter shows each
 * player's own activity catalogs, unlocked by their condition progress.
 * Fan-event and refresh runs are not ported, so these catalogs never carry an
 * active run.
 */

const FAN_EVENT_INFO_MSG = 'Solis.Common.Proto.Api.FanEventInfo';
const FAN_EVENT_MSG = 'Solis.Common.Proto.Api.FanEvent';
const REFRESH_INFO_MSG = 'Solis.Common.Proto.Api.RefreshInfo';
const REFRESH_MSG = 'Solis.Common.Proto.Api.Refresh';
const REFRESH_LEVEL_MSG = 'Solis.Common.Proto.Api.RefreshLevel';
const FAN_EVENT_FIELD = 'ActivityFanEventInfo';
const REFRESH_FIELD = 'ActivityRefreshInfo';
const EFFECT_REFRESH_GOLD_CONSUMPTION_DOWN = 3001;

function fanEvent(
  id: string, name: string, type: number, unlock: string, performance: string,
  nextExp: number, stamina: number, nextUnlock: string, stepStamina: number,
): Decoded {
  return {
    __msg: FAN_EVENT_MSG,
    Id: id,
    Name: name,
    SubName: name,
    Type: type,
    UnlockConditionId: unlock,
    ActivityPerformanceId: performance,
    Level: 1,
    NextLevelRequiredExp: nextExp,
    RequiredStamina: stamina,
    NextLevelUnlockConditionId: nextUnlock,
    StepConsumptionStamina: stepStamina,
    FixedRewardId: `rd-${id}-lv1`,
    CampaignDropRewardIds: [],
    IsUnlocked: false,
    IsNextLevelUnlocked: false,
  } as Decoded;
}

/** Solis `GetUserInitialFanEventInfo`. */
function initialFanEventInfo(): Decoded {
  return {
    __msg: FAN_EVENT_INFO_MSG,
    FanEvents: [
      fanEvent('act-fan-01', '握手会', 1, 'cd-clear-area-main-007', 'handshake-stage-1', 800, 600, 'cd-clear-area-main-008', 8),
      fanEvent('act-fan-02', '撮影会', 3, 'cd-clear-area-main-010', 'photo-session-stage-1', 2392, 800, 'cd-clear-area-main-012', 7),
      fanEvent('act-fan-03', 'サイン会', 2, 'cd-clear-area-main-015', 'sign-stage-1', 8000, 1000, 'cd-clear-area-main-018', 5),
    ],
  } as Decoded;
}

function refreshLevel(
  level: number, name: string, gold: number, unlock: string, performance: string, recovery: number, subGenre: string,
): Decoded {
  return {
    __msg: REFRESH_LEVEL_MSG,
    Level: level,
    Name: name,
    RequiredGold: gold,
    UnlockConditionId: unlock,
    ActivityPerformanceId: performance,
    RecoveryAmount: recovery,
    SubGenre: subGenre,
    IsUnlocked: false,
  } as Decoded;
}

/** Solis `GetUserInitialRefreshInfo`. */
function initialRefreshInfo(): Decoded {
  return {
    __msg: REFRESH_INFO_MSG,
    Refreshes: [
      {
        __msg: REFRESH_MSG,
        Id: 'act-ref-01',
        Name: '休息',
        RequiredMinutes: 120,
        UnlockConditionId: 'cd-clear-area-main-009',
        Level: 1,
        NextLevelRequiredExp: 1,
        Levels: [
          refreshLevel(1, 'カフェ', 60000, '', 'cafe', 1000, 'cafe'),
          refreshLevel(2, 'ショッピング', 210000, 'cd-clear-area-main-021', 'shopping', 1800, 'shopping'),
        ],
        IsUnlocked: false,
      },
      {
        __msg: REFRESH_MSG,
        Id: 'act-ref-02',
        Name: '休暇',
        RequiredMinutes: 480,
        UnlockConditionId: 'cd-clear-area-main-014',
        Level: 1,
        NextLevelRequiredExp: 1,
        Levels: [
          refreshLevel(1, '寮で過ごす', 130000, '', 'dormitory', 2500, 'dormitory'),
          refreshLevel(2, 'テーマパーク', 360000, 'cd-clear-area-main-026', 'theme_park', 3800, 'theme-park'),
        ],
        IsUnlocked: false,
      },
    ],
  } as Decoded;
}

/** Solis `activityConditionUnlock`: unlocks are sticky. */
export async function activityConditionUnlock(
  evaluator: ConditionEvaluator,
  alreadyUnlocked: boolean,
  conditionId: string,
  hasTarget: boolean,
): Promise<boolean> {
  if (alreadyUnlocked || !hasTarget) return alreadyUnlocked;
  return evaluator.satisfied(conditionId);
}

/** Solis `pruneActivityCampaignEffects`: drop expired effects. */
export function pruneActivityCampaignEffects(info: Decoded, now: number): boolean {
  const effects = (info.CampaignEffects as Decoded[] | undefined) ?? [];
  if (effects.length === 0) return false;
  const live = effects.filter((e) => e && Number(e.EndTime ?? 0) > now);
  if (live.length === effects.length) return false;
  info.CampaignEffects = live;
  return true;
}

/**
 * Shared body of Solis `ReconcileFanEventInfo` / `ReconcilePromotionInfo`:
 * refresh each entry's unlock and next-level unlock flags.
 */
export async function reconcileLevelledCatalog(
  info: Decoded,
  entries: Decoded[],
  now: number,
  evaluator: ConditionEvaluator,
): Promise<boolean> {
  let changed = pruneActivityCampaignEffects(info, now);
  for (const entry of entries) {
    if (!entry) continue;
    const unlocked = await activityConditionUnlock(evaluator, !!entry.IsUnlocked, String(entry.UnlockConditionId ?? ''), true);
    if (unlocked !== !!entry.IsUnlocked) {
      entry.IsUnlocked = unlocked;
      changed = true;
    }
    const nextUnlockId = String(entry.NextLevelUnlockConditionId ?? '');
    const hasNext = Number(entry.NextLevelRequiredExp ?? 0) > 0 || nextUnlockId !== '';
    const nextUnlocked = await activityConditionUnlock(evaluator, !!entry.IsNextLevelUnlocked, nextUnlockId, hasNext);
    if (nextUnlocked !== !!entry.IsNextLevelUnlocked) {
      entry.IsNextLevelUnlocked = nextUnlocked;
      changed = true;
    }
  }
  return changed;
}

/** Solis `ReconcileFanEventInfo` plus `activityFanEventInfoForResponse`. */
export async function fanEventInfoForHome(
  playerId: string,
  now: number,
  evaluator: ConditionEvaluator,
  exec: Executor,
): Promise<Decoded> {
  const stored = await getSingleton(playerId, FAN_EVENT_FIELD, exec);
  const info = stored ?? initialFanEventInfo();
  const changed = await reconcileLevelledCatalog(info, (info.FanEvents as Decoded[] | undefined) ?? [], now, evaluator);
  if (changed || !stored) await putSingleton(playerId, FAN_EVENT_FIELD, info, exec);
  // not ported: reconcileActiveFanEventForHome (fan-event runs are not ported).
  const projected = structuredClone(info);
  if (projected.ActiveFanEvent) projected.FanEvents = [];
  return projected;
}

/** Solis `ActivityRefreshGoldCost`. */
function refreshGoldCost(base: number, effects: Decoded[]): number {
  let cost = base;
  for (const effect of effects) {
    if (Number(effect.Type ?? 0) !== EFFECT_REFRESH_GOLD_CONSUMPTION_DOWN) continue;
    const value = Number(effect.Value ?? 0);
    if (value < 0 || value > 1000) throw new Error('refresh gold campaign coefficient is invalid');
    cost = Math.trunc((cost * value) / 1000);
  }
  return cost;
}

/** Solis `ReconcileRefreshInfo` plus `activityRefreshInfoForResponse`. */
export async function refreshInfoForHome(
  playerId: string,
  now: number,
  evaluator: ConditionEvaluator,
  exec: Executor,
): Promise<Decoded> {
  const stored = await getSingleton(playerId, REFRESH_FIELD, exec);
  const info = stored ?? initialRefreshInfo();
  let changed = pruneActivityCampaignEffects(info, now);
  for (const refresh of (info.Refreshes as Decoded[] | undefined) ?? []) {
    if (!refresh) continue;
    const unlocked = await activityConditionUnlock(evaluator, !!refresh.IsUnlocked, String(refresh.UnlockConditionId ?? ''), true);
    if (unlocked !== !!refresh.IsUnlocked) {
      refresh.IsUnlocked = unlocked;
      changed = true;
    }
    for (const level of (refresh.Levels as Decoded[] | undefined) ?? []) {
      if (!level) continue;
      const levelUnlocked = await activityConditionUnlock(
        evaluator, !!level.IsUnlocked, String(level.UnlockConditionId ?? ''), !!refresh.IsUnlocked,
      );
      if (levelUnlocked !== !!level.IsUnlocked) {
        level.IsUnlocked = levelUnlocked;
        changed = true;
      }
    }
  }
  if (changed || !stored) await putSingleton(playerId, REFRESH_FIELD, info, exec);

  const projected = structuredClone(info);
  if (projected.ActiveRefresh) {
    projected.Refreshes = [];
    return projected;
  }
  const effects = (projected.CampaignEffects as Decoded[] | undefined) ?? [];
  for (const refresh of (projected.Refreshes as Decoded[] | undefined) ?? []) {
    for (const level of (refresh.Levels as Decoded[] | undefined) ?? []) {
      const cost = refreshGoldCost(Number(level.RequiredGold ?? 0), effects);
      if (cost > 0x7fffffff) throw new Error('discounted refresh price overflows');
      level.RequiredGold = cost;
    }
  }
  return projected;
}
