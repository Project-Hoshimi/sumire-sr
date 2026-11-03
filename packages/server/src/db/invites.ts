/**
 * `invites` access: create / list / revoke links and consume one use inside the
 * caller's transaction. Only the SHA-256 of the token is stored; the plaintext
 * token exists just long enough to print the URL.
 */
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db } from './client.ts';
import { invites } from './schema.ts';
import type { Executor } from './tx.ts';
import { randomToken, sha256Hex } from '../auth/passwords.ts';

export type InviteRow = typeof invites.$inferSelect;

export type InviteOptions = {
  maxUses?: number;
  expiresAt?: Date | null;
  note?: string | null;
};

/** Create an invite and return the plaintext token exactly once. */
export async function createInvite(
  opts: InviteOptions = {},
  executor: Executor = db,
): Promise<{ invite: InviteRow; token: string }> {
  const token = randomToken();
  const [invite] = await executor
    .insert(invites)
    .values({
      tokenHash: sha256Hex(token),
      maxUses: opts.maxUses ?? 1,
      expiresAt: opts.expiresAt ?? null,
      note: opts.note ?? null,
    })
    .returning();
  return { invite, token };
}

/** Newest first; the admin API maps these rows to a hash-free JSON shape. */
export async function listInvites(executor: Executor = db): Promise<InviteRow[]> {
  return executor.select().from(invites).orderBy(desc(invites.id));
}

export async function findInviteByToken(
  token: string,
  executor: Executor = db,
): Promise<InviteRow | undefined> {
  const [row] = await executor
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, sha256Hex(token)))
    .limit(1);
  return row;
}

/** A link is usable while it is not revoked, not expired and has uses left. */
export function isInviteUsable(invite: InviteRow, now: Date = new Date()): boolean {
  if (invite.revokedAt) return false;
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) return false;
  return invite.uses < invite.maxUses;
}

/**
 * Increment `uses` only if the link is still usable. Returns false when a
 * concurrent request already consumed the last use (or the link was revoked).
 */
export async function consumeInvite(
  id: number,
  now: Date,
  executor: Executor = db,
): Promise<boolean> {
  const rows = await executor
    .update(invites)
    .set({ uses: sql`${invites.uses} + 1` })
    .where(
      and(
        eq(invites.id, id),
        sql`${invites.uses} < ${invites.maxUses}`,
        isNull(invites.revokedAt),
        or(isNull(invites.expiresAt), gt(invites.expiresAt, now)),
      ),
    )
    .returning({ id: invites.id });
  return rows.length > 0;
}

/** Revoke an invite; already-revoked links report false. */
export async function revokeInvite(id: number, executor: Executor = db): Promise<boolean> {
  const rows = await executor
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, id), isNull(invites.revokedAt)))
    .returning({ id: invites.id });
  return rows.length > 0;
}
