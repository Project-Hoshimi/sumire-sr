import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

// This suite uses app.inject(), which needs a plain HTTP/1.1 instance. Force
// the flags off before config.ts is evaluated (all app imports are dynamic).
process.env.TLS = '0';
process.env.HTTP2 = '0';
// Invite mode is what these tests exercise; the mode is read per call.
process.env.SUMIRE_REGISTRATION = 'invite';
// Test-only wire key: keeps the real secret out of the test and out of .env.
if (!process.env.WIRE_SEC_KEY) process.env.WIRE_SEC_KEY = 'migrationtest-wire-key';
delete process.env.SUMIRE_ADMIN_TOKEN;

const { requireData } = await import('./testing/requireData.ts');
await requireData({ captures: true, db: true });

const { buildServer } = await import('./server.ts');
const { encrypt, decrypt } = await import('./gateway/crypto.ts');
const { endpoints } = await import('@sumire-sr/protocol/gen/endpoints.ts');
const { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } = await import('@sumire-sr/protocol/runtime/proto.ts');
await import('@sumire-sr/protocol/gen/registry.ts');
const { db, client } = await import('./db/client.ts');
const { accounts, players, accountCredentials, invites } = await import('./db/schema.ts');
const { createInvite, revokeInvite } = await import('./db/invites.ts');
const { getCredentials, upsertPassword } = await import('./db/credentials.ts');
const { NOT_IMPLEMENTED_MESSAGE, isAppRpcError } = await import('./services/errors.ts');
const { dispatchRpc } = await import('./services/router.ts');
const passwords = await import('./auth/passwords.ts');
const tokens = await import('./auth/firebaseTokens.ts');
const { mintToken } = await import('./auth/jwt.ts');
const { ADMIN_TOKEN } = await import('./config.ts');
const { message } = await import('./messages.ts');

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
    return;
  }
  fail++;
  const extra =
    detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.error(`FAIL ${label}${extra}`);
}

function encodeReq(shapeName: string, obj: Record<string, unknown> = {}): Buffer {
  const shape = msgRegistry.get(shapeName);
  if (!shape) throw new Error(`no schema registered for ${shapeName}`);
  const w = new Writer();
  encodeMessage(shape, obj, w);
  return Buffer.from(w.toBytes());
}

function decodeResp(shapeName: string, bytes: Buffer): any {
  const shape = msgRegistry.get(shapeName);
  if (!shape) throw new Error(`no schema registered for ${shapeName}`);
  return decodeMessage(shape, new Reader(Uint8Array.from(bytes)));
}

function fakeRequest(token?: string, ip = '127.0.0.1'): any {
  return {
    headers: token ? { 'x-auth-token': token } : {},
    ip,
    log: { info() {}, warn() {}, error() {} },
  };
}

async function expectAppError(
  label: string,
  code: number,
  message: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    check(label, false, 'no error thrown');
  } catch (e: any) {
    check(label, isAppRpcError(e) && e.code === code && e.message === message, {
      code: e?.code,
      message: e?.message,
    });
  }
}

const app = buildServer();
const createdAccountIds: string[] = [];
const createdInviteIds: number[] = [];

async function rpcHttp(name: string, reqBytes: Buffer, token?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api.' + name.replace(':', '/'),
    headers: {
      'content-type': 'application/x-protobuf',
      ...(token ? { 'x-auth-token': token } : {}),
    },
    payload: encrypt(reqBytes, Buffer.from('0000000000000000')),
  });
  return res;
}

// ---------------------------------------------------------------------------
// Password + token helpers (pure, no DB)
// ---------------------------------------------------------------------------

check('valid password: 8 alphanumeric chars', passwords.isValidLinkPassword('abcd1234'));
check('valid password: 16 alphanumeric chars', passwords.isValidLinkPassword('A1b2C3d4E5f6G7h8'));
check('invalid password: 7 chars', !passwords.isValidLinkPassword('abcd123'));
check('invalid password: 17 chars', !passwords.isValidLinkPassword('a'.repeat(17)));
check('invalid password: punctuation', !passwords.isValidLinkPassword('abcd-123'));
check('invalid password: empty', !passwords.isValidLinkPassword(''));

