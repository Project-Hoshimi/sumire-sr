import { sql } from 'drizzle-orm';
import { db } from './client.ts';

/** Drizzle executor: the root db handle or an open transaction (shared subset). */
export type Executor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

/**
 * Run `fn` inside a transaction that holds a row lock on the player, so
 * concurrent requests for the same account serialise their writes.
 */
export async function withPlayerTx<T>(
  playerId: string,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from players where id = ${playerId} for update`);
    return fn(tx);
  });
}
