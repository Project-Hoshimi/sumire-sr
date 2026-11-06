// Client CA bootstrap endpoint tests. Unit-level: they build the real Fastify
// server and use `inject`, so no listener or game data is needed.
//
//   node --test src/caBootstrap.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildServer, buildSniCallback } from './server.ts';

// A throwaway CA made per run: the repo's own tls/ directory is not exported,
// and this test has to pass from a fresh public clone.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'sumire-ca-fixture-'));
process.on('exit', () => rmSync(FIXTURE_DIR, { recursive: true, force: true }));
const CA_PATH = join(FIXTURE_DIR, 'ca.crt');
const generated = spawnSync(
  'openssl',
  [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=sumire-sr test CA',
    '-keyout', join(FIXTURE_DIR, 'ca.key'),
    '-out', CA_PATH,
  ],
  { encoding: 'utf8' },
);
assert.equal(generated.status, 0, `openssl could not create the test CA: ${generated.stderr}`);

function shortFingerprint(fingerprint256: string): string {
  return fingerprint256.split(':').slice(0, 8).join(':');
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'sumire-ca-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('GET /.well-known/sumire/ca.pem serves only the parsed certificate', async (t) => {
  process.env.TLS_CA_CERT = CA_PATH;
  const app = buildServer();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/.well-known/sumire/ca.pem' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /^application\/x-pem-file/);

  const { X509Certificate } = await import('node:crypto');
  const expected = new X509Certificate(readFileSync(CA_PATH)).toString();
  assert.equal(res.body.trim(), expected.trim());
  assert.equal(res.body.match(/-----BEGIN CERTIFICATE-----/g)?.length, 1);
  assert.doesNotMatch(res.body, /PRIVATE KEY/);
});

test('ca.pem strips a private key block appended to TLS_CA_CERT', async (t) => {
  const dir = tempDir(t);
  const combined = join(dir, 'ca-with-key.pem');
  copyFileSync(CA_PATH, combined);
  appendFileSync(combined, `\n${readFileSync(join(FIXTURE_DIR, 'ca.key'), 'utf8')}`);
  assert.match(readFileSync(combined, 'utf8'), /PRIVATE KEY/);

  process.env.TLS_CA_CERT = combined;
  const app = buildServer();
  t.after(() => app.close());

  const pemRes = await app.inject({ method: 'GET', url: '/.well-known/sumire/ca.pem' });
  assert.equal(pemRes.statusCode, 200);
  assert.equal(pemRes.body.match(/-----BEGIN CERTIFICATE-----/g)?.length, 1);
  assert.equal(pemRes.body.match(/-----END CERTIFICATE-----/g)?.length, 1);
  assert.doesNotMatch(pemRes.body, /PRIVATE KEY/);

  // The served certificate is the CA cert, not something mangled by the key block.
  const { X509Certificate } = await import('node:crypto');
  const expected = new X509Certificate(readFileSync(CA_PATH)).fingerprint256;
  const jsonRes = await app.inject({ method: 'GET', url: '/.well-known/sumire/server.json' });
  assert.equal(jsonRes.statusCode, 200);
  const body = jsonRes.json() as { caSha256: string; caSha256Short: string };
  assert.equal(body.caSha256, expected);
  assert.equal(body.caSha256Short, shortFingerprint(expected));
});

test('GET /.well-known/sumire/server.json reports name and fingerprints', async (t) => {
  process.env.TLS_CA_CERT = CA_PATH;
  process.env.SUMIRE_SERVER_NAME = 'test-sumire';
  const app = buildServer();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/.well-known/sumire/server.json' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /^application\/json/);

  const body = res.json() as { name: string; caSha256: string; caSha256Short: string };
  const expected = readFileSync(CA_PATH, 'utf8');
  const { X509Certificate } = await import('node:crypto');
  const fingerprint = new X509Certificate(expected).fingerprint256;

  assert.equal(body.name, 'test-sumire');
  assert.equal(body.caSha256, fingerprint);
  assert.equal(body.caSha256Short, shortFingerprint(fingerprint));
});

test('server.json defaults the name to sumire-sr', async (t) => {
  process.env.TLS_CA_CERT = CA_PATH;
  delete process.env.SUMIRE_SERVER_NAME;
  const app = buildServer();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/.well-known/sumire/server.json' });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { name: string }).name, 'sumire-sr');
});

test('fingerprint matches openssl x509 -fingerprint -sha256', async (t) => {
  process.env.TLS_CA_CERT = CA_PATH;
  const app = buildServer();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/.well-known/sumire/server.json' });
  const body = res.json() as { caSha256: string; caSha256Short: string };

  const out = spawnSync('openssl', ['x509', '-in', CA_PATH, '-noout', '-fingerprint', '-sha256'], {
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  const match = out.stdout.match(/=\s*([0-9A-Fa-f:]+)/);
  assert.ok(match, `unexpected openssl output: ${out.stdout}`);
  const opensslFingerprint = match[1].toUpperCase();

  assert.equal(body.caSha256, opensslFingerprint);
  assert.equal(body.caSha256Short, shortFingerprint(opensslFingerprint));
});

test('both endpoints return 404 when the CA file is missing', async (t) => {
  process.env.TLS_CA_CERT = join(import.meta.dirname, '..', '..', 'tls', 'does-not-exist-ca.crt');
  const app = buildServer();
  t.after(() => app.close());

  for (const url of ['/.well-known/sumire/ca.pem', '/.well-known/sumire/server.json']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, url);
  }
});

test('buildSniCallback selects the public context only for its hostname', async (t) => {
  const dir = tempDir(t);
  const certPath = join(dir, 'public.crt');
  const keyPath = join(dir, 'public.key');
  const gen = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=public.example.test',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(gen.status, 0, gen.stderr);

  const sni = buildSniCallback({ hostname: 'Public.Example.Test', certPath, keyPath });

  const matching = await new Promise<{ err: Error | null; ctx: unknown }>((resolve) => {
    sni('public.example.test', (err, ctx) => resolve({ err, ctx }));
  });
  assert.equal(matching.err, null);
  assert.ok(matching.ctx, 'expected a SecureContext for the configured hostname');

  const other = await new Promise<{ err: Error | null; ctx: unknown }>((resolve) => {
    sni('api.octo-cloud.com', (err, ctx) => resolve({ err, ctx }));
  });
  assert.equal(other.err, null);
  assert.equal(other.ctx, undefined);
});

test('buildSniCallback names the env vars and paths when the cert cannot load', async (t) => {
  const dir = tempDir(t);
  const certPath = join(dir, 'missing.crt');
  const keyPath = join(dir, 'missing.key');
  writeFileSync(certPath, 'not a certificate');

  assert.throws(
    () => buildSniCallback({ hostname: 'public.example.test', certPath, keyPath }),
    (err: Error) => {
      assert.match(err.message, /TLS_PUBLIC_CERT/);
      assert.match(err.message, /TLS_PUBLIC_KEY/);
      assert.match(err.message, new RegExp(certPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(err.message, new RegExp(keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});
