/**
 * Link-password migration RPCs (docs/LOGIN_FLOW.md §1).
 *
 * `MigratePassword` proves ownership of an existing account with its public id
 * (title-screen ID) + link password, and issues a short-lived one-time token.
 * `Execute` consumes that token and returns a Firebase custom token for the
 * target account, binding a fresh Firebase UID when the account has none yet
 * (accounts created through an invite link start without one).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { accounts, players } from '../db/schema.ts';
import {
  consumeOnetimeToken,
  getCredentials,
  getCredentialsByOnetimeHash,
  setOnetimeToken,
  upsertPassword,
} from '../db/credentials.ts';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  isValidLinkPassword,
  randomToken,
  sha256Hex,
  verifyPassword,
} from '../auth/passwords.ts';
import { generateFirebaseUid, mintCustomToken } from '../auth/firebaseTokens.ts';
import {
  AppRpcError,
  ERROR_ACTION,
  ERROR_CODE,
  MIGRATION_ERROR_ACTION,
} from './errors.ts';
import type { RpcContext } from './handlers.ts';
// Registers the `Solis.Common.Proto.Transaction.User` shape for LinkedUser.
import '@sumire-sr/protocol/gen/Solis_Common_Proto_Transaction_User.ts';
import { message } from '../messages.ts';

const USER_MSG = 'Solis.Common.Proto.Transaction.User';
const ONETIME_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 5;

const INVALID_CREDENTIALS_MESSAGE = message('invalidCredentials');
const OWN_ACCOUNT_MESSAGE = message('ownAccount');
const RATE_LIMITED_MESSAGE = message('rateLimited');
const EXPIRED_TOKEN_MESSAGE = message('expiredToken');
const INVALID_PASSWORD_MESSAGE = message('invalidPassword');

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Account id behind a non-guest session; undefined for guests/anonymous. */
function accountIdOf(ctx: RpcContext): string | undefined {
  if (!ctx.auth.ok) return undefined;
  const claims = ctx.auth.claims;
  if (!claims || claims.guest === true || claims.sub === 'guest') return undefined;
  return claims.sub;
}

/** Public id used in the log line; never a token or a password. */
function seedIdOf(ctx: RpcContext): string {
  const claims = ctx.auth.ok ? ctx.auth.claims : undefined;
  return (typeof claims?.seedId === 'string' && claims.seedId) || accountIdOf(ctx) || 'guest';
}

/** One line per migration RPC outcome: seed id + ok/fail reason, nothing secret. */
function logOutcome(ctx: RpcContext, seedId: string, ok: boolean, reason: string): void {
  const fields = { rpc: ctx.name, seedId, ok, reason };
  if (ok) ctx.fastifyReq.log.info(fields, 'migration rpc');
  else ctx.fastifyReq.log.warn(fields, 'migration rpc');
}

// In-memory failure window (per process): 5 failures per 15 minutes for each
// client IP and for each submitted user id. Restarting clears it, which is fine
// for a single-process private server.
const failureLog = new Map<string, number[]>();

function recentFailures(key: string, now: number): number[] {
  const recent = (failureLog.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length === 0) failureLog.delete(key);
  else failureLog.set(key, recent);
  return recent;
}

function isRateLimited(keys: string[], now: number): boolean {
  return keys.some((key) => recentFailures(key, now).length >= RATE_MAX_FAILURES);
}

function recordFailure(keys: string[], now: number): void {
  for (const key of keys) {
    const recent = recentFailures(key, now);
    recent.push(now);
    failureLog.set(key, recent);
  }
}

register('Migration:List', async (ctx) => {
  const accountId = accountIdOf(ctx);
  const credential = accountId ? await getCredentials(accountId) : undefined;
  const password = Boolean(credential);
  logOutcome(ctx, seedIdOf(ctx), true, password ? 'password-present' : 'password-absent');
  return {
    Apple: false,
    Google: false,
    Facebook: false,
    Twitter: false,
    Password: password,
  };
});

register('Migration:SetPassword', async (ctx) => {
  const accountId = accountIdOf(ctx);
  if (!accountId) {
    // Guests have no account to attach a password to.
    logOutcome(ctx, seedIdOf(ctx), false, 'guest');
    throw new AppRpcError(ERROR_CODE.UNAUTHENTICATED, ERROR_ACTION.TITLE, 'unauthenticated');
  }
  const password = str(ctx.request?.Password);
  if (!isValidLinkPassword(password)) {
    logOutcome(ctx, seedIdOf(ctx), false, 'invalid-password-format');
    throw new AppRpcError(ERROR_CODE.PASSWORD_INVALID, MIGRATION_ERROR_ACTION, INVALID_PASSWORD_MESSAGE);
  }
  // Upserting also drops any pending one-time token (old password is void).
  await upsertPassword(accountId, hashPassword(password));
  logOutcome(ctx, seedIdOf(ctx), true, 'password-set');
  return {};
});

