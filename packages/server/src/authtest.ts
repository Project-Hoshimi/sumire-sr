import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintToken,
  verifyToken,
  extractBearer,
  resetKeyCache,
  keySource,
  publicKeyFingerprint,
} from './auth/jwt.ts';
import { config } from './config.ts';
import { authenticate } from './auth/authenticate.ts';
import {
  ERROR_ACTION,
  ERROR_CODE,
  GRPC_STATUS,
  NOT_IMPLEMENTED_MESSAGE,
  NotImplementedError,
  UnauthenticatedError,
  encodeBinHeader,
  encodeGrpcMessage,
  isNotImplementedError,
  isUnauthenticatedError,
} from './services/errors.ts';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e: any) {
    failures += 1;
    console.error(`FAIL ${name}: ${e?.message ?? e}`);
  }
}

// Run every check against a throwaway key directory so the test never mints a
// key into the checkout.
const dirA = mkdtempSync(join(tmpdir(), 'sumire-jwt-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'sumire-jwt-b-'));
const originalPath = config.jwtPrivateKeyPath;
const originalInline = { priv: config.jwt.privateKeyPem, pub: config.jwt.publicKeyPem };
config.jwt.privateKeyPem = '';
config.jwt.publicKeyPem = '';
config.jwtPrivateKeyPath = join(dirA, 'keys', 'jwt-private.pem');
resetKeyCache();

const t = mintToken({ sub: 'acc-1', seedId: 'dev-seed' });
const v = verifyToken(t);
check('minted token verifies', () => assert.equal(v.ok, true));
check('claims round-trip', () => {
  assert.equal((v as any).claims?.sub, 'acc-1');
  assert.equal((v as any).claims?.seedId, 'dev-seed');
});
check('exp is in the future', () => assert.ok((v as any).claims?.exp > Date.now() / 1000));
check('tampered token rejected', () => assert.equal(verifyToken(t.slice(0, -2) + 'aa').ok, false));

// --- restart persistence -----------------------------------------------------
// The production bug: the signing key was per checkout/process, so a restart
// (or a checkout switch) silently changed it and every token minted before the
// restart stopped verifying. The key must be read from disk and stay stable.
const persistedToken = mintToken({ sub: 'acc-restart', seedId: 'seed-restart' });
const fingerprintBefore = publicKeyFingerprint();
check('key file created with mode 0600', () => {
  const mode = statSync(config.jwtPrivateKeyPath).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.match(readFileSync(config.jwtPrivateKeyPath, 'utf8'), /BEGIN PRIVATE KEY/);
});
check('key source is the configured file', () => assert.equal(keySource(), config.jwtPrivateKeyPath));

// Simulate a process restart: drop the in-process cache, reload from disk.
resetKeyCache();
check('token still verifies after key reload (restart)', () =>
  assert.equal(verifyToken(persistedToken).ok, true));
check('fingerprint is stable across the reload', () =>
  assert.equal(publicKeyFingerprint(), fingerprintBefore));

// Simulate the failure mode being fixed: a different key on disk.
config.jwtPrivateKeyPath = join(dirB, 'keys', 'jwt-private.pem');
resetKeyCache();
check('token from another key is rejected as bad signature', () => {
  const res = verifyToken(persistedToken);
  assert.equal(res.ok, false);
  assert.equal((res as { reason: string }).reason, 'bad signature');
});

// Back to the "same" deployment for the remaining checks.
config.jwtPrivateKeyPath = join(dirA, 'keys', 'jwt-private.pem');
resetKeyCache();

// --- header parsing ----------------------------------------------------------
check('bearer extract', () => assert.equal(extractBearer('Bearer ' + t), t));
check('bare extract', () => assert.equal(extractBearer(t), t));
check('null extract', () => assert.equal(extractBearer(undefined), null));

// --- auth-failure -> re-authentication mapping -------------------------------
check('missing token reports a reason', () => {
  const res = authenticate(undefined);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing token');
});
check('invalid token is unauthenticated', () => {
  const res = authenticate('Bearer ' + t.slice(0, -2) + 'aa');
  assert.equal(res.ok, false);
  assert.ok(res.reason);
});
check('handler auth failures are recognised', () => {
  // Services signal "no identity" by throwing `…: unauthenticated`.
  assert.equal(isUnauthenticatedError(new Error('Gacha:Draw: unauthenticated')), true);
  assert.equal(isUnauthenticatedError(new UnauthenticatedError('Gacha:Draw: unauthenticated')), true);
  assert.equal(isUnauthenticatedError(new Error('Gacha:Draw: insufficient jewel')), false);
});
check('unauthenticated maps to gRPC 16 + ErrorCode 2004 + title action', () => {
  const err = new UnauthenticatedError('Gacha:Draw: unauthenticated');
  assert.equal(err.grpcStatus, GRPC_STATUS.UNAUTHENTICATED);
  assert.equal(err.grpcStatus, 16);
  assert.equal(ERROR_CODE.UNAUTHENTICATED, 2004);
  assert.equal(ERROR_ACTION.TITLE, 'title');
  assert.equal(encodeGrpcMessage('bad token %'), 'bad token %25');
});

// --- unhandled RPC -> dialog, then back home --------------------------------
check('not-implemented errors are recognised and not auth errors', () => {
  const err = new NotImplementedError('X:Y');
  assert.equal(isNotImplementedError(err), true);
  assert.equal(err.grpcStatus, GRPC_STATUS.UNIMPLEMENTED);
  assert.equal(err.grpcStatus, 12);
  assert.equal(err.message, 'X:Y: not implemented');
  assert.equal(ERROR_CODE.FUNCTION_LOCKED, 3022);
  assert.equal(ERROR_ACTION.HOME, 'home');
  assert.equal(ERROR_ACTION.CONTINUE, 'continue');
  assert.equal(ERROR_ACTION.NONE, 'none');
  // The auth predicate also matches on the message regex, so make sure the
  // not-implemented message can never trip it.
  assert.equal(isUnauthenticatedError(err), false);
});

check('not-implemented dialog text round-trips through the base64 -bin header', () => {
  const encoded = encodeBinHeader(NOT_IMPLEMENTED_MESSAGE);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), NOT_IMPLEMENTED_MESSAGE);
});

config.jwtPrivateKeyPath = originalPath;
config.jwt.privateKeyPem = originalInline.priv;
config.jwt.publicKeyPem = originalInline.pub;
rmSync(dirA, { recursive: true, force: true });
rmSync(dirB, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} auth check(s) failed`);
  process.exit(1);
}
console.log('\nall auth checks passed');
