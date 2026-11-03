import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

// This suite uses app.inject(), which needs a plain HTTP/1.1 instance. Force
// the flags off before config.ts is evaluated (all app imports are dynamic).
process.env.TLS = '0';
process.env.HTTP2 = '0';
// These tests cover open registration; dotenv does not override this.
process.env.SUMIRE_REGISTRATION = 'open';

const { requireData } = await import('./testing/requireData.ts');
await requireData({ captures: true, db: true });

const { buildServer } = await import('./server.ts');
const tokens = await import('./auth/firebaseTokens.ts');
const { parseFirebaseUid } = await import('./services/auth.ts');
const { dispatchRpc } = await import('./services/router.ts');
const { db, client } = await import('./db/client.ts');
const { accounts, players } = await import('./db/schema.ts');
const { decodeMessage, encodeMessage, msgRegistry, Reader, Writer } = await import('@sumire-sr/protocol/runtime/proto.ts');
const { endpoints } = await import('@sumire-sr/protocol/gen/endpoints.ts');

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

// ---------------------------------------------------------------------------
// Pure token functions (no DB, no HTTP)
// ---------------------------------------------------------------------------

const uid = tokens.generateFirebaseUid();
assert.equal(uid.length, 28, 'generated uid is 28 chars');
assert.match(uid, /^[0-9A-Za-z]{28}$/, 'generated uid is base62');
assert.notEqual(tokens.generateFirebaseUid(), uid, 'generated uids differ');

const custom = tokens.mintCustomToken(uid);
const verifiedCustom = tokens.verifyCustomToken(custom);
assert.ok(verifiedCustom, 'custom token verifies');
assert.equal(verifiedCustom.uid, uid, 'custom token carries the uid');
assert.equal(verifiedCustom.claims.iss, tokens.FIREBASE_ADMIN_ISSUER);
assert.equal(verifiedCustom.claims.sub, tokens.FIREBASE_ADMIN_ISSUER);
assert.equal(verifiedCustom.claims.aud, tokens.IDENTITY_TOOLKIT_AUD);
assert.equal(Number(verifiedCustom.claims.exp) - Number(verifiedCustom.claims.iat), 3600);

const idToken = tokens.mintIdToken(uid);
const idHeader = JSON.parse(Buffer.from(idToken.split('.')[0]!, 'base64url').toString('utf8')) as any;
const idClaims = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString('utf8')) as any;
assert.equal(idHeader.alg, 'RS256');
assert.equal(idHeader.typ, 'JWT');
assert.equal(idHeader.kid, 'sumire-sr');
assert.equal(idClaims.iss, tokens.SECURE_TOKEN_ISSUER);
assert.equal(idClaims.aud, tokens.FIREBASE_PROJECT_ID);
assert.equal(idClaims.user_id, uid);
assert.equal(idClaims.sub, uid);
assert.deepEqual(idClaims.firebase, { identities: {}, sign_in_provider: 'custom' });
assert.equal(Number(idClaims.exp) - Number(idClaims.iat), 3600);
assert.equal(parseFirebaseUid(idToken), uid, 'parseFirebaseUid reads our ID token');
assert.equal(tokens.verifyIdToken(idToken)?.uid, uid);

const refresh = tokens.mintRefreshToken(uid);
assert.equal(tokens.verifyRefreshToken(refresh)?.uid, uid);
const refreshClaims = JSON.parse(Buffer.from(refresh.split('.')[1]!, 'base64url').toString('utf8')) as any;
assert.equal(refreshClaims.typ, 'refresh');
assert.ok(Number(refreshClaims.exp) - Number(refreshClaims.iat) > 30 * 24 * 3600, 'refresh token is long-lived');

const tamperedCustom = custom.slice(0, -2) + (custom.endsWith('aa') ? 'bb' : 'aa');
assert.equal(tokens.verifyCustomToken(tamperedCustom), null, 'tampered custom token rejected');

