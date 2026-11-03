import { randomUUID, createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { accounts, players } from '../db/schema.ts';
import { mintToken } from '../auth/jwt.ts';
import { generateFirebaseUid, mintCustomToken, verifyIdToken } from '../auth/firebaseTokens.ts';
import { isSandbox } from '../profile.ts';
import { seedSandboxAccount } from '../profiles/sandbox/seed.ts';
import { registrationMode } from '../config.ts';
import { UnauthenticatedError, AppRpcError, INVITE_ONLY_LOGIN_ERROR } from './errors.ts';
import { message } from '../messages.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { FRESH_SEED } from './playerState.ts';

const USER_PUBLIC_MSG = 'Solis.Common.Proto.Transaction.UserPublic';

// Identity of the account captured in the replay corpus (captures/2026-09-14_a12r).
// We pin these so the M1 replay surface (User:Get, Home:*, ...) stays byte-consistent
// for the existing device account. New accounts get fresh generated identities.
const CAPTURED_FIREBASE_UID = '2eab1baa-7e88-4397-bb0e-66ac9f6a1f76';
const CAPTURED_SERVER_USER_ID = '61afc1af-a05b-41d4-af9c-a10f907130a0';
const CAPTURED_PUBLIC_USER_ID = '5W5WHXGS';

// Player stats captured for the corpus account (captures/2026-09-14_a12r User:Get).
// Used to seed the pinned account so the M1 surface stays consistent; brand-new
// accounts start from the defaults below.
const CAPTURED_PLAYER = { name: 'genesis', level: 40, exp: 1335246, gold: 1707717, freeJewel: 10670 };
const NEW_PLAYER = { name: 'Player', level: 1, exp: 0, gold: 0, freeJewel: 0 };

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function genPublicUserId(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return s;
}

/**
 * Sandbox only: max out a freshly created player. In official mode this is a
 * no-op, so the account-creation path is byte-for-byte unchanged.
 */
export async function seedSandboxIfNeeded(serverUserId: string): Promise<void> {
  if (!isSandbox()) return;
  await withPlayerTx(serverUserId, (tx) => seedSandboxAccount(tx, serverUserId));
}

/** Extract the Firebase UID from a Firebase ID token (JWT). Signature is NOT verified. */
export function parseFirebaseUid(token?: string | null): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.user_id ?? payload.sub ?? null;
  } catch {
    return null;
  }
}

export type Identity = { accountId: string; serverUserId: string; publicUserId: string };

/** Insert the player row belonging to `accountId` and return its server user id. */
async function insertPlayerRow(
  executor: Executor,
  accountId: string,
  publicUserId: string,
  captured: boolean,
): Promise<string> {
  const serverUserId = captured ? CAPTURED_SERVER_USER_ID : randomUUID();
  const seed = captured ? CAPTURED_PLAYER : NEW_PLAYER;
  await executor.insert(players).values({
    id: serverUserId,
    accountId,
    name: seed.name,
    level: seed.level,
    exp: seed.exp,
    gold: seed.gold,
    freeJewel: seed.freeJewel,
    data: captured ? { publicUserId } : { publicUserId, seed: FRESH_SEED },
  });
  return serverUserId;
}

/**
 * Create a brand-new account + player. Shared by `Auth:Login` (new Firebase
 * UID in open mode) and the invite page (which passes `firebaseUid = null`:
 * the link binds one on `Migration:Execute`).
 */
export async function createAccountWithPlayer(
  executor: Executor,
  firebaseUid: string | null,
): Promise<Identity> {
  const captured = firebaseUid === CAPTURED_FIREBASE_UID;
  const accountId = randomUUID();
  const publicUserId = captured ? CAPTURED_PUBLIC_USER_ID : genPublicUserId();
  const seed = captured ? CAPTURED_PLAYER : NEW_PLAYER;
  await executor.insert(accounts).values({
    id: accountId,
    firebaseUid,
    seedId: publicUserId,
    displayName: seed.name,
    lastLoginAt: new Date(),
  });
  const serverUserId = await insertPlayerRow(executor, accountId, publicUserId, captured);
  return { accountId, serverUserId, publicUserId };
}

/** Find or create the account + player rows for an already-resolved Firebase UID. */
export async function findOrCreateIdentityByUid(uid: string): Promise<Identity> {
  const captured = uid === CAPTURED_FIREBASE_UID;

  const [acct] = await db.select().from(accounts).where(eq(accounts.firebaseUid, uid)).limit(1);
  if (!acct) {
    const identity = await createAccountWithPlayer(db, uid);
    await seedSandboxIfNeeded(identity.serverUserId);
    return identity;
  }

  const [pl] = await db.select().from(players).where(eq(players.accountId, acct.id)).limit(1);
  if (!pl) {
    const publicUserId = acct.seedId ?? genPublicUserId();
    const serverUserId = await insertPlayerRow(db, acct.id, publicUserId, captured);
    await seedSandboxIfNeeded(serverUserId);
    return { accountId: acct.id, serverUserId, publicUserId };
  }

  const publicUserId = (pl.data as { publicUserId?: string } | null)?.publicUserId ?? acct.seedId ?? genPublicUserId();
  return { accountId: acct.id, serverUserId: pl.id, publicUserId };
}

export async function findOrCreateIdentity(req: Decoded | null): Promise<Identity> {
  const token = typeof req?.FirebaseIDToken === 'string' ? req.FirebaseIDToken : undefined;
  const uid =
    parseFirebaseUid(token) ??
    'anon-' + createHash('sha256').update(token ?? 'none').digest('hex').slice(0, 32);
  return findOrCreateIdentityByUid(uid);
}

