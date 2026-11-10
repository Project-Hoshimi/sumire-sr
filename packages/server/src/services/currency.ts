import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Player currency helpers over the `players` row. Reads/writes are expected to
 * run inside `withPlayerTx`, which locks the row `FOR UPDATE`, so a
 * read-modify-write is safe against concurrent requests.
 */

export type Currency = 'gold' | 'freeJewel' | 'paidJewel' | 'stamina';

const COLUMNS = {
  gold: players.gold,
  freeJewel: players.freeJewel,
  paidJewel: players.paidJewel,
  stamina: players.stamina,
} as const;

async function readColumn(playerId: string, type: Currency, exec: Executor): Promise<number> {
  const [row] = await exec
    .select({ value: COLUMNS[type] })
    .from(players)
    .where(eq(players.id, playerId))
    .limit(1);
  return Number(row?.value ?? 0);
}

export async function getCurrency(
  playerId: string,
  type: Currency,
  exec: Executor = db,
): Promise<number> {
  return readColumn(playerId, type, exec);
}

export async function grantCurrency(
  playerId: string,
  type: Currency,
  amount: number,
  exec: Executor = db,
): Promise<void> {
  if (amount <= 0) return;
  const next = (await readColumn(playerId, type, exec)) + amount;
  await exec.update(players).set({ [type]: next }).where(eq(players.id, playerId));
}

export async function spendCurrency(
  playerId: string,
  type: Currency,
  amount: number,
  exec: Executor = db,
): Promise<void> {
  if (amount <= 0) return;
  const current = await readColumn(playerId, type, exec);
  if (current < amount) {
    throw new Error(`insufficient ${type}: have ${current}, need ${amount}`);
  }
  await exec.update(players).set({ [type]: current - amount }).where(eq(players.id, playerId));
}

const USER_BALANCE_MSG = 'Solis.Common.Proto.Transaction.UserBalance';

/**
 * Spend stones, draining free jewels before paid. Throws (leaving the caller's
 * transaction to roll back) when the combined balance is short. Returns the
 * post-spend `UserBalance` slice for `UpdatedData.Balance`.
 */
export async function spendStone(
  playerId: string,
  amount: number,
  exec: Executor = db,
): Promise<Decoded> {
  const free = await readColumn(playerId, 'freeJewel', exec);
  let remaining = amount;
  if (free >= remaining) {
    await spendCurrency(playerId, 'freeJewel', remaining, exec);
  } else {
    await spendCurrency(playerId, 'freeJewel', free, exec);
    remaining -= free;
    await spendCurrency(playerId, 'paidJewel', remaining, exec);
  }
  const freeAfter = await readColumn(playerId, 'freeJewel', exec);
  const paidAfter = await readColumn(playerId, 'paidJewel', exec);
  return { __msg: USER_BALANCE_MSG, FreeBalance: freeAfter, PaidBalance: paidAfter } as Decoded;
}
