/**
 * `account_credentials` access: link password hash and the single pending
 * one-time transfer token. Shared by the Migration RPCs, the invite page, the
 * admin API and the CLI scripts.
 */
import { and, eq, gt } from 'drizzle-orm';
import { db } from './client.ts';
import { accountCredentials } from './schema.ts';
import type { Executor } from './tx.ts';

export type CredentialRow = typeof accountCredentials.$inferSelect;

export async function getCredentials(
  accountId: string,
  executor: Executor = db,
): Promise<CredentialRow | undefined> {
  const [row] = await executor
    .select()
    .from(accountCredentials)
    .where(eq(accountCredentials.accountId, accountId))
    .limit(1);
  return row;
}

/**
 * Set (or replace) the link password and drop any pending transfer token: a
 * password change invalidates a token minted against the old password.
 */
export async function upsertPassword(
  accountId: string,
  passwordHash: string,
  executor: Executor = db,
): Promise<void> {
  const now = new Date();
  await executor
    .insert(accountCredentials)
    .values({ accountId, passwordHash, updatedAt: now })
    .onConflictDoUpdate({
      target: accountCredentials.accountId,
      set: {
        passwordHash,
        onetimeTokenHash: null,
        onetimeExpiresAt: null,
        onetimeTargetUid: null,
        updatedAt: now,
      },
    });
}

/** Record a one-time token (already hashed) for `Migration:Execute`. */
export async function setOnetimeToken(
  accountId: string,
  tokenHash: string,
  expiresAt: Date,
  targetUid?: string | null,
  executor: Executor = db,
): Promise<void> {
  await executor
    .update(accountCredentials)
    .set({
      onetimeTokenHash: tokenHash,
      onetimeExpiresAt: expiresAt,
      onetimeTargetUid: targetUid ?? null,
      updatedAt: new Date(),
    })
    .where(eq(accountCredentials.accountId, accountId));
}

/** Look up the account whose pending one-time token matches and has not expired. */
export async function getCredentialsByOnetimeHash(
  tokenHash: string,
  now: Date,
  executor: Executor = db,
): Promise<CredentialRow | undefined> {
  const [row] = await executor
    .select()
    .from(accountCredentials)
    .where(
      and(
        eq(accountCredentials.onetimeTokenHash, tokenHash),
        gt(accountCredentials.onetimeExpiresAt, now),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Atomically consume the token: the UPDATE is conditional on the hash still
 * matching, so two concurrent `Migration:Execute` calls cannot both succeed.
 */
export async function consumeOnetimeToken(
  accountId: string,
  tokenHash: string,
  now: Date,
  executor: Executor = db,
): Promise<boolean> {
  const rows = await executor
    .update(accountCredentials)
    .set({
      onetimeTokenHash: null,
      onetimeExpiresAt: null,
      onetimeTargetUid: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(accountCredentials.accountId, accountId),
        eq(accountCredentials.onetimeTokenHash, tokenHash),
        gt(accountCredentials.onetimeExpiresAt, now),
      ),
    )
    .returning({ accountId: accountCredentials.accountId });
  return rows.length > 0;
}
