import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from './client.ts';
import { rewardClaims } from './schema.ts';
import type { Executor } from './tx.ts';

export async function alreadyClaimed(
  playerId: string,
  sourceType: string,
  sourceId: string,
  exec: Executor = db,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: rewardClaims.id })
    .from(rewardClaims)
    .where(
      and(
        eq(rewardClaims.playerId, playerId),
        eq(rewardClaims.sourceType, sourceType),
        eq(rewardClaims.sourceId, sourceId),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Record a claim; returns `true` if this call won it, `false` if it was already
 * claimed. Relies on the unique index so concurrent calls cannot both win.
 */
export async function claimOnce(
  playerId: string,
  sourceType: string,
  sourceId: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .insert(rewardClaims)
    .values({ id: randomUUID(), playerId, sourceType, sourceId })
    .onConflictDoNothing()
    .returning({ id: rewardClaims.id });
  return rows.length > 0;
}
