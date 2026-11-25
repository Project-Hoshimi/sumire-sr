// Unit tests for ensureTlsCert() and SAN generation.
//
//   node --test src/tls.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildSanExtension, ensureTlsCert, findOpenSsl } from './tls.ts';

const OPENSSL = findOpenSsl();

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'sumire-tls-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Names left in `dir` that must never survive a generation attempt. */
function leftovers(dir: string): string[] {
  return readdirSync(dir).filter(
    (name) => name === 'api.csr' || name === 'api.ext' || name === 'ca.srl' || name.includes('.tmp-'),
  );
}

/** Write a throwaway 2048-bit private key (and cert) of its own. */
function makeStrayKeyPair(dir: string, name: string): { key: string; crt: string } {
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.crt`);
  const res = spawnSync(
    OPENSSL,
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-subj', `/CN=${name}`, '-keyout', key, '-out', crt,
    ],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  assert.equal(res.status, 0, `openssl could not create ${name}: ${res.stderr}`);
  return { key, crt };
}

test('ensureTlsCert generates a CA-signed leaf cert with all required SANs and reuses it on rerun', (t) => {
  const dir = tempDir(t);

  const first = ensureTlsCert(dir, '0.0.0.0');
  const caCrtPath = join(dir, 'ca.crt');
  const caKeyPath = join(dir, 'ca.key');
  const apiCrtPath = join(dir, 'api.crt');
  const apiKeyPath = join(dir, 'api.key');

  assert.equal(existsSync(caCrtPath), true);
  assert.equal(existsSync(caKeyPath), true);
  assert.equal(existsSync(apiCrtPath), true);
  assert.equal(existsSync(apiKeyPath), true);
  assert.equal(first.allowHTTP1, true);

  const ca = new X509Certificate(readFileSync(caCrtPath));
  const leaf = new X509Certificate(first.cert);
  assert.equal(leaf.verify(ca.publicKey), true, 'leaf cert must be signed by generated CA');
  assert.match(ca.subject, /CN=Idoly Pride Dev CA/);
  assert.match(leaf.subject, /CN=api\.game-idolypride\.jp/);

  const san = leaf.subjectAltName ?? '';
  for (const expected of [
    'DNS:api.game-idolypride.jp',
    'DNS:climaster.game-idolypride.jp',
    'DNS:api.octo-cloud.com',
    'DNS:identitytoolkit.googleapis.com',
    'DNS:securetoken.googleapis.com',
    'DNS:www.googleapis.com',
    'DNS:firebasestorage.googleapis.com',
    'DNS:localhost',
    'IP Address:127.0.0.1',
  ]) {
    assert.ok(san.includes(expected), `expected SAN to include ${expected}, got: ${san}`);
  }

  if (process.platform !== 'win32') {
    assert.equal(statSync(caKeyPath).mode & 0o777, 0o600);
    assert.equal(statSync(apiKeyPath).mode & 0o777, 0o600);
  }

  const caCrtBefore = readFileSync(caCrtPath);
  const caKeyBefore = readFileSync(caKeyPath);
  const apiCrtBefore = readFileSync(apiCrtPath);
  const apiKeyBefore = readFileSync(apiKeyPath);

  const second = ensureTlsCert(dir, '0.0.0.0');
  assert.deepEqual(second.cert, apiCrtBefore);
  assert.deepEqual(second.key, apiKeyBefore);
  assert.deepEqual(readFileSync(caCrtPath), caCrtBefore);
  assert.deepEqual(readFileSync(caKeyPath), caKeyBefore);
});

test('ensureTlsCert returns existing api.key and api.crt without overwriting when ca.crt is absent', (t) => {
  const dir = tempDir(t);
  ensureTlsCert(dir, '0.0.0.0');

  const apiCrtBefore = readFileSync(join(dir, 'api.crt'));
  const apiKeyBefore = readFileSync(join(dir, 'api.key'));
  unlinkSync(join(dir, 'ca.crt'));
  unlinkSync(join(dir, 'ca.key'));

  const result = ensureTlsCert(dir, '0.0.0.0');
  assert.deepEqual(result.cert, apiCrtBefore);
  assert.deepEqual(result.key, apiKeyBefore);
  assert.equal(existsSync(join(dir, 'ca.crt')), false, 'must not recreate CA when leaf already exists');
});

test('ensureTlsCert reuses existing CA pair when only leaf files are missing', (t) => {
  const dir = tempDir(t);
  ensureTlsCert(dir, '0.0.0.0');

  const caCrtBefore = readFileSync(join(dir, 'ca.crt'));
  const caKeyBefore = readFileSync(join(dir, 'ca.key'));
  unlinkSync(join(dir, 'api.crt'));
  unlinkSync(join(dir, 'api.key'));

  const result = ensureTlsCert(dir, '0.0.0.0');
  assert.deepEqual(readFileSync(join(dir, 'ca.crt')), caCrtBefore, 'existing CA cert must not be overwritten');
  assert.deepEqual(readFileSync(join(dir, 'ca.key')), caKeyBefore, 'existing CA key must not be overwritten');

  const ca = new X509Certificate(caCrtBefore);
  const newLeaf = new X509Certificate(result.cert);
  assert.equal(newLeaf.verify(ca.publicKey), true, 'regenerated leaf must be signed by existing CA');
});

test('ensureTlsCert refuses to overwrite existing ca.crt when ca.key is missing', (t) => {
  const dir = tempDir(t);
  ensureTlsCert(dir, '0.0.0.0');

  const caCrtBefore = readFileSync(join(dir, 'ca.crt'));
  unlinkSync(join(dir, 'ca.key'));
  unlinkSync(join(dir, 'api.crt'));
  unlinkSync(join(dir, 'api.key'));

  assert.throws(() => ensureTlsCert(dir, '0.0.0.0'), /without .*ca\.key/);
  assert.deepEqual(readFileSync(join(dir, 'ca.crt')), caCrtBefore, 'existing ca.crt must remain untouched');
});

test('ensureTlsCert refuses to overwrite a partial leaf pair', (t) => {
  const dir = tempDir(t);
  const apiCrtPath = join(dir, 'api.crt');
  writeFileSync(apiCrtPath, 'existing-leaf-cert');

  assert.throws(() => ensureTlsCert(dir, '0.0.0.0'), /incomplete TLS leaf pair/);
  assert.equal(readFileSync(apiCrtPath, 'utf8'), 'existing-leaf-cert');
});

test('buildSanExtension validates HOST and rejects stray commas or newlines', () => {
  const withIp = buildSanExtension('192.0.2.10');
  assert.match(withIp, /IP:192\.0\.2\.10/);

  const withHost = buildSanExtension('sumire.example.test');
  assert.match(withHost, /DNS:sumire\.example\.test/);

  const withComma = buildSanExtension('bad,DNS:evil.example');
  assert.doesNotMatch(withComma, /evil\.example/);

  const withNewline = buildSanExtension('bad\nDNS:evil.example');
  assert.doesNotMatch(withNewline, /evil\.example/);
});

test('ensureTlsCert leaves no csr/ext/srl or temp files behind', (t) => {
  const dir = tempDir(t);

  ensureTlsCert(dir, '0.0.0.0');

  assert.deepEqual(leftovers(dir), [], `unexpected intermediate files: ${leftovers(dir).join(', ')}`);
  assert.deepEqual(readdirSync(dir).sort(), ['api.crt', 'api.key', 'ca.crt', 'ca.key']);
});

test('ensureTlsCert restores the process umask after generating keys', (t) => {
  const dir = tempDir(t);
  const before = process.umask();

  ensureTlsCert(dir, '0.0.0.0');

  assert.equal(process.umask(), before);
});

test('ensureTlsCert warns about an invalid HOST and still produces a usable cert', (t) => {
  const dir = tempDir(t);
  const warnings: string[] = [];
  const original = console.warn;
  let result: ReturnType<typeof ensureTlsCert>;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    result = ensureTlsCert(dir, 'bad host_name');
  } finally {
    console.warn = original;
  }

  const leaf = new X509Certificate(result.cert);
  const ca = new X509Certificate(readFileSync(join(dir, 'ca.crt')));
  assert.equal(leaf.verify(ca.publicKey), true);
  assert.doesNotMatch(leaf.subjectAltName ?? '', /bad host_name/);

  const warned = warnings.join('\n');
  assert.match(warned, /invalid HOST/);
  assert.ok(
    warned.includes(JSON.stringify('bad host_name')),
    `warning should name the rejected value, got: ${warned}`,
  );
});

test('ensureTlsCert throws when ca.crt and ca.key hold different keys', (t) => {
  const dir = tempDir(t);
  ensureTlsCert(dir, '0.0.0.0');
  const stray = makeStrayKeyPair(dir, 'stray');
  writeFileSync(join(dir, 'ca.key'), readFileSync(stray.key));
  unlinkSync(join(dir, 'api.crt'));
  unlinkSync(join(dir, 'api.key'));

  assert.throws(() => ensureTlsCert(dir, '0.0.0.0'), /do not belong together/);
  assert.equal(existsSync(join(dir, 'api.key')), false, 'no leaf key may be written after a CA mismatch');
  assert.equal(existsSync(join(dir, 'api.crt')), false, 'no leaf cert may be written after a CA mismatch');
  assert.deepEqual(leftovers(dir), [], 'failed run must clean up its temp files');
});

test('ensureTlsCert leaves no api.key/api.crt when the CA key is corrupt', (t) => {
  const dir = tempDir(t);
  ensureTlsCert(dir, '0.0.0.0');
  writeFileSync(join(dir, 'ca.key'), 'not a private key');
  unlinkSync(join(dir, 'api.crt'));
  unlinkSync(join(dir, 'api.key'));

  assert.throws(() => ensureTlsCert(dir, '0.0.0.0'), /do not belong together/);
  assert.equal(existsSync(join(dir, 'api.key')), false);
  assert.equal(existsSync(join(dir, 'api.crt')), false);
  assert.deepEqual(leftovers(dir), []);
});
