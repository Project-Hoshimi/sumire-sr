// Admin UI static-hosting tests: index + asset headers, traversal rejection,
// missing-build behaviour and API-route precedence. No listener, no Postgres.
//
//   node --test src/routes/adminUi.test.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { memoryAdminStore } from '../services/admin/store.ts';
import { adminRoutes } from './admin.ts';
import { ADMIN_UI_CSP, ADMIN_UI_MISSING_TEXT, adminUiRoutes } from './adminUi.ts';

const INDEX_HTML =
  '<!doctype html><html><body><div id="root"></div>' +
  '<script type="module" src="/sumire/admin/assets/app.js"></script></body></html>';
const ASSET_JS = 'console.log("sumire admin");';

/** A fake `admin/dist` with index.html, assets/app.js and a sibling secret. */
function makeUiDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'sumire-admin-ui-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), INDEX_HTML);
  writeFileSync(join(root, 'assets', 'app.js'), ASSET_JS);
  // Outside `dist/assets` on purpose: must never be reachable.
  writeFileSync(join(root, 'secret.txt'), 'top-secret');
  return root;
}

function buildApp(uiDir: string): FastifyInstance {
  const app = Fastify();
  app.register(cookie);
  app.register(adminRoutes, { store: memoryAdminStore() });
  app.register(adminUiRoutes, { dir: uiDir });
  return app;
}

/** Register the UI plugin with no `dir`, so SUMIRE_ADMIN_UI_DIR is consulted. */
function buildAppFromEnv(): FastifyInstance {
  const app = Fastify();
  app.register(cookie);
  app.register(adminRoutes, { store: memoryAdminStore() });
  app.register(adminUiRoutes);
  return app;
}

function cleanup(t: { after: (fn: () => Promise<void> | void) => void }, app: FastifyInstance, dir?: string) {
  t.after(async () => {
    await app.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });
}

test('GET /sumire/admin redirects to the trailing-slash URL', async (t) => {
  const dir = makeUiDir();
  const app = buildApp(dir);
  cleanup(t, app, dir);

  const res = await app.inject({ method: 'GET', url: '/sumire/admin' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/sumire/admin/');
});

test('GET /sumire/admin/ serves index.html with the security headers', async (t) => {
  const dir = makeUiDir();
  const app = buildApp(dir);
  cleanup(t, app, dir);

  const res = await app.inject({ method: 'GET', url: '/sumire/admin/' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/html/);
  assert.equal(res.body, INDEX_HTML);
  assert.equal(res.headers['content-security-policy'], ADMIN_UI_CSP);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('GET /sumire/admin/assets/* serves files with a long-lived cache', async (t) => {
  const dir = makeUiDir();
  const app = buildApp(dir);
  cleanup(t, app, dir);

  const res = await app.inject({ method: 'GET', url: '/sumire/admin/assets/app.js' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /javascript/);
  assert.equal(res.body, ASSET_JS);
  assert.equal(res.headers['content-security-policy'], ADMIN_UI_CSP);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(String(res.headers['cache-control']), /immutable/);
});

test('asset paths cannot escape dist/assets', async (t) => {
  const dir = makeUiDir();
  const app = buildApp(dir);
  cleanup(t, app, dir);

  for (const url of [
    '/sumire/admin/assets/../secret.txt',
    '/sumire/admin/assets/../../package.json',
    '/sumire/admin/assets/%2e%2e/%2e%2e/package.json',
    '/sumire/admin/assets/..%2f..%2fpackage.json',
  ]) {
    const res = await app.inject({ method: 'GET', url });
    assert.notEqual(res.statusCode, 200, `expected ${url} to be rejected, got ${res.statusCode}`);
    assert.ok(!res.body.includes('top-secret'), `${url} leaked secret.txt`);
    assert.ok(!res.body.includes('@sumire-sr/server'), `${url} leaked package.json`);
  }
});

test('directory listing and non-asset files are not served', async (t) => {
  const dir = makeUiDir();
  const app = buildApp(dir);
  cleanup(t, app, dir);

  const listing = await app.inject({ method: 'GET', url: '/sumire/admin/assets/' });
  assert.notEqual(listing.statusCode, 200);
  assert.match(listing.body, /forbidden|not found/i);

  const sibling = await app.inject({ method: 'GET', url: '/sumire/admin/secret.txt' });
  assert.equal(sibling.statusCode, 404);
});

test('index.html is cached until its mtime changes', async (t) => {
  const dir = makeUiDir();
  const app = buildApp(dir);
  cleanup(t, app, dir);

  const first = await app.inject({ method: 'GET', url: '/sumire/admin/' });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, INDEX_HTML);

  // Simulate a rebuild: contents change and the mtime moves forward.
  const rebuilt = '<!doctype html><html><body><div id="root">rebuilt</div></body></html>';
  const indexPath = join(dir, 'index.html');
  writeFileSync(indexPath, rebuilt);
  const future = new Date(Date.now() + 5_000);
  utimesSync(indexPath, future, future);

  const second = await app.inject({ method: 'GET', url: '/sumire/admin/' });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body, rebuilt);

  // Removing the file is noticed on the next request too.
  rmSync(indexPath);
  const missing = await app.inject({ method: 'GET', url: '/sumire/admin/' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body, ADMIN_UI_MISSING_TEXT);
});

test('missing assets carry the security headers', async (t) => {
  const dir = makeUiDir();
  const app = buildApp(dir);
  cleanup(t, app, dir);

  const res = await app.inject({ method: 'GET', url: '/sumire/admin/assets/missing.js' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['content-security-policy'], ADMIN_UI_CSP);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

test('a missing build returns 404 text and does not shadow the API', async (t) => {
  const missing = join(tmpdir(), `sumire-admin-missing-${randomUUID()}`);
  const app = buildApp(missing);
  cleanup(t, app);

  const index = await app.inject({ method: 'GET', url: '/sumire/admin/' });
  assert.equal(index.statusCode, 404);
  assert.match(String(index.headers['content-type']), /^text\/plain/);
  assert.equal(index.body, ADMIN_UI_MISSING_TEXT);

  // The server still boots and the JSON API routes win over any UI handler.
  const session = await app.inject({ method: 'GET', url: '/sumire/admin/session' });
  assert.equal(session.statusCode, 401);
  assert.deepEqual(session.json(), { error: 'unauthorized' });
});

test('a missing SUMIRE_ADMIN_UI_DIR does not throw while the server starts', async (t) => {
  const missing = join(tmpdir(), `sumire-admin-env-missing-${randomUUID()}`);
  const previous = process.env.SUMIRE_ADMIN_UI_DIR;
  process.env.SUMIRE_ADMIN_UI_DIR = missing;
  t.after(() => {
    if (previous === undefined) delete process.env.SUMIRE_ADMIN_UI_DIR;
    else process.env.SUMIRE_ADMIN_UI_DIR = previous;
  });

  const app = buildAppFromEnv();
  cleanup(t, app);
  await app.ready();

  const index = await app.inject({ method: 'GET', url: '/sumire/admin/' });
  assert.equal(index.statusCode, 404);
  assert.equal(index.body, ADMIN_UI_MISSING_TEXT);
});

test('the built UI never shadows existing admin API routes', async (t) => {
  const dir = makeUiDir();
  const app = buildApp(dir);
  cleanup(t, app, dir);

  for (const url of ['/sumire/admin/session', '/sumire/admin/login']) {
    const res = await app.inject({ method: 'GET', url });
    assert.notEqual(res.statusCode, 200, `${url} should not return the index`);
    assert.doesNotMatch(res.body, /<div id="root">/);
  }
});
