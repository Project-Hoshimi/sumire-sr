// Pinned-identity loader tests. No database or game data is required: the
// loader only reads `$SUMIRE_DATA_DIR/captures/identity.json`.
//
//   node --test src/services/identity.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const DIR = mkdtempSync(join(tmpdir(), 'sumire-identity-'));
process.env.SUMIRE_DATA_DIR = DIR;

const { identityPath, loadPinnedIdentity, pinnedIdentityForUid, resetPinnedIdentityCache } = await import(
  './identity.ts'
);

after(() => rmSync(DIR, { recursive: true, force: true }));

function writeIdentity(value: unknown): void {
  mkdirSync(join(DIR, 'captures'), { recursive: true });
  writeFileSync(identityPath(), JSON.stringify(value));
  resetPinnedIdentityCache();
}

test('a missing identity file means no pinned account', () => {
  rmSync(join(DIR, 'captures'), { recursive: true, force: true });
  resetPinnedIdentityCache();
  assert.equal(identityPath(), join(DIR, 'captures', 'identity.json'));
  assert.equal(loadPinnedIdentity(), null);
  assert.equal(pinnedIdentityForUid('any-uid'), null);
});

test('reads a complete identity and scopes it to its Firebase UID', () => {
  const identity = {
    firebaseUid: 'test-firebase-uid',
    serverUserId: 'test-server-user-id',
    publicUserId: 'TESTPUB1',
    player: { name: 'Player', level: 40, exp: 0, gold: 0, freeJewel: 0 },
  };
  writeIdentity(identity);
  assert.deepEqual(loadPinnedIdentity(), identity);
  assert.deepEqual(pinnedIdentityForUid('test-firebase-uid'), identity);
  assert.equal(pinnedIdentityForUid('some-other-uid'), null);
  assert.equal(pinnedIdentityForUid(null), null);
});

test('an invalid identity file is ignored', () => {
  writeIdentity({ firebaseUid: 'only-one-field' });
  assert.equal(loadPinnedIdentity(), null);
});

test('unreadable JSON is ignored', () => {
  mkdirSync(join(DIR, 'captures'), { recursive: true });
  writeFileSync(identityPath(), '{ not json');
  resetPinnedIdentityCache();
  assert.equal(loadPinnedIdentity(), null);
});
