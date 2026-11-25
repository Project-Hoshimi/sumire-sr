// `UpdatedData` merging shared by the race handlers: reward helpers return their
// own `UpdatedData` slice, and every race response carries a single
// `CommonResponse.UpdatedData` the client replays row by row.
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import type { Executor } from '../../db/tx.ts';
import { applyGrants } from '../../master/reward.ts';
import { getItemAmount } from '../inventory.ts';
import { pushUpdated } from '../quest.ts';
import type { RaceConfig } from './types.ts';

const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';

/** Copies the arrays of `source` into `target`, appending to existing arrays. */
export function mergeUpdated(target: Decoded, source: Decoded | null): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (key === '__msg') continue;
    if (Array.isArray(value)) {
      for (const row of value) pushUpdated(target, key, row as Decoded);
    } else if (value !== null && value !== undefined) {
      target[key] = value as never;
    }
  }
}

/** `Transaction.Reward` row for an item grant (`ResourceType` 1 = Item). */
export function itemReward(itemId: string, amount: number): Decoded {
  return {
    __msg: 'Solis.Common.Proto.Transaction.Reward',
    ResourceType: 1,
    ResourceId: itemId,
    Amount: amount,
  } as Decoded;
}

/**
 * Write the player's *absolute* amount of `itemId` into
 * `CommonResponse.UpdatedData.Items`, replacing any row for the same item.
 *
 * Grants (`applyGrants`) already append their own after-amounts, so a handler
 * that both spends and grants the same item calls this last: it re-reads the
 * store and leaves a single authoritative row (`compactUpdated` keeps the first
 * row per `ItemId`, so a stale spend row would otherwise win).
 */
export function mergeItemAmount(updated: Decoded, itemId: string, amount: number): void {
  if (itemId === '') return;
  const rows = Array.isArray(updated.Items) ? (updated.Items as Decoded[]) : [];
  const kept = rows.filter((row) => String(row.ItemId ?? '') !== itemId);
  kept.push({ __msg: USER_ITEM_MSG, ItemId: itemId, Amount: amount } as Decoded);
  updated.Items = kept as Decoded;
}

/** Re-read `itemId` after a spend/grant and report its absolute amount. */
export async function pushItemAmount(
  playerId: string,
  updated: Decoded,
  itemId: string,
  exec: Executor,
): Promise<void> {
  if (itemId === '') return;
  mergeItemAmount(updated, itemId, await getItemAmount(playerId, itemId, exec));
}

/**
 * One-off starting race points, granted the first time a player's race state
 * is created. Merges the granted item rows into `updated` (the caller's
 * `CommonResponse.UpdatedData`) and returns the reward rows for responses that
 * carry `Rewards` (`Race:ReceiveActivityLesson`). Callers must save the state
 * afterwards; `Race:Top` has no `Rewards` field, so it only keeps `updated`.
 */
export async function grantInitialRacePoints(
  playerId: string,
  config: RaceConfig,
  updated: Decoded,
  exec: Executor,
): Promise<Decoded[]> {
  const amount = Math.max(0, Math.trunc(config.initialRacePointAmount ?? 0));
  if (amount === 0 || config.racePointItemId === '') return [];
  const applied = await applyGrants(
    playerId,
    [{ resourceType: 1, resourceId: config.racePointItemId, amount }],
    exec,
  );
  mergeUpdated(updated, applied.updated);
  return [itemReward(config.racePointItemId, amount)];
}