const hash = passwords.hashPassword('abcd1234');
check('hash uses the scrypt$N$r$p$salt$key format', /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(hash));
check('hash verifies its own password', passwords.verifyPassword('abcd1234', hash));
check('hash rejects a different password', !passwords.verifyPassword('abcd1235', hash));
check('hash rejects malformed stored values', !passwords.verifyPassword('abcd1234', 'plaintext'));
check('two hashes of the same password use different salts', passwords.hashPassword('abcd1234') !== hash);

const token = passwords.randomToken();
check('random token is base64url of 16 bytes', Buffer.from(token, 'base64url').length === 16 && /^[A-Za-z0-9_-]+$/.test(token));
check('sha256Hex is deterministic and 64 hex chars', passwords.sha256Hex(token) === passwords.sha256Hex(token) && /^[0-9a-f]{64}$/.test(passwords.sha256Hex(token)));
const generatedPassword = passwords.generateLinkPassword(12);
check('generated password is valid and 12 chars', generatedPassword.length === 12 && passwords.isValidLinkPassword(generatedPassword));

// ---------------------------------------------------------------------------
// Messages (pure)
// ---------------------------------------------------------------------------

check('message(notImplemented) matches NOT_IMPLEMENTED_MESSAGE', message('notImplemented') === NOT_IMPLEMENTED_MESSAGE);
// `message()` reads SUMIRE_LANG per call, so an unknown language can be probed
// in-process: it must fall back to English.
const previousLang = process.env.SUMIRE_LANG;
process.env.SUMIRE_LANG = 'zz';
check('unknown SUMIRE_LANG falls back to English', message('notImplemented') === 'This feature is not implemented yet.');
if (previousLang === undefined) delete process.env.SUMIRE_LANG;
else process.env.SUMIRE_LANG = previousLang;

// ---------------------------------------------------------------------------
// DB-backed tests
// ---------------------------------------------------------------------------

let dbReady = true;
try {
  await db.select().from(accountCredentials).limit(1);
} catch (e: any) {
  dbReady = false;
  console.log(`skipped DB tests: drizzle/0030_login_flow.sql is not applied (${e?.message})`);
}

