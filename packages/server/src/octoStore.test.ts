// Experimental local Octo store tests. Data-free: the database, bundle files and
// AES key/IV are all synthetic and generated per run; no network access.
//
//   node src/octoStore.test.ts
import assert from 'node:assert/strict';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DEFAULT_OCTO_URL_FORMAT,
  OctoStore,
  registerOctoStore,
  registerOctoStoreRoutes,
  rewriteOctoDatabase,
} from './octoStore.ts';

// --- tiny protobuf writer for synthetic fixtures ---------------------------------
function varint(n: number): Buffer {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}
const vField = (num: number, v: number) => Buffer.concat([varint(num << 3), varint(v)]);
const lField = (num: number, b: Buffer | string) => {
  const bytes = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  return Buffer.concat([varint((num << 3) | 2), varint(bytes.length), bytes]);
};
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

const bundleA = Buffer.from('synthetic bundle A, not a real asset');
const bundleB = Buffer.from('synthetic resource B');
const bundleC = Buffer.from('synthetic bundle C with a wrong size on disk');

function data(id: number, name: string, objectName: string, body: Buffer, size = body.length): Buffer {
  return Buffer.concat([vField(1, id), lField(2, `${name}.bin`), lField(3, name), vField(4, size), vField(9, 2), lField(10, md5(body)), lField(11, objectName), vField(12, 1700000000000000), vField(13, 202050)]);
}

const database = Buffer.concat([
  vField(1, 4242),
  lField(2, data(1, 'sud_fixture_a', 'objA01', bundleA)),
  lField(2, data(3, 'img_fixture_c', 'objC03', bundleC, bundleC.length + 1)),
  lField(3, 'tag-fixture'),
  lField(4, data(2, 'res_fixture_b', 'objB02', bundleB)),
  lField(5, 'https://cdn.invalid/solis-{v}-{type}/{o}?generation={g}&alt=media'),
]);

const key = randomBytes(32);
const iv = randomBytes(16);
const base = mkdtempSync(join(tmpdir(), 'sumire-octo-'));
const dirNested = join(base, 'files');
const dirFlat = join(base, 'flat');
const dbPath = join(base, 'rev.plain');

function decryptList(body: Buffer): Buffer {
  const d = createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([d.update(body), d.final()]);
  return plain.subarray(16);
}

/** Same catch-all shapes as buildServer(): RPC routes plus the `/v2/*` upstream proxy. */
function appWith(env: NodeJS.ProcessEnv): FastifyInstance {
  const app = Fastify({ logger: false });
  registerOctoStore(app, env);
  app.all('/api/*', async () => 'rpc');
  app.all('/:service/:method', async () => 'rpc');
  app.all('/v2/*', async () => 'octo-proxy');
  return app;
}

const env = (): NodeJS.ProcessEnv => ({
  SUMIRE_OCTO_DATABASE: dbPath,
  SUMIRE_OCTO_ASSETS: [dirNested, dirFlat].join(delimiter),
  SUMIRE_OCTO_AES_KEY: key.toString('hex'),
  SUMIRE_OCTO_AES_IV: iv.toString('hex'),
});

// --- upstream-fill fixtures ------------------------------------------------------

const FILL_TEMPLATE = 'https://cdn.invalid/solis-{v}-{type}/{o}?generation={g}&alt=media';

type FetchCall = { url: string; init?: RequestInit };

