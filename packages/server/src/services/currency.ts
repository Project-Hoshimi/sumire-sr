import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';

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
