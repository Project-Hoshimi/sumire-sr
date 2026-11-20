/**
 * Per-player marathon state: one JSON singleton per player per marathon, stored
 * through `playerState.ts` under the field `MarathonState:<marathonId>`.
 * `playerState` has no spec for that name, so it takes the JSON fallback path.
 */
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import type { Executor } from '../../db/tx.ts';
import { db } from '../../db/client.ts';
import { getSingleton, putSingleton } from '../playerState.ts';
import type { MarathonConfig } from './catalog.ts';
import type { BoxDrawState } from './box.ts';

export interface MarathonDifficultyState {
  cleared: boolean;
  highestScore: number;
  rankType: number;
  plus: number;
}

export interface MarathonQuestState {
  last: number;
  diffs: Record<string, MarathonDifficultyState>;
}

export interface MarathonState {
  stamina: number;
  staminaUpdatedTime: number;
  quests: Record<string, MarathonQuestState>;
  /** Per-box draw progress. Absent in state written before box gachas shipped. */
  boxes?: Record<string, BoxDrawState>;
  /**
   * Marathon quests the player paid the unlock item for, keyed by quest id.
   * Absent in state written before the item gate shipped.
   */
  unlockedQuests?: Record<string, true>;
  /**
   * Owned marathon live bonuses keyed by live-bonus id. Absent in state written
   * before box gachas could hand out live-bonus prizes.
   */
  liveBonuses?: Record<string, number>;
}

export function marathonStateField(marathonId: string): string {
  return `MarathonState:${marathonId}`;
}

/** State for a player who has never started this marathon: full stamina, no quests. */
export function emptyMarathonState(config: Pick<MarathonConfig, 'initialStamina'>, now: number): MarathonState {
  return { stamina: config.initialStamina, staminaUpdatedTime: now, quests: {} };
}

/**
 * Stamina at `now`. Recovery is whole intervals since `staminaUpdatedTime`,
 * capped at `initialStamina`. `updated` is the new base time for the recovery
 * clock: `now` when full, otherwise the time the last whole interval completed.
 * Pure: nothing is saved here.
 */
export function currentStamina(
  state: Pick<MarathonState, 'stamina' | 'staminaUpdatedTime'>,
  config: Pick<MarathonConfig, 'initialStamina' | 'staminaRecoveryMinutes'>,
  now: number,
): { stamina: number; updated: number } {
  const max = config.initialStamina;
  if (state.stamina >= max) return { stamina: state.stamina, updated: now };
  // No recovery interval configured: stamina never recovers.
  if (!(config.staminaRecoveryMinutes > 0)) return { stamina: state.stamina, updated: now };
  const intervalMs = config.staminaRecoveryMinutes * 60000;
  const recovered = Math.floor((now - state.staminaUpdatedTime) / intervalMs);
  const stamina = Math.min(max, state.stamina + recovered);
  const updated = stamina === max ? now : state.staminaUpdatedTime + recovered * intervalMs;
  return { stamina, updated };
}

/** Message of the error thrown when a stamina item is used at full stamina. */
export const ALREADY_MAX_STAMINA_MESSAGE = 'already maximum stamina';

/**
 * Stamina after spending `amount` recovery items worth `perItem` each. The last
 * item may carry stamina past `max`; no item can be used once stamina is at or
 * above `max`. Pure: nothing is saved here. Throws when the amount is not a
 * positive integer, the item has no value, stamina is already full, or the amount
 * would exceed the items that can still be used.
 */
export function applyStaminaItems(args: {
  stamina: number;
  max: number;
  perItem: number;
  amount: number;
}): { stamina: number } {
  const { stamina, max, perItem, amount } = args;
  if (!Number.isInteger(amount) || amount < 1) throw new Error('invalid amount');
  if (!(perItem > 0)) throw new Error('stamina item has no recovery value');
  if (stamina >= max) throw new Error(ALREADY_MAX_STAMINA_MESSAGE);
  const needed = Math.ceil((max - stamina) / perItem);
  if (amount > needed) throw new Error(`amount ${amount} exceeds usable ${needed}`);
  return { stamina: stamina + perItem * amount };
}

export async function loadMarathonState(
  playerId: string,
  config: MarathonConfig,
  now: number,
  exec: Executor = db,
): Promise<MarathonState> {
  const raw = await getSingleton(playerId, marathonStateField(config.id), exec);
  if (raw === null) return emptyMarathonState(config, now);
  return raw as unknown as MarathonState;
}

export async function saveMarathonState(
  playerId: string,
  marathonId: string,
  state: MarathonState,
  exec: Executor = db,
): Promise<void> {
  await putSingleton(playerId, marathonStateField(marathonId), state as unknown as Decoded, exec);
}