// A structurally valid token signed by a different key must be rejected.
const foreignKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const b64 = (buf: Buffer) => buf.toString('base64url');
const nowSec = Math.floor(Date.now() / 1000);
const foreignHeader = b64(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
const foreignBody = b64(
  Buffer.from(
    JSON.stringify({
      iss: tokens.FIREBASE_ADMIN_ISSUER,
      sub: tokens.FIREBASE_ADMIN_ISSUER,
      aud: tokens.IDENTITY_TOOLKIT_AUD,
      uid,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  ),
);
const foreignSigner = createSign('RSA-SHA256');
foreignSigner.update(`${foreignHeader}.${foreignBody}`);
const foreign = `${foreignHeader}.${foreignBody}.${b64(foreignSigner.sign(foreignKeys.privateKey))}`;
assert.equal(tokens.verifyCustomToken(foreign), null, 'foreign-signed custom token rejected');

// Custom tokens and ID tokens must not be interchangeable (aud/iss differ).
assert.equal(tokens.verifyIdToken(custom), null, 'custom token is not an ID token');
assert.equal(tokens.verifyCustomToken(idToken), null, 'ID token is not a custom token');
assert.equal(tokens.verifyRefreshToken(idToken), null, 'ID token is not a refresh token');

console.log('PASS pure token unit checks');

// ---------------------------------------------------------------------------
// HTTP emulator routes via app.inject()
// ---------------------------------------------------------------------------

const app = buildServer();
await app.ready();

const post = (url: string, payload: string, contentType: string) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': contentType }, payload });
const jsonPost = (url: string, body: unknown) => post(url, JSON.stringify(body), 'application/json');
const formPost = (url: string, body: Record<string, string>) =>
  post(url, new URLSearchParams(body).toString(), 'application/x-www-form-urlencoded');

const signIn = await jsonPost('/v1/accounts:signInWithCustomToken', {
  token: custom,
  returnSecureToken: true,
});
const signInBody = signIn.json() as any;
check('signInWithCustomToken JSON → 200', signIn.statusCode === 200, signIn.body);
check(
  'signInWithCustomToken kind',
  signInBody.kind === 'identitytoolkit#VerifyCustomTokenResponse',
  signIn.body,
);
check('signInWithCustomToken expiresIn is "3600"', signInBody.expiresIn === '3600');
check('signInWithCustomToken isNewUser=false', signInBody.isNewUser === false);
const emuIdToken: string = signInBody.idToken;
const emuRefresh: string = signInBody.refreshToken;
check('signIn idToken parses to the uid', parseFirebaseUid(emuIdToken) === uid);
check('signIn idToken verifies with our key', tokens.verifyIdToken(emuIdToken)?.uid === uid);
check('signIn refreshToken verifies with our key', tokens.verifyRefreshToken(emuRefresh)?.uid === uid);

const legacy = await formPost('/identitytoolkit/v3/relyingparty/verifyCustomToken', {
  token: custom,
  returnSecureToken: 'true',
});
const legacyBody = legacy.json() as any;
check(
  'legacy verifyCustomToken accepts a form body',
  legacy.statusCode === 200 && legacyBody.kind === 'identitytoolkit#VerifyCustomTokenResponse',
  legacy.body,
);

const refreshJson = await jsonPost('/v1/token', {
  grant_type: 'refresh_token',
  refresh_token: emuRefresh,
});
const refreshJsonBody = refreshJson.json() as any;
check('securetoken JSON → 200', refreshJson.statusCode === 200, refreshJson.body);
check('securetoken JSON user_id', refreshJsonBody.user_id === uid);
check('securetoken JSON project_id', refreshJsonBody.project_id === 'solis-firebase');
check('securetoken JSON expires_in is "3600"', refreshJsonBody.expires_in === '3600');
check('securetoken JSON token_type', refreshJsonBody.token_type === 'Bearer');
check('securetoken JSON id_token parses to the uid', parseFirebaseUid(refreshJsonBody.id_token) === uid);
check('securetoken JSON echoes the refresh_token', refreshJsonBody.refresh_token === emuRefresh);

// The Android SDK (FirebaseCore 23.x) sends camelCase keys.
const refreshCamel = await jsonPost('/v1/token', {
  grantType: 'refresh_token',
  refreshToken: emuRefresh,
});
check(
  'securetoken camelCase JSON → 200 with the same uid',
  refreshCamel.statusCode === 200 && (refreshCamel.json() as any).user_id === uid,
  refreshCamel.body,
);
// The SDK stores the echoed token; an empty echo breaks the next refresh.
check('securetoken camelCase JSON echoes the refresh_token', (refreshCamel.json() as any).refresh_token === emuRefresh);

const refreshForm = await formPost('/v1/token', {
  grant_type: 'refresh_token',
  refresh_token: emuRefresh,
});
const refreshFormBody = refreshForm.json() as any;
check(
  'securetoken form body → 200 with the same uid',
  refreshForm.statusCode === 200 && refreshFormBody.user_id === uid,
  refreshForm.body,
);

const lookup = await jsonPost('/v1/accounts:lookup', { idToken: emuIdToken });
const lookupBody = lookup.json() as any;
const lookupUser = lookupBody.users?.[0] ?? {};
check('lookup JSON → 200', lookup.statusCode === 200, lookup.body);
check('lookup kind', lookupBody.kind === 'identitytoolkit#GetAccountInfoResponse');
check('lookup localId', lookupUser.localId === uid);
check('lookup customAuth=true', lookupUser.customAuth === true);
check(
  'lookup providerUserInfo is empty',
  Array.isArray(lookupUser.providerUserInfo) && lookupUser.providerUserInfo.length === 0,
);
check('lookup lastLoginAt is a ms string', /^\d+$/.test(String(lookupUser.lastLoginAt)));
check('lookup createdAt is a ms string', /^\d+$/.test(String(lookupUser.createdAt)));

const accountInfo = await formPost('/identitytoolkit/v3/relyingparty/getAccountInfo', {
  idToken: emuIdToken,
});
check(
  'legacy getAccountInfo accepts a form body',
  accountInfo.statusCode === 200 && (accountInfo.json() as any).users?.[0]?.localId === uid,
  accountInfo.body,
);

const badCustom = await jsonPost('/v1/accounts:signInWithCustomToken', {
  token: tamperedCustom,
  returnSecureToken: true,
});
const badCustomBody = badCustom.json() as any;
check(
  'tampered custom token → 400 INVALID_CUSTOM_TOKEN',
  badCustom.statusCode === 400 &&
    badCustomBody.error?.code === 400 &&
    badCustomBody.error?.message === 'INVALID_CUSTOM_TOKEN' &&
    badCustomBody.error?.errors?.[0]?.message === 'INVALID_CUSTOM_TOKEN' &&
    badCustomBody.error?.errors?.[0]?.domain === 'global' &&
    badCustomBody.error?.errors?.[0]?.reason === 'invalid',
  badCustom.body,
);

const foreignSignIn = await jsonPost('/v1/accounts:signInWithCustomToken', {
  token: foreign,
  returnSecureToken: true,
});
check(
  'foreign-signed custom token → 400 INVALID_CUSTOM_TOKEN',
  foreignSignIn.statusCode === 400 &&
    (foreignSignIn.json() as any).error?.message === 'INVALID_CUSTOM_TOKEN',
  foreignSignIn.body,
);

const badRefresh = await jsonPost('/v1/token', {
  grant_type: 'refresh_token',
  refresh_token: 'not-a-jwt',
});
const badRefreshBody = badRefresh.json() as any;
check(
  'bad refresh token → 400 INVALID_REFRESH_TOKEN',
  badRefresh.statusCode === 400 &&
    badRefreshBody.error?.code === 400 &&
    badRefreshBody.error?.message === 'INVALID_REFRESH_TOKEN' &&
    badRefreshBody.error?.status === 'INVALID_ARGUMENT',
  badRefresh.body,
);

const badLookup = await jsonPost('/v1/accounts:lookup', { idToken: 'not-a-jwt' });
check(
  'bad ID token → 400 INVALID_ID_TOKEN',
  badLookup.statusCode === 400 && (badLookup.json() as any).error?.message === 'INVALID_ID_TOKEN',
  badLookup.body,
);

// The gRPC fallback (`/:service/:method`) matches two-segment paths; this
// proves the static emulator route wins and the request never reaches it.
const precedence = await jsonPost('/v1/token', {
  grant_type: 'refresh_token',
  refresh_token: 'not-a-jwt',
});
const precedenceType = String(precedence.headers['content-type'] ?? '');
check(
  'POST /v1/token hits the emulator, not the gRPC fallback',
  precedence.statusCode === 400 &&
    precedenceType.includes('application/json') &&
    (precedence.json() as any).error?.message === 'INVALID_REFRESH_TOKEN',
  `${precedence.statusCode} ${precedenceType} ${precedence.body}`,
);

// ---------------------------------------------------------------------------
// Handler-level Auth:Create / Auth:Recreate (only with a reachable DB)
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function dbReachable(): Promise<boolean> {
  try {
    await withTimeout(db.execute(sql`select 1`), 2500);
    return true;
  } catch (e) {
    console.log(`SKIP Auth:Create/Recreate handler tests (database unreachable: ${(e as Error).message})`);
    return false;
  }
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

const fakeReq = { headers: {}, log: { info() {}, warn() {}, error() {} } } as any;

async function deleteAccountByUid(firebaseUid: string): Promise<void> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.firebaseUid, firebaseUid)).limit(1);
  if (!acct) return;
  await db.delete(players).where(eq(players.accountId, acct.id));
  await db.delete(accounts).where(eq(accounts.id, acct.id));
}

if (await dbReachable()) {
  const createdUids: string[] = [];
  try {
    const requestedUid = tokens.generateFirebaseUid();
    createdUids.push(requestedUid);
    const createResp = decodeResp(
      endpoints.Auth.Create.response,
      await dispatchRpc(
        'Auth:Create',
        encodeReq(endpoints.Auth.Create.request, { FirebaseUID: requestedUid }),
        fakeReq,
      ),
    );
    check(
      'Auth:Create returns a custom token for the requested uid',
      typeof createResp.FirebaseCustomToken === 'string' &&
        tokens.verifyCustomToken(createResp.FirebaseCustomToken)?.uid === requestedUid,
      createResp,
    );
    const createRows = await db
      .select()
      .from(accounts)
      .where(eq(accounts.firebaseUid, requestedUid))
      .limit(1);
    const accountRow = createRows[0];
    check('Auth:Create created the account row', accountRow?.firebaseUid === requestedUid);
    if (accountRow) {
      const playerRows = await db
        .select()
        .from(players)
        .where(eq(players.accountId, accountRow.id))
        .limit(1);
      check('Auth:Create created the player row', playerRows.length === 1);
    }

    const replayResp = decodeResp(
      endpoints.Auth.Create.response,
      await dispatchRpc(
        'Auth:Create',
        encodeReq(endpoints.Auth.Create.request, { FirebaseUID: requestedUid }),
        fakeReq,
      ),
    );
    const replayUid = tokens.verifyCustomToken(replayResp.FirebaseCustomToken)?.uid;
    if (replayUid) createdUids.push(replayUid);
    check(
      'Auth:Create never issues a token for an existing uid',
      typeof replayUid === 'string' && replayUid !== requestedUid,
      replayResp,
    );

    const emptyResp = decodeResp(
      endpoints.Auth.Create.response,
      await dispatchRpc('Auth:Create', encodeReq(endpoints.Auth.Create.request), fakeReq),
    );
    const generated = tokens.verifyCustomToken(emptyResp.FirebaseCustomToken);
    if (generated) createdUids.push(generated.uid);
    check(
      'Auth:Create generates a 28-char base62 uid when FirebaseUID is empty',
      generated !== null && generated.uid.length === 28 && /^[0-9A-Za-z]{28}$/.test(generated.uid),
      generated?.uid,
    );

    const recreateResp = decodeResp(
      endpoints.Auth.Recreate.response,
      await dispatchRpc(
        'Auth:Recreate',
        encodeReq(endpoints.Auth.Recreate.request, { FirebaseIDToken: tokens.mintIdToken(requestedUid) }),
        fakeReq,
      ),
    );
    check(
      'Auth:Recreate returns a custom token for the ID token uid',
      tokens.verifyCustomToken(recreateResp.FirebaseCustomToken)?.uid === requestedUid,
      recreateResp,
    );

    let recreateThrew = false;
    try {
      await dispatchRpc('Auth:Recreate', Buffer.alloc(0), fakeReq);
    } catch {
      recreateThrew = true;
    }
    check('Auth:Recreate throws when FirebaseIDToken is missing', recreateThrew);
  } finally {
    for (const createdUid of createdUids) {
      try {
        await deleteAccountByUid(createdUid);
      } catch (e) {
        console.error(`cleanup failed for ${createdUid}: ${(e as Error).message}`);
      }
    }
  }
}

await app.close();
try {
  await client.end({ timeout: 5 });
} catch {
  // The DB may never have been contacted (skipped handler tests).
}

console.log(`\nauth create test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