if (dbReady) {
  const acctIdA = randomUUID();
  const uidA = tokens.generateFirebaseUid();
  const seedIdA = 'MIG00001';
  const playerIdA = randomUUID();
  createdAccountIds.push(acctIdA);
  await db.insert(accounts).values({
    id: acctIdA,
    firebaseUid: uidA,
    seedId: seedIdA,
    displayName: 'Migrator',
    lastLoginAt: new Date(),
  });
  await db.insert(players).values({
    id: playerIdA,
    accountId: acctIdA,
    name: 'Migrator',
    level: 7,
    exp: 42,
    gold: 0,
    freeJewel: 0,
    data: { publicUserId: seedIdA },
  });

  const tokenA = mintToken({ sub: acctIdA, seedId: seedIdA });
  const guestToken = mintToken({ sub: 'guest', guest: true, uid: tokens.generateFirebaseUid() });
  const setPassword = (password: string, auth?: string) =>
    dispatchRpc(
      'Migration:SetPassword',
      encodeReq(endpoints.Migration.SetPassword.request, { Password: password }),
      fakeRequest(auth),
    );
  const migrate = (userId: string, password: string, auth?: string) =>
    dispatchRpc(
      'Migration:MigratePassword',
      encodeReq(endpoints.Migration.MigratePassword.request, { UserId: userId, Password: password }),
      fakeRequest(auth),
    );

  // Migration:List -----------------------------------------------------------
  const listBound = decodeResp(
    endpoints.Migration.List.response,
    await dispatchRpc('Migration:List', Buffer.alloc(0), fakeRequest(tokenA)),
  );
  // Proto bools decode as numbers and false is omitted on the wire.
  check('Migration:List reports no Password before one is set', !listBound.Password);
  check(
    'Migration:List reports no social providers',
    !listBound.Apple && !listBound.Google && !listBound.Facebook && !listBound.Twitter,
  );
  const listGuest = decodeResp(
    endpoints.Migration.List.response,
    await dispatchRpc('Migration:List', Buffer.alloc(0), fakeRequest(guestToken)),
  );
  check('Migration:List for a guest reports nothing linked', !listGuest.Password);

  // Migration:SetPassword ----------------------------------------------------
  await expectAppError(
    'Migration:SetPassword rejects an invalid password with 3004',
    3004,
    message('invalidPassword'),
    () => setPassword('short', tokenA),
  );
  check('invalid SetPassword did not create credentials', (await getCredentials(acctIdA)) === undefined);
  await expectAppError(
    'Migration:SetPassword requires a non-guest session',
    2004,
    message('inviteOnlyBlocked'),
    () => setPassword('password1', guestToken),
  );

  const setResp = await setPassword('password1', tokenA);
  check('Migration:SetPassword accepts a valid password', setResp.length >= 0);
  const credentialA = await getCredentials(acctIdA);
  const listSet = decodeResp(
    endpoints.Migration.List.response,
    await dispatchRpc('Migration:List', Buffer.alloc(0), fakeRequest(tokenA)),
  );
  check('Migration:List reports Password for a credential-holding account', Boolean(listSet.Password));
  check(
    'SetPassword stored a verifiable hash and no one-time token',
    !!credentialA && passwords.verifyPassword('password1', credentialA.passwordHash) && credentialA.onetimeTokenHash === null,
  );

  // Migration:MigratePassword ------------------------------------------------
  await expectAppError(
    'MigratePassword on the current account is rejected',
    3003,
    message('ownAccount'),
    () => migrate(seedIdA, 'password1', tokenA),
  );

  const migrated = decodeResp(
    endpoints.Migration.MigratePassword.response,
    await migrate(seedIdA.toLowerCase(), 'password1'),
  );
  check('MigratePassword succeeds for a guest with the right password', Boolean(migrated.Success));
  check('MigratePassword returns the account public id', migrated.LinkedUserId === seedIdA);
  check(
    'MigratePassword returns the linked user summary',
    migrated.LinkedUser?.Name === 'Migrator' && migrated.LinkedUser?.ManagerLevel === 7 && migrated.LinkedUser?.ManagerExp === 42,
  );
  check(
    'MigratePassword returns a one-time token',
    typeof migrated.OnetimeToken === 'string' && migrated.OnetimeToken.length > 0,
  );

  const executed = decodeResp(
    endpoints.Migration.Execute.response,
    await dispatchRpc(
      'Migration:Execute',
      encodeReq(endpoints.Migration.Execute.request, { OnetimeToken: migrated.OnetimeToken }),
      fakeRequest(),
    ),
  );
  check(
    'Execute mints a custom token for the account firebase uid',
    tokens.verifyCustomToken(executed.Token)?.uid === uidA,
  );
  await expectAppError(
    'Execute cannot reuse a consumed token',
    3009,
    message('expiredToken'),
    () =>
      dispatchRpc(
        'Migration:Execute',
        encodeReq(endpoints.Migration.Execute.request, { OnetimeToken: migrated.OnetimeToken }),
        fakeRequest(),
      ),
  );

  // Invite-created account (NULL firebase uid) gets bound on Execute ---------
  const acctIdB = randomUUID();
  const seedIdB = 'MIG00002';
  createdAccountIds.push(acctIdB);
  await db.insert(accounts).values({
    id: acctIdB,
    firebaseUid: null,
    seedId: seedIdB,
    displayName: 'Invitee',
    lastLoginAt: new Date(),
  });
  await db.insert(players).values({
    id: randomUUID(),
    accountId: acctIdB,
    name: 'Invitee',
    level: 1,
    exp: 0,
    gold: 0,
    freeJewel: 0,
    data: { publicUserId: seedIdB },
  });
  await upsertPassword(acctIdB, passwords.hashPassword('password2'));

  const migratedB = decodeResp(
    endpoints.Migration.MigratePassword.response,
    await migrate(seedIdB, 'password2'),
  );
  const executedB = decodeResp(
    endpoints.Migration.Execute.response,
    await dispatchRpc(
      'Migration:Execute',
      encodeReq(endpoints.Migration.Execute.request, { OnetimeToken: migratedB.OnetimeToken }),
      fakeRequest(),
    ),
  );
  const [acctB] = await db.select().from(accounts).where(eq(accounts.id, acctIdB)).limit(1);
  check(
    'Execute binds a fresh firebase uid for a NULL-uid account',
    !!acctB?.firebaseUid && /^[0-9A-Za-z]{28}$/.test(acctB.firebaseUid),
  );
  check(
    'Execute custom token matches the newly bound uid',
    tokens.verifyCustomToken(executedB.Token)?.uid === acctB?.firebaseUid,
  );

  // Rate limiting ------------------------------------------------------------
  const acctIdC = randomUUID();
  const seedIdC = 'MIG00003';
  createdAccountIds.push(acctIdC);
  await db.insert(accounts).values({
    id: acctIdC,
    firebaseUid: null,
    seedId: seedIdC,
    displayName: 'Limited',
    lastLoginAt: new Date(),
  });
  await upsertPassword(acctIdC, passwords.hashPassword('password3'));

  // First wrong attempt goes over HTTP to prove the 3003 app-error headers.
  const wrongHttp = await rpcHttp(
    'Migration:MigratePassword',
    encodeReq(endpoints.Migration.MigratePassword.request, { UserId: seedIdC, Password: 'wrongpass' }),
  );
  check('wrong password answers with app error code 3003 in the header', wrongHttp.headers['x-error-code'] === '3003');
  check('wrong password answers with the continue action', wrongHttp.headers['x-error-action'] === 'continue');
  check(
    'wrong password HTTP response keeps the credential message off the wire',
    !wrongHttp.body.includes(message('invalidCredentials')),
  );

  for (let i = 0; i < 4; i += 1) {
    await expectAppError(
      `wrong password failure ${i + 2} reports 3003`,
      3003,
      message('invalidCredentials'),
      () => migrate(seedIdC, 'wrongpass'),
    );
  }
  await expectAppError(
    'sixth attempt is rate limited',
    3003,
    message('rateLimited'),
    () => migrate(seedIdC, 'password3'),
  );

  // Invite pages -------------------------------------------------------------
  const createdInvite = await createInvite({ maxUses: 1 });
  createdInviteIds.push(createdInvite.invite.id);
  const inviteUrl = `/invite/${createdInvite.token}`;

  const pageResp = await app.inject({ method: 'GET', url: inviteUrl });
  check('valid invite page answers 200', pageResp.statusCode === 200);
  check('invite page asks for a link password', pageResp.body.includes('Enter Link Password'));
  check(
    'invite page is self-contained',
    !/https?:\/\//.test(pageResp.body) &&
      !pageResp.body.includes('<script src') &&
      !pageResp.body.includes('<link '),
  );

  const badPost = await app.inject({
    method: 'POST',
    url: inviteUrl,
    headers: { 'content-type': 'application/json' },
    payload: Buffer.from(JSON.stringify({ password: 'short' })),
  });
  check('invite POST rejects an invalid password with 400', badPost.statusCode === 400);
  check('invite POST error is JSON', badPost.json().error === message('invalidPassword'));

  const invitePassword = 'invite01';
  const goodPost = await app.inject({
    method: 'POST',
    url: inviteUrl,
    headers: { 'content-type': 'application/json' },
    payload: Buffer.from(JSON.stringify({ password: invitePassword })),
  });
  check('invite POST creates the account', goodPost.statusCode === 200);
  const newPublicUserId = goodPost.json().publicUserId;
  check('invite POST returns the public user id', typeof newPublicUserId === 'string' && newPublicUserId.length > 0);
  check('invite POST never echoes the password', !goodPost.body.includes(invitePassword));

  const [invitedAcct] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.seedId, newPublicUserId))
    .limit(1);
  if (invitedAcct) createdAccountIds.push(invitedAcct.id);
  check('invited account exists without a firebase uid', !!invitedAcct && invitedAcct.firebaseUid === null);
  if (invitedAcct) {
    const [invitedPlayer] = await db
      .select()
      .from(players)
      .where(eq(players.accountId, invitedAcct.id))
      .limit(1);
    const invitedCredential = await getCredentials(invitedAcct.id);
    check('invited account has a player row', !!invitedPlayer);
    check(
      'invited account stores a verifiable password hash',
      !!invitedCredential && passwords.verifyPassword(invitePassword, invitedCredential.passwordHash),
    );
  }

  const reused = await app.inject({
    method: 'POST',
    url: inviteUrl,
    headers: { 'content-type': 'application/json' },
    payload: Buffer.from(JSON.stringify({ password: 'invite02' })),
  });
  check('second use of a single-use invite answers 410', reused.statusCode === 410);

  const revoked = await createInvite({ maxUses: 3 });
  createdInviteIds.push(revoked.invite.id);
  await revokeInvite(revoked.invite.id);
  const revokedPage = await app.inject({ method: 'GET', url: `/invite/${revoked.token}` });
  check('revoked invite page answers 410', revokedPage.statusCode === 410);
  check('revoked invite page explains the link is invalid', revokedPage.body.includes('This invite link is no longer valid.'));

  // Admin API without a configured token behaves like a missing route -------
  if (ADMIN_TOKEN === '') {
    const adminResp = await app.inject({ method: 'GET', url: '/sumire/admin/invites' });
    check('admin routes answer 404 when SUMIRE_ADMIN_TOKEN is unset', adminResp.statusCode === 404);
  } else {
    console.log('skip admin 404 check: SUMIRE_ADMIN_TOKEN is configured');
  }

  // Registration mode: invite -------------------------------------------------
  const unboundUid = tokens.generateFirebaseUid();
  try {
    await dispatchRpc(
      'Auth:Login',
      encodeReq(endpoints.Auth.Login.request, { FirebaseIDToken: tokens.mintIdToken(unboundUid) }),
      fakeRequest(),
    );
    check('invite mode: unbound uid login is rejected', false, 'no error thrown');
  } catch (e: any) {
    check(
      'invite mode: unbound uid login is rejected with 3022/title/gRPC 7',
      isAppRpcError(e) &&
        e.code === 3022 &&
        e.action === 'title' &&
        e.grpcStatus === 7 &&
        e.message === message('inviteOnlyLogin'),
      { code: e?.code, action: e?.action, grpcStatus: e?.grpcStatus, message: e?.message },
    );
  }
  const [unboundAcct] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.firebaseUid, unboundUid))
    .limit(1);
  check('invite mode: unbound uid does not auto-create an account', unboundAcct === undefined);

  // The router gate still applies to a hand-minted guest token.
  const guestUserGet = await rpcHttp('User:Get', Buffer.alloc(0), guestToken);
  const guestUser = decodeResp(endpoints.User.Get.response, decrypt(Buffer.from(guestUserGet.rawPayload)));
  check('invite mode: guest User:Get answers', guestUserGet.statusCode === 200);
  check('invite mode: guest User:Get is blank', !guestUser.UserPublic && !guestUser.User?.Name);

  const guestService = Object.keys(endpoints).find(
    (service) => !['Auth', 'System', 'Master', 'User', 'Migration'].includes(service),
  );
  const guestMethod = guestService ? Object.keys((endpoints as any)[guestService])[0] : undefined;
  const blockedName = guestService && guestMethod ? `${guestService}:${guestMethod}` : '';
  check('found a non-guest RPC for the blocking check', blockedName.length > 0);
  if (blockedName) {
    await expectAppError(
      'invite mode: guest calling a non-allowed RPC gets 2004/title',
      2004,
      message('inviteOnlyBlocked'),
      () => dispatchRpc(blockedName, Buffer.alloc(0), fakeRequest(guestToken)),
    );
  }

  const guestList = decodeResp(
    endpoints.Migration.List.response,
    await dispatchRpc('Migration:List', Buffer.alloc(0), fakeRequest(guestToken)),
  );
  check('invite mode: guest Migration:List works', !guestList.Password);

  // Auth:Create must not create an account in invite mode --------------------
  const requestedUid = tokens.generateFirebaseUid();
  try {
    await dispatchRpc(
      'Auth:Create',
      encodeReq(endpoints.Auth.Create.request, { FirebaseUID: requestedUid }),
      fakeRequest(),
    );
    check('invite mode: Auth:Create is rejected', false, 'no error thrown');
  } catch (e: any) {
    check(
      'invite mode: Auth:Create is rejected with 3022/title/gRPC 7 (no custom token)',
      isAppRpcError(e) &&
        e.code === 3022 &&
        e.action === 'title' &&
        e.grpcStatus === 7 &&
        e.message === message('inviteOnlyLogin'),
      { code: e?.code, action: e?.action, grpcStatus: e?.grpcStatus, message: e?.message },
    );
  }
  const [createdAcct] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.firebaseUid, requestedUid))
    .limit(1);
  check('invite mode: Auth:Create does not create an account', createdAcct === undefined);

  // Cleanup ------------------------------------------------------------------
  for (const id of createdAccountIds) {
    try {
      await db.delete(players).where(eq(players.accountId, id));
      await db.delete(accounts).where(eq(accounts.id, id));
    } catch (e: any) {
      console.error(`cleanup failed for account ${id}: ${e?.message}`);
    }
  }
  for (const id of createdInviteIds) {
    try {
      await db.delete(invites).where(eq(invites.id, id));
    } catch (e: any) {
      console.error(`cleanup failed for invite ${id}: ${e?.message}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
await client.end();
