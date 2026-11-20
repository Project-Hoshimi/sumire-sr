/**
 * Pure live-bonus helpers for the Marathon event.
 *
 * Reward boxes hand out live bonuses by id (master `MarathonLiveBonusGroup` row)
 * and ownership lives in the marathon state singleton (`liveBonuses`), keyed by
 * live-bonus id. Everything here takes that state explicitly and never touches
 * the database.
 */
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import type { MarathonState } from './state.ts';

const LIVE_BONUS_INFO_MSG = 'Solis.Common.Proto.Api.MarathonLiveBonusInfo';

/**
 * Pick one id from `ids` using `rng` (which returns [0, 1)). A `null` list is
 * impossible by type; an empty list yields `null`. Values at or above 1 are
 * clamped to the last id instead of returning `undefined`.
 */
export function pickLiveBonusId(ids: readonly string[], rng: () => number): string | null {
  if (ids.length === 0) return null;
  const index = Math.min(Math.floor(rng() * ids.length), ids.length - 1);
  return ids[index];
}

/** Add `amount` copies of `liveBonusId` to the player's owned live bonuses. */
export function addLiveBonus(state: MarathonState, liveBonusId: string, amount = 1): void {
  const owned = (state.liveBonuses ??= {});
  owned[liveBonusId] = (owned[liveBonusId] ?? 0) + amount;
}

/**
 * `MarathonLiveBonusInfo` list for the client, one entry per owned live bonus
 * with a positive amount, sorted by `LiveBonusId`.
 */
export function liveBonusInfos(state: MarathonState): Decoded[] {
  return Object.entries(state.liveBonuses ?? {})
    .filter(([, amount]) => amount > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([LiveBonusId, Amount]) =>
        ({ __msg: LIVE_BONUS_INFO_MSG, LiveBonusId, Amount }) as Decoded,
    );
}