register('Migration:MigratePassword', async (ctx) => {
  const userId = str(ctx.request?.UserId).trim().toUpperCase();
  const password = str(ctx.request?.Password);
  const ip = ctx.fastifyReq.ip || 'unknown';
  const keys = [`ip:${ip}`, `uid:${userId || '-'}`];
  const now = Date.now();
  const seedId = userId || '-';

  if (isRateLimited(keys, now)) {
    logOutcome(ctx, seedId, false, 'rate-limited');
    throw new AppRpcError(ERROR_CODE.PASSWORD_MIGRATION_FAILED, MIGRATION_ERROR_ACTION, RATE_LIMITED_MESSAGE);
  }

  const [acct] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.seedId, userId), isNull(accounts.deletedAt), eq(accounts.isBanned, false)))
    .limit(1);
  const credential = acct ? await getCredentials(acct.id) : undefined;

  // Always hash once, even when there is nothing to compare against: a missing
  // account must cost the same time as a wrong password.
  const matched = verifyPassword(password, credential?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!acct || !credential || !matched) {
    recordFailure(keys, now);
    logOutcome(ctx, seedId, false, !acct ? 'unknown-account' : !credential ? 'no-credentials' : 'wrong-password');
    throw new AppRpcError(
      ERROR_CODE.PASSWORD_MIGRATION_FAILED,
      MIGRATION_ERROR_ACTION,
      INVALID_CREDENTIALS_MESSAGE,
    );
  }

  if (acct.id === accountIdOf(ctx)) {
    logOutcome(ctx, seedId, false, 'own-account');
    throw new AppRpcError(ERROR_CODE.PASSWORD_MIGRATION_FAILED, MIGRATION_ERROR_ACTION, OWN_ACCOUNT_MESSAGE);
  }

  const [player] = await db.select().from(players).where(eq(players.accountId, acct.id)).limit(1);
  const token = randomToken();
  await setOnetimeToken(acct.id, sha256Hex(token), new Date(now + ONETIME_TTL_MS));
  logOutcome(ctx, seedId, true, 'token-issued');

  return {
    Success: true,
    LinkedUserId: acct.seedId ?? seedId,
    LinkedUser: {
      __msg: USER_MSG,
      Name: player?.name ?? acct.displayName ?? '',
      ManagerLevel: player?.level ?? 1,
      ManagerExp: player?.exp ?? 0,
    },
    OnetimeToken: token,
  };
});

register('Migration:Execute', async (ctx) => {
  const token = str(ctx.request?.OnetimeToken);
  const now = new Date();
  if (!token) {
    logOutcome(ctx, seedIdOf(ctx), false, 'missing-token');
    throw new AppRpcError(ERROR_CODE.MIGRATION_TARGET_NOT_FOUND, MIGRATION_ERROR_ACTION, EXPIRED_TOKEN_MESSAGE);
  }

  const tokenHash = sha256Hex(token);
  const credential = await getCredentialsByOnetimeHash(tokenHash, now);
  if (!credential) {
    logOutcome(ctx, seedIdOf(ctx), false, 'expired-token');
    throw new AppRpcError(ERROR_CODE.MIGRATION_TARGET_NOT_FOUND, MIGRATION_ERROR_ACTION, EXPIRED_TOKEN_MESSAGE);
  }

  const result = await db.transaction(async (tx) => {
    // Conditional consume: only the first call holding this hash wins.
    if (!(await consumeOnetimeToken(credential.accountId, tokenHash, now, tx))) return null;
    const [acct] = await tx.select().from(accounts).where(eq(accounts.id, credential.accountId)).limit(1);
    // A ban or soft delete after MigratePassword voids the pending transfer.
    if (!acct || acct.isBanned || acct.deletedAt) return null;
    let uid = acct.firebaseUid;
    if (!uid) {
      // Invite-created account: bind a fresh UID now, so the custom token the
      // client redeems is the one the account will be found by on login.
      uid = generateFirebaseUid();
      await tx.update(accounts).set({ firebaseUid: uid }).where(eq(accounts.id, acct.id));
    }
    return { uid, seedId: acct.seedId ?? credential.accountId };
  });

  if (!result) {
    logOutcome(ctx, seedIdOf(ctx), false, 'token-consumed');
    throw new AppRpcError(ERROR_CODE.MIGRATION_TARGET_NOT_FOUND, MIGRATION_ERROR_ACTION, EXPIRED_TOKEN_MESSAGE);
  }

  logOutcome(ctx, result.seedId, true, 'token-consumed');
  return { Token: mintCustomToken(result.uid) };
});