/** Account bound to `uid`, ignoring soft-deleted accounts. */
async function findLiveAccountByUid(uid: string) {
  const [acct] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.firebaseUid, uid), isNull(accounts.deletedAt)))
    .limit(1);
  return acct;
}

function loginPayload(accountId: string, serverUserId: string, publicUserId: string) {
  return {
    GameAuthToken: mintToken({ sub: accountId, seedId: publicUserId }),
    UserPublic: { __msg: USER_PUBLIC_MSG, ServerUserId: serverUserId, PublicUserId: publicUserId },
  };
}

register('Auth:Login', async (ctx) => {
  if (registrationMode() !== 'open') {
    // Invite/closed mode: only a token this server really signed may identify
    // an account; the unverified payload could claim any Firebase UID.
    const idToken = typeof ctx.request?.FirebaseIDToken === 'string' ? ctx.request.FirebaseIDToken : '';
    const verified = verifyIdToken(idToken);
    if (!verified) throw new UnauthenticatedError('Auth:Login: invalid FirebaseIDToken');

    const acct = await findLiveAccountByUid(verified.uid);
    if (!acct) {
      // Unknown UID (or the account was soft-deleted): no account to log in to
      // and none is created here. Tell the client to send the player through
      // Account → Enter Link Password instead of handing out a guest session.
      ctx.fastifyReq.log.info(
        { uid: verified.uid },
        'auth login rejected (unbound uid, registration restricted)',
      );
      throw new AppRpcError(
        INVITE_ONLY_LOGIN_ERROR.code,
        INVITE_ONLY_LOGIN_ERROR.action,
        message('inviteOnlyLogin'),
        INVITE_ONLY_LOGIN_ERROR.grpcStatus,
      );
    }

    const { accountId, serverUserId, publicUserId } = await findOrCreateIdentityByUid(verified.uid);
    await db.update(accounts).set({ lastLoginAt: new Date() }).where(eq(accounts.id, accountId));
    ctx.fastifyReq.log.info(
      { accountId, serverUserId, publicUserId },
      'auth login (db-backed, self-issued JWT)',
    );
    return loginPayload(accountId, serverUserId, publicUserId);
  }

  const { accountId, serverUserId, publicUserId } = await findOrCreateIdentity(ctx.request);
  await db.update(accounts).set({ lastLoginAt: new Date() }).where(eq(accounts.id, accountId));
  ctx.fastifyReq.log.info(
    { accountId, serverUserId, publicUserId },
    'auth login (db-backed, self-issued JWT)',
  );
  return loginPayload(accountId, serverUserId, publicUserId);
});

// Self-service sign-up: create/lookup the account for the requested Firebase UID
// (generate one when the client sends none) and hand back a custom token for the
// emulated Firebase Auth exchange. See docs/AUTH_CREATE.md §3 option A.
register('Auth:Create', async (ctx) => {
  const requested = typeof ctx.request?.FirebaseUID === 'string' ? ctx.request.FirebaseUID.trim() : '';
  // Create must never hand out a token for an existing account (anyone could
  // claim someone else's UID); a taken UID gets a fresh one instead.
  const taken =
    requested.length > 0 &&
    (await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.firebaseUid, requested)).limit(1))
      .length > 0;
  const uid = requested.length > 0 && !taken ? requested : generateFirebaseUid();
  if (registrationMode() !== 'open') {
    // Invite/closed: account creation belongs to the link-password flow. Tapping
    // Start on a fresh client calls Auth:Create; a custom token here would sign
    // the client in, and a signed-in client logs in before opening the title
    // Account sheet, which then fails too. With no token it stays signed out,
    // and Account → Enter Link Password works without a login.
    ctx.fastifyReq.log.info(
      { uid, generated: uid !== requested, taken },
      'auth create rejected (registration restricted)',
    );
    throw new AppRpcError(
      INVITE_ONLY_LOGIN_ERROR.code,
      INVITE_ONLY_LOGIN_ERROR.action,
      message('inviteOnlyLogin'),
      INVITE_ONLY_LOGIN_ERROR.grpcStatus,
    );
  }
  const identity = await findOrCreateIdentityByUid(uid);
  ctx.fastifyReq.log.info(
    { uid, accountId: identity.accountId, generated: uid !== requested, taken },
    'auth create (custom token)',
  );
  return { FirebaseCustomToken: mintCustomToken(uid) };
});

// Recovery: derive the UID from a previously issued ID token and mint a fresh
// custom token so the client can sign in again. A missing/unparsable token
// throws; the router turns that into a 500.
register('Auth:Recreate', async (ctx) => {
  const token = typeof ctx.request?.FirebaseIDToken === 'string' ? ctx.request.FirebaseIDToken : '';
  if (registrationMode() !== 'open') {
    // Invite/closed: verify the token and never create an account here; an
    // unbound UID is rejected by the next Auth:Login with the invite-only dialog.
    const verified = verifyIdToken(token);
    if (!verified) throw new UnauthenticatedError('Auth:Recreate: invalid FirebaseIDToken');
    ctx.fastifyReq.log.info({ uid: verified.uid }, 'auth recreate (custom token, registration restricted)');
    return { FirebaseCustomToken: mintCustomToken(verified.uid) };
  }
  const uid = parseFirebaseUid(token);
  if (!uid) throw new Error('Auth:Recreate: missing or unparsable FirebaseIDToken');
  const identity = await findOrCreateIdentityByUid(uid);
  ctx.fastifyReq.log.info({ uid, accountId: identity.accountId }, 'auth recreate (custom token)');
  return { FirebaseCustomToken: mintCustomToken(uid) };
});