/** Fetch stub that records every URL and delegates to `handler`. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

/** One-object database and two asset dirs in a throwaway temp tree. `first` is the fill target. */
function fillFixture(opts: { objectName: string; body: Buffer; upstreamFill: boolean; fetchImpl: typeof fetch; kindField?: 2 | 4 }) {
  const root = mkdtempSync(join(tmpdir(), 'sumire-octo-fill-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const db = Buffer.concat([
    vField(1, 1),
    lField(opts.kindField ?? 2, data(1, opts.objectName, opts.objectName, opts.body)),
    lField(5, FILL_TEMPLATE),
  ]);
  const app = Fastify({ logger: false });
  const store = new OctoStore({
    database: db,
    assetDirs: [first, second],
    aesKey: key,
    aesIv: iv,
    upstreamFill: opts.upstreamFill,
    fetchImpl: opts.fetchImpl,
  });
  registerOctoStoreRoutes(app, store);
  return { app, store, first, second, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

let app: FastifyInstance;

before(async () => {
  mkdirSync(join(dirNested, md5(bundleA).slice(0, 2)), { recursive: true });
  writeFileSync(join(dirNested, md5(bundleA).slice(0, 2), md5(bundleA)), bundleA);
  mkdirSync(dirFlat, { recursive: true });
  writeFileSync(join(dirFlat, md5(bundleB)), bundleB);
  writeFileSync(join(dirFlat, md5(bundleC)), bundleC);
  writeFileSync(dbPath, database);
  app = appWith(env());
  await app.ready();
});

after(async () => {
  await app?.close();
  rmSync(base, { recursive: true, force: true });
});

describe('rewriteOctoDatabase', () => {
  test('indexes both lists, keeps other fields, replaces urlFormat once', () => {
    const { bytes, revision, assets } = rewriteOctoDatabase(database, 'https://local/{type}/{o}');
    assert.equal(revision, 4242);
    assert.deepEqual([...assets.keys()].sort(), ['objA01', 'objB02', 'objC03']);
    assert.equal(assets.get('objA01')?.md5, md5(bundleA));
    assert.ok(bytes.includes(Buffer.from('tag-fixture')));
    assert.ok(!bytes.includes(Buffer.from('cdn.invalid')));
    assert.equal(bytes.indexOf(Buffer.from('https://local/{type}/{o}')), bytes.lastIndexOf(Buffer.from('https://local/{type}/{o}')));
    // Re-indexing the rewritten bytes is stable.
    assert.equal(rewriteOctoDatabase(bytes, 'x').assets.size, 3);
  });
  test('rejects truncated input', () => {
    assert.throws(() => rewriteOctoDatabase(Buffer.from([0x12, 0x05, 0x01]), 'x'));
  });
});

describe('OctoStore configuration', () => {
  test('validates key, IV and asset dirs', () => {
    assert.throws(() => new OctoStore({ database, assetDirs: [dirFlat], aesKey: randomBytes(16), aesIv: iv }));
    assert.throws(() => new OctoStore({ database, assetDirs: [dirFlat], aesKey: key, aesIv: randomBytes(8) }));
    assert.throws(() => new OctoStore({ database, assetDirs: [], aesKey: key, aesIv: iv }));
  });
  test('missing key env fails loudly when the store is enabled', () => {
    assert.throws(() => appWith({ SUMIRE_OCTO_DATABASE: dbPath, SUMIRE_OCTO_ASSETS: dirFlat }), /SUMIRE_OCTO_AES_KEY/);
  });
});

describe('list route', () => {
  test('serves the encrypted, rewritten database with an Octo-style ETag', async () => {
    const r = await app.inject({ method: 'GET', url: '/v2/pub/a/212/v/205051/list/0' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'application/x-protobuf');
    assert.equal(r.headers.etag, '"3.212.205051.0.4242"');
    const plain = decryptList(r.rawPayload);
    const parsed = rewriteOctoDatabase(plain, 'unused');
    assert.equal(parsed.revision, 4242);
    assert.ok(plain.includes(Buffer.from(DEFAULT_OCTO_URL_FORMAT)));
    assert.ok(!plain.includes(Buffer.from('cdn.invalid')));
  });
  test('rejects non-numeric app/version', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/v2/pub/a/x/v/1/list/0' })).statusCode, 400);
  });
});

describe('file route', () => {
  test('serves nested and flat MD5 layouts byte-exact', async () => {
    const a = await app.inject({ method: 'GET', url: '/octo/assetbundle/objA01?v=202050&g=1' });
    assert.equal(a.statusCode, 200);
    assert.deepEqual(a.rawPayload, bundleA);
    assert.equal(a.headers['content-length'], String(bundleA.length));
    const b = await app.inject({ method: 'GET', url: '/octo/resources/objB02' });
    assert.deepEqual(b.rawPayload, bundleB);
  });
  test('range and HEAD', async () => {
    const r = await app.inject({ method: 'GET', url: '/octo/assetbundle/objA01', headers: { range: 'bytes=0-8' } });
    assert.equal(r.statusCode, 206);
    assert.deepEqual(r.rawPayload, bundleA.subarray(0, 9));
    const h = await app.inject({ method: 'HEAD', url: '/octo/assetbundle/objA01' });
    assert.equal(h.headers['content-length'], String(bundleA.length));
    assert.equal(h.rawPayload.length, 0);
  });
  test('unknown, malformed and size-mismatched objects are refused', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/octo/assetbundle/objZZ' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/octo/assetbundle/objC03' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/octo/assetbundle/..%2Frev.plain' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/octo/other/objA01' })).statusCode, 400);
  });
  test('an object is only served under the list it came from', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/octo/assetbundle/objB02' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/octo/resources/objA01' })).statusCode, 404);
  });
});

