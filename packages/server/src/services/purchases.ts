import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import { playerPurchases } from '../db/schema.ts';

/** Current purchase count for one (player, kind, itemKey). */
export async function getPurchaseCount(
  playerId: string,
  kind: string,
  itemKey: string,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec
    .select({ count: playerPurchases.count })
    .from(playerPurchases)
    .where(
      and(
        eq(playerPurchases.playerId, playerId),
        eq(playerPurchases.kind, kind),
        eq(playerPurchases.itemKey, itemKey),
      ),
    )
    .limit(1);
  return row?.count ?? 0;
}

/** All purchase counts for a (player, kind) as a Map keyed by itemKey. */
export async function listPurchaseCounts(
  playerId: string,
  kind: string,
  exec: Executor = db,
): Promise<Map<string, number>> {
  const rows = await exec
    .select({ itemKey: playerPurchases.itemKey, count: playerPurchases.count })
    .from(playerPurchases)
    .where(and(eq(playerPurchases.playerId, playerId), eq(playerPurchases.kind, kind)));
  return new Map(rows.map((r) => [r.itemKey, r.count]));
}

/** Increment and return the new purchase count for one item. */
export async function incrementPurchase(
  playerId: string,
  kind: string,
  itemKey: string,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec
    .insert(playerPurchases)
    .values({ id: randomUUID(), playerId, kind, itemKey, count: 1 })
    .onConflictDoUpdate({
      target: [playerPurchases.playerId, playerPurchases.kind, playerPurchases.itemKey],
      set: { count: sql`${playerPurchases.count} + 1`, updatedAt: new Date() },
    })
    .returning({ count: playerPurchases.count });
  return row?.count ?? 1;
}