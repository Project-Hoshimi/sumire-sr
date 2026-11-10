import { getConsumption } from '../master/index.ts';
import { db } from '../db/client.ts';
import { getCurrency, spendCurrency } from './currency.ts';
import { getAccessoryAmount, getItemAmount, spendAccessory, spendItem } from './inventory.ts';
import { type Executor } from '../db/tx.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const CONSUMPTION_RESULT_MSG = 'Solis.Common.Proto.Transaction.ConsumptionResult';

const RESOURCE_ITEM = 1;
const RESOURCE_ACCESSORY = 3;
const RESOURCE_GOLD = 8;
const RESOURCE_STONE = 15;
const RESOURCE_PAID_STONE = 16;

/**
 * Spend the resources described by a master `Consumption` row `execCount` times.
 * Stone costs drain free jewels first, then paid jewels. Returns one
 * ConsumptionResult per spent resource for the response's UpdatedData.
 */
export async function consume(
  playerId: string,
  consumptionId: unknown,
  execCount: number,
  tx: Executor,
): Promise<Decoded[]> {
  if (!consumptionId) return [];
  const consumption = await getConsumption(String(consumptionId));
  if (!consumption) return [];
  const resources = ((consumption.Resources as Decoded[] | null) ?? []) as Decoded[];
  const out: Decoded[] = [];

  for (const r of resources) {
    const type = Number(r.ResourceType ?? 0);
    const amount = Number(r.Amount ?? 0) * execCount;
    const ids: string[] = Array.isArray(r.ResourceIds) ? (r.ResourceIds as string[]) : [];
    if (!type || amount <= 0) continue;

    if (type === RESOURCE_STONE || type === RESOURCE_PAID_STONE) {
      const free = type === RESOURCE_STONE ? await getCurrency(playerId, 'freeJewel', tx) : 0;
      let remaining = amount;
      if (free >= remaining) {
        await spendCurrency(playerId, 'freeJewel', remaining, tx);
        out.push(consumptionResult(type, '', amount, free, free - amount));
      } else {
        await spendCurrency(playerId, 'freeJewel', free, tx);
        remaining -= free;
        const paid = await getCurrency(playerId, 'paidJewel', tx);
        await spendCurrency(playerId, 'paidJewel', remaining, tx);
        out.push(consumptionResult(RESOURCE_STONE, '', amount, free + paid, free + paid - amount));
      }
    } else if (type === RESOURCE_GOLD) {
      const before = await getCurrency(playerId, 'gold', tx);
      await spendCurrency(playerId, 'gold', amount, tx);
      out.push(consumptionResult(type, '', amount, before, before - amount));
    } else if (type === RESOURCE_ITEM) {
      for (const id of ids.length ? ids : ['']) {
        const before = await getItemAmount(playerId, id, tx);
        await spendItem(playerId, id, amount, tx);
        out.push(consumptionResult(type, id, amount, before, before - amount));
      }
    } else if (type === RESOURCE_ACCESSORY) {
      for (const id of ids.length ? ids : ['']) {
        const before = await getAccessoryAmount(playerId, id, tx);
        await spendAccessory(playerId, id, amount, tx);
        out.push(consumptionResult(type, id, amount, before, before - amount));
      }
    }
  }
  return out;
}

/**
 * True when the consumption actually moved a stone balance (free or paid).
 * Callers use this to attach `UpdatedData.Balance` to the response so the
 * client learns the post-spend values instead of keeping a stale balance.
 */
export function consumptionSpendsStones(results: Decoded[]): boolean {
  return results.some((r) => {
    const type = Number(r.ResourceType ?? 0);
    return type === RESOURCE_STONE || type === RESOURCE_PAID_STONE;
  });
}

export function consumptionResult(
  type: number,
  resourceId: string,
  amount: number,
  before: number,
  after: number,
): Decoded {
  return {
    __msg: CONSUMPTION_RESULT_MSG,
    ResourceType: type,
    ...(resourceId ? { ResourceId: resourceId } : {}),
    Amount: amount,
    BeforeAmount: before,
    AfterAmount: after,
  } as Decoded;
}

const USER_ITEM_MSG = 'Solis.Common.Proto.Transaction.UserItem';
const USER_POINT_MSG = 'Solis.Common.Proto.Transaction.UserPoint';
const USER_ACCESSORY_MSG = 'Solis.Common.Proto.Transaction.UserAccessory';

/**
 * Convert `ConsumptionResult[]` into `UpdatedData` entries so a handler that
 * spends master-defined resources can echo the post-spend amounts (items,
 * accessory counts, gold points). Stone balances are intentionally not covered
 * here — callers that spend stones build their own `Balance` slice.
 */
export function consumptionUpdatedData(results: Decoded[]): Array<[string, unknown]> {
  const items: Decoded[] = [];
  const points: Decoded[] = [];
  const accessories: Decoded[] = [];
  for (const r of results) {
    const type = Number(r.ResourceType ?? 0);
    const id = r.ResourceId == null ? '' : String(r.ResourceId);
    const after = Number(r.AfterAmount ?? 0);
    if (type === RESOURCE_ITEM) items.push({ __msg: USER_ITEM_MSG, ItemId: id, Amount: after } as Decoded);
    else if (type === RESOURCE_ACCESSORY) {
      accessories.push({ __msg: USER_ACCESSORY_MSG, AccessoryId: id, Amount: after } as Decoded);
    } else if (type === RESOURCE_GOLD) {
      points.push({ __msg: USER_POINT_MSG, PointType: 1, Amount: after } as Decoded);
    }
  }
  const out: Array<[string, unknown]> = [];
  if (items.length) out.push(['Items', items]);
  if (accessories.length) out.push(['Accessories', accessories]);
  if (points.length) out.push(['Points', points]);
  return out;
}

/** Identity field per `UpdatedData` collection produced by `consumptionUpdatedData`. */
const UPDATE_KEY_FIELD: Record<string, string> = {
  Items: 'ItemId',
  Accessories: 'AccessoryId',
  Points: 'PointType',
};

/**
 * Merge the post-spend amounts of `consumptionResults` into an existing
 * `UpdatedData` object, by identity key. Items are re-read from the store after
 * the whole operation, so a resource that is both spent and granted by the same
 * request (e.g. a ticket draw whose rewards also contain tickets) reports its
 * true final amount instead of whichever list happened to be written last.
 * Entries already present in `updated` (grants, other deltas) are kept and
 * merged, so the caller can call this at the end of the handler.
 */
export async function mergeConsumptionUpdatedData(
  playerId: string,
  updated: Decoded,
  results: Decoded[],
  exec: Executor = db,
): Promise<Decoded> {
  for (const [field, value] of consumptionUpdatedData(results)) {
    const keyField = UPDATE_KEY_FIELD[field];
    const incoming = (value as Decoded[]) ?? [];
    const merged = new Map<string, Decoded>();
    for (const el of ((updated[field] as Decoded[] | undefined) ?? [])) {
      merged.set(String(el[keyField]), el);
    }
    for (const el of incoming) {
      const key = String(el[keyField]);
      const amount =
        field === 'Items' ? await getItemAmount(playerId, key, exec) : Number(el.Amount ?? 0);
      const prev = merged.get(key);
      merged.set(key, {
        ...(prev ?? { __msg: el.__msg }),
        [keyField]: el[keyField],
        Amount: amount,
      } as Decoded);
    }
    updated[field] = [...merged.values()];
  }
  return updated;
}
