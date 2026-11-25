import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';

/** A foreign-key column pointing at one of the tables swept below. */
interface ForeignKeyColumn {
  tbl: string;
  col: string;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Rows of every foreign key that references `table`, as (table, column) pairs.
 * The keys are read from `pg_constraint` at run time rather than listed here:
 * the tests keep gaining per-player tables (`reward_claims`, decks, gacha
 * state, …), and a hand-written list would silently start failing on a foreign
 * key — leaking the account — the moment a new table is added. Discovering them
 * makes `delete from players` succeed for tables that did not exist when this
 * helper was written.
 */
/** `in (...)` over bound parameters; drizzle would expand a bare array the same way. */
function idList(ids: string[]) {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

async function foreignKeysTo(tx: Transaction, table: string): Promise<ForeignKeyColumn[]> {
  const rows = await tx.execute(sql`
    select conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and c.confrelid = ${table}::regclass
  `);
  return rows as unknown as ForeignKeyColumn[];
}

/**
 * Delete every row the database tests created for `playerIds`/`accountIds`, in
 * one transaction: first the rows that reference `players`, then the players,
 * then the rows that reference `accounts` (except `players`, already gone), and
 * finally the accounts. Errors are never swallowed here — a leftover player row
 * surfaces as the foreign-key violation it is.
 */
export async function deleteTestPlayers(
  playerIds: string[],
  accountIds: string[],
): Promise<void> {
  if (playerIds.length === 0 && accountIds.length === 0) return;
  await db.transaction(async (tx) => {
    if (playerIds.length > 0) {
      for (const { tbl, col } of await foreignKeysTo(tx, 'players')) {
        if (tbl === 'players') continue;
        await tx.execute(
          sql`delete from ${sql.identifier(tbl)} where ${sql.identifier(col)} in ${idList(playerIds)}`,
        );
      }
      await tx.execute(sql`delete from players where id in ${idList(playerIds)}`);
    }
    if (accountIds.length > 0) {
      await tx.execute(sql`delete from players where account_id in ${idList(accountIds)}`);
      for (const { tbl, col } of await foreignKeysTo(tx, 'accounts')) {
        if (tbl === 'players') continue;
        await tx.execute(
          sql`delete from ${sql.identifier(tbl)} where ${sql.identifier(col)} in ${idList(accountIds)}`,
        );
      }
      await tx.execute(sql`delete from accounts where id in ${idList(accountIds)}`);
    }
  });
}

/** A missing database must not fail cleanup; any other error must. */
export function isDatabaseUnreachable(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ECONNREFUSED'
  ) {
    return true;
  }
  return error instanceof Error && error.message.toLowerCase().includes('connect');
}