describe('route coexistence', () => {
  test('other /v2 paths and non-GET list calls still reach the proxy', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/v2/pub/a/212/v/205051/list/0' })).body, 'octo-proxy');
    assert.equal((await app.inject({ method: 'GET', url: '/v2/pub/a/212/v/205051/other' })).body, 'octo-proxy');
    assert.equal((await app.inject({ method: 'POST', url: '/api.Foo/Bar' })).body, 'rpc');
  });
  test('disabled (no SUMIRE_OCTO_DATABASE): the list is proxied upstream as before', async () => {
    const disabled = appWith({});
    try {
      assert.equal((await disabled.inject({ method: 'GET', url: '/v2/pub/a/212/v/205051/list/0' })).body, 'octo-proxy');
      assert.equal((await disabled.inject({ method: 'GET', url: '/octo/assetbundle/objA01' })).statusCode, 404);
    } finally {
      await disabled.close();
    }
  });
});

describe('upstream fill', () => {
  test('(a) fill off: a missing listed file is still 404 and fetch is never called', async () => {
    const body = Buffer.from('never fetched (a)');
    const fetchStub = fakeFetch(() => {
      throw new Error('fetch must not be called');
    });
    const fx = fillFixture({ objectName: 'objD04', body, upstreamFill: false, fetchImpl: fetchStub.impl });
    try {
      const r = await fx.app.inject({ method: 'GET', url: '/octo/assetbundle/objD04' });
      assert.equal(r.statusCode, 404);
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      await fx.app.close();
      fx.cleanup();
    }
  });

  test('(b) fill on: missing file is fetched, verified, saved and then served from disk', async () => {
    const body = Buffer.from('fetch me (b)');
    const fetchStub = fakeFetch(() => new Response(body, { status: 200 }));
    const fx = fillFixture({ objectName: 'objD04', body, upstreamFill: true, fetchImpl: fetchStub.impl });
    try {
      const first = await fx.app.inject({ method: 'GET', url: '/octo/assetbundle/objD04' });
      assert.equal(first.statusCode, 200);
      assert.deepEqual(first.rawPayload, body);
      const dest = join(fx.first, md5(body).slice(0, 2), md5(body));
      assert.deepEqual(readFileSync(dest), body);
      const second = await fx.app.inject({ method: 'GET', url: '/octo/assetbundle/objD04' });
      assert.equal(second.statusCode, 200);
      assert.deepEqual(second.rawPayload, body);
      assert.equal(fetchStub.calls.length, 1);
    } finally {
      await fx.app.close();
      fx.cleanup();
    }
  });

  test('(c) md5 mismatch: 502 and no file (or .tmp) is written', async () => {
    const body = Buffer.from('fetch me (c)');
    const wrong = Buffer.alloc(body.length, 0x5a);
    const fetchStub = fakeFetch(() => new Response(wrong, { status: 200 }));
    const fx = fillFixture({ objectName: 'objE05', body, upstreamFill: true, fetchImpl: fetchStub.impl });
    try {
      const r = await fx.app.inject({ method: 'GET', url: '/octo/assetbundle/objE05' });
      assert.equal(r.statusCode, 502);
      assert.equal(r.body, 'upstream fill failed');
      assert.deepEqual(readdirSync(fx.first), []);
    } finally {
      await fx.app.close();
      fx.cleanup();
    }
  });

  test('(d) non-200 upstream: 502 and nothing written', async () => {
    const body = Buffer.from('fetch me (d)');
    const fetchStub = fakeFetch(() => new Response('missing', { status: 404 }));
    const fx = fillFixture({ objectName: 'objF06', body, upstreamFill: true, fetchImpl: fetchStub.impl });
    try {
      const r = await fx.app.inject({ method: 'GET', url: '/octo/assetbundle/objF06' });
      assert.equal(r.statusCode, 502);
      assert.equal(fetchStub.calls.length, 1);
      assert.deepEqual(readdirSync(fx.first), []);
    } finally {
      await fx.app.close();
      fx.cleanup();
    }
  });

  test('(e) concurrent requests share one fetch and both succeed', async () => {
    const body = Buffer.from('fetch me (e)');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchStub = fakeFetch(async () => {
      await gate;
      return new Response(body, { status: 200 });
    });
    const fx = fillFixture({ objectName: 'objG07', body, upstreamFill: true, fetchImpl: fetchStub.impl });
    try {
      const p1 = fx.app.inject({ method: 'GET', url: '/octo/assetbundle/objG07' });
      const p2 = fx.app.inject({ method: 'GET', url: '/octo/assetbundle/objG07' });
      while (fetchStub.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
      // Give the second request time to join the in-flight fill before releasing it.
      await new Promise((r) => setTimeout(r, 50));
      release();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
      assert.deepEqual(r1.rawPayload, body);
      assert.deepEqual(r2.rawPayload, body);
      assert.equal(fetchStub.calls.length, 1);
    } finally {
      await fx.app.close();
      fx.cleanup();
    }
  });

  test('(f) unlisted objects and kind mismatches are 404 and never fetch', async () => {
    const body = Buffer.from('fetch me (f)');
    const fetchStub = fakeFetch(() => {
      throw new Error('fetch must not be called');
    });
    const fx = fillFixture({ objectName: 'objH08', body, upstreamFill: true, fetchImpl: fetchStub.impl });
    try {
      assert.equal((await fx.app.inject({ method: 'GET', url: '/octo/assetbundle/objZZ' })).statusCode, 404);
      assert.equal((await fx.app.inject({ method: 'GET', url: '/octo/resources/objH08' })).statusCode, 404);
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      await fx.app.close();
      fx.cleanup();
    }
  });

  test('(g) the upstream URL comes from the original database urlFormat', async () => {
    const body = Buffer.from('fetch me (g)');
    const fetchStub = fakeFetch(() => new Response(body, { status: 200 }));
    const fx = fillFixture({ objectName: 'objI09', body, upstreamFill: true, fetchImpl: fetchStub.impl });
    try {
      assert.equal((await fx.app.inject({ method: 'GET', url: '/octo/assetbundle/objI09' })).statusCode, 200);
      assert.equal(
        fetchStub.calls[0]?.url,
        'https://cdn.invalid/solis-202050-assetbundle/objI09?generation=1700000000000000&alt=media',
      );
      assert.equal(fetchStub.calls[0]?.init?.headers, undefined);
    } finally {
      await fx.app.close();
      fx.cleanup();
    }
  });
});
