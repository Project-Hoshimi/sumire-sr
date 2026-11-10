// Asset mirror serving tests. Data-free: every fixture is synthetic bytes in a
// throwaway temp directory, there is no network access, and no game data or
// database is needed.
//
//   node src/assetMirror.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  AssetMirrorStore,
  parseAssetPath,
  parseByteRange,
  registerAssetMirror,
} from './assetMirror.ts';

const base = mkdtempSync(join(tmpdir(), 'sumire-asset-mirror-'));
const root = join(base, 'mirror');
const outside = join(base, 'outside');

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic-png-body')]);
const OPUS_BYTES = Buffer.from('OggS synthetic opus payload 0123456789');
const ATLAS_TEXT = 'synthetic.png\nsize: 4,4\nformat: RGBA8888\n';
const JSON_TEXT = '{"synthetic":true}';

function write(rel: string, data: Buffer | string) {
  const p = join(root, ...rel.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
}

/** Bare app with the same catch-all route shapes `buildServer()` registers. */
function appWith(mirrorRoot: string): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAssetMirror(app, mirrorRoot);
  app.all('/api/*', async () => 'rpc');
  app.all('/:service/:method', async () => 'rpc');
  app.all('/v2/*', async () => 'octo-proxy');
  return app;
}

let app: FastifyInstance;
let loopbackPort = 0;

/** Listen on 127.0.0.1 with an ephemeral port (loopback only, no external network). */
async function listenLoopback(server: FastifyInstance): Promise<number> {
  if (loopbackPort) return loopbackPort;
  await server.listen({ port: 0, host: '127.0.0.1' });
  const addr = server.server.address();
  assert.ok(addr && typeof addr === 'object');
  loopbackPort = addr.port;
  return loopbackPort;
}

/** GET with the request target sent verbatim (node:http does not normalise it). */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  write('sud/vo/adv/sud_vo_adv_fixture_001.opus', OPUS_BYTES);
  write('spi/sd/chr/cos/spi_sd_chr_cos_fixture-00.png', PNG_BYTES);
  write('spi/sd/chr/cos/spi_sd_chr_cos_fixture-00.atlas', ATLAS_TEXT);
  write('spi/sd/chr/cos/spi_sd_chr_cos_fixture-00.json', JSON_TEXT);
  write('img/empty.png', Buffer.alloc(0));
  write('raw/bundle.bin', Buffer.from('UnityFS not served'));
  mkdirSync(join(root, 'dir.png'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.png'), Buffer.from('outside the mirror root'));
  // A directory junction (no admin rights needed on Windows; a symlink elsewhere)
  // pointing out of the root must not be followed.
  symlinkSync(outside, join(root, 'escape'), 'junction');
  app = appWith(root);
  await app.ready();
});

after(async () => {
  await app?.close();
  rmSync(base, { recursive: true, force: true });
});

describe('parseAssetPath', () => {
  test('accepts nested final-artifact paths', () => {
    const p = parseAssetPath('spi/sd/chr/cos/spi_sd_chr_cos_fixture-00.png');
    assert.ok(p);
    assert.equal(p.contentType, 'image/png');
    assert.deepEqual(p.segments, ['spi', 'sd', 'chr', 'cos', 'spi_sd_chr_cos_fixture-00.png']);
    assert.equal(parseAssetPath('a.OPUS')?.contentType, 'audio/ogg; codecs=opus');
  });

  test('rejects traversal, absolute and malformed identifiers', () => {
    const bad = [
      '', '/', '/etc/passwd.png', '../secret.png', 'a/../../secret.png', './a.png', 'a/./b.png',
      'a//b.png', 'a/', '..', '.', '.hidden.png', 'a\\..\\b.png', 'C:/x.png', 'C:x.png',
      'a\0.png', 'a%2e%2e.png', 'a b.png', 'a.png.', 'dir./a.png', 'con.png', 'NUL', 'x/lpt1.json',
      'a/b/c/d/e/f/g/h/i.png', `${'a'.repeat(129)}.png`, 'no-extension', 'bundle.bin', 'x.unity3d',
      'x.png/', 'ｆｕｌｌ.png',
    ];
    for (const raw of bad) assert.equal(parseAssetPath(raw), null, `expected rejection: ${JSON.stringify(raw)}`);
  });
});

describe('parseByteRange', () => {
  test('single, open-ended and suffix ranges', () => {
    assert.deepEqual(parseByteRange('bytes=0-3', 10), { start: 0, end: 3 });
    assert.deepEqual(parseByteRange('bytes=4-', 10), { start: 4, end: 9 });
    assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
    assert.deepEqual(parseByteRange('bytes=2-99', 10), { start: 2, end: 9 });
  });
  test('ignored or unsatisfiable ranges', () => {
    assert.equal(parseByteRange(undefined, 10), null);
    assert.equal(parseByteRange('bytes=0-1,4-5', 10), null);
    assert.equal(parseByteRange('items=0-1', 10), null);
    assert.equal(parseByteRange('bytes=5-2', 10), null);
    assert.equal(parseByteRange('bytes=10-', 10), 'unsatisfiable');
    assert.equal(parseByteRange('bytes=-0', 10), 'unsatisfiable');
  });
});

describe('AssetMirrorStore', () => {
  test('requires a root', () => {
    assert.throws(() => new AssetMirrorStore(''));
  });
  test('opens files inside the root and refuses escapes', async () => {
    const store = new AssetMirrorStore(root);
    const hit = await store.open(parseAssetPath('img/empty.png')!);
    assert.ok(hit);
    assert.equal(hit.size, 0);
    await hit.handle.close();
    assert.equal(await store.open(parseAssetPath('escape/secret.png')!), null);
    assert.equal(await store.open(parseAssetPath('dir.png')!), null);
    assert.equal(await store.open(parseAssetPath('missing/none.png')!), null);
  });
  test('a missing root behaves as an empty mirror', async () => {
    const store = new AssetMirrorStore(join(base, 'does-not-exist'));
    assert.equal(await store.open(parseAssetPath('a.png')!), null);
  });
});

describe('GET /assets/*', () => {
  test('streams each artifact type with its content type', async () => {
    const cases: [string, Buffer | string, string][] = [
      ['sud/vo/adv/sud_vo_adv_fixture_001.opus', OPUS_BYTES, 'audio/ogg; codecs=opus'],
      ['spi/sd/chr/cos/spi_sd_chr_cos_fixture-00.png', PNG_BYTES, 'image/png'],
      ['spi/sd/chr/cos/spi_sd_chr_cos_fixture-00.atlas', ATLAS_TEXT, 'text/plain; charset=utf-8'],
      ['spi/sd/chr/cos/spi_sd_chr_cos_fixture-00.json', JSON_TEXT, 'application/json; charset=utf-8'],
    ];
    for (const [path, body, type] of cases) {
      const r = await app.inject({ method: 'GET', url: `/assets/${path}` });
      assert.equal(r.statusCode, 200, path);
      assert.equal(r.headers['content-type'], type);
      assert.equal(r.headers['content-length'], String(Buffer.byteLength(body)));
      assert.equal(r.headers['accept-ranges'], 'bytes');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.ok(String(r.headers.etag).startsWith('W/"'));
      assert.deepEqual(r.rawPayload, Buffer.from(body));
    }
  });

  test('query strings are ignored and percent-encoded safe names decode', async () => {
    const r = await app.inject({ method: 'GET', url: '/assets/spi%2Fsd%2Fchr%2Fcos%2Fspi_sd_chr_cos_fixture-00.png?v=1' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.rawPayload, PNG_BYTES);
  });

  test('empty files are served with zero length', async () => {
    const r = await app.inject({ method: 'GET', url: '/assets/img/empty.png' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-length'], '0');
    assert.equal(r.rawPayload.length, 0);
  });

  test('missing artifacts are 404', async () => {
    for (const url of ['/assets/img/missing.png', '/assets/nope/deeper/x.opus', '/assets/dir.png']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 404, url);
      assert.equal(r.body, 'not found');
    }
  });

  test('invalid identifiers are 400', async () => {
    const urls = [
      '/assets/..%2Foutside%2Fsecret.png',
      '/assets/%252e%252e/outside/secret.png',
      '/assets/img%5C..%5Csecret.png',
      '/assets/%00.png',
      '/assets/raw/bundle.bin',
      '/assets/.hidden.png',
      '/assets/CON.png',
      '/assets/',
    ];
    for (const url of urls) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 400, url);
      assert.equal(r.body, 'bad asset path');
    }
    // Malformed percent-encoding is refused by Fastify before routing.
    assert.equal((await app.inject({ method: 'GET', url: '/assets/%E0%A4%A.png' })).statusCode, 400);
  });

  test('raw dot-segment paths over a real socket are 400, never the outside file', async () => {
    // inject() normalises `..`/`%2e%2e` like a browser would; a real HTTP
    // server hands the handler the raw request target, so test that path.
    const port = await listenLoopback(app);
    const raws = [
      '/assets/../outside/secret.png',
      '/assets/%2e%2e/outside/secret.png',
      '/assets/img/%2e%2e/%2e%2e/outside/secret.png',
      '/assets/./escape/../../outside/secret.png',
      '/assets/escape/%2e%2e/%2e%2e/outside/secret.png',
    ];
    for (const path of raws) {
      const r = await rawGet(port, path);
      assert.equal(r.status, 400, path);
      assert.ok(!r.body.includes('outside the mirror root'), path);
    }
    const ok = await rawGet(port, '/assets/img/empty.png');
    assert.equal(ok.status, 200);
  });

  test('symlink/junction escapes are 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/assets/escape/secret.png' });
    assert.equal(r.statusCode, 404);
  });

  test('HEAD returns headers only', async () => {
    const r = await app.inject({ method: 'HEAD', url: '/assets/spi/sd/chr/cos/spi_sd_chr_cos_fixture-00.png' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-length'], String(PNG_BYTES.length));
    assert.equal(r.rawPayload.length, 0);
  });

  test('If-None-Match revalidates with 304', async () => {
    const url = '/assets/sud/vo/adv/sud_vo_adv_fixture_001.opus';
    const first = await app.inject({ method: 'GET', url });
    const etag = String(first.headers.etag);
    const again = await app.inject({ method: 'GET', url, headers: { 'if-none-match': etag } });
    assert.equal(again.statusCode, 304);
    assert.equal(again.rawPayload.length, 0);
    const stale = await app.inject({ method: 'GET', url, headers: { 'if-none-match': 'W/"0-0"' } });
    assert.equal(stale.statusCode, 200);
  });

  test('byte ranges stream a slice', async () => {
    const url = '/assets/sud/vo/adv/sud_vo_adv_fixture_001.opus';
    const r = await app.inject({ method: 'GET', url, headers: { range: 'bytes=5-14' } });
    assert.equal(r.statusCode, 206);
    assert.equal(r.headers['content-range'], `bytes 5-14/${OPUS_BYTES.length}`);
    assert.equal(r.headers['content-length'], '10');
    assert.deepEqual(r.rawPayload, OPUS_BYTES.subarray(5, 15));

    const suffix = await app.inject({ method: 'GET', url, headers: { range: 'bytes=-4' } });
    assert.equal(suffix.statusCode, 206);
    assert.deepEqual(suffix.rawPayload, OPUS_BYTES.subarray(OPUS_BYTES.length - 4));

    const bad = await app.inject({ method: 'GET', url, headers: { range: `bytes=${OPUS_BYTES.length}-` } });
    assert.equal(bad.statusCode, 416);
    assert.equal(bad.headers['content-range'], `bytes */${OPUS_BYTES.length}`);

    const staleIfRange = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-1', 'if-range': 'W/"0-0"' } });
    assert.equal(staleIfRange.statusCode, 200);
    assert.deepEqual(staleIfRange.rawPayload, OPUS_BYTES);
  });
});

describe('route coexistence', () => {
  test('/v2/* still reaches the Octo proxy and RPC catch-alls are unchanged', async () => {
    const v2 = await app.inject({ method: 'GET', url: '/v2/pub/a/0/v/0/list/0' });
    assert.equal(v2.body, 'octo-proxy');
    const v2assets = await app.inject({ method: 'GET', url: '/v2/assets/x.png' });
    assert.equal(v2assets.body, 'octo-proxy');
    assert.equal((await app.inject({ method: 'POST', url: '/api.Foo/Bar' })).body, 'rpc');
    assert.equal((await app.inject({ method: 'POST', url: '/Foo/Bar' })).body, 'rpc');
    // Only GET/HEAD are mirror routes; other methods keep their old route.
    assert.equal((await app.inject({ method: 'POST', url: '/assets/x' })).body, 'rpc');
  });

  test('with no mirror root configured, /assets/* falls through exactly as before', async () => {
    const disabled = appWith('');
    try {
      assert.equal((await disabled.inject({ method: 'GET', url: '/assets/x.png' })).body, 'rpc');
      assert.equal((await disabled.inject({ method: 'GET', url: '/assets/a/b.png' })).statusCode, 404);
      assert.equal((await disabled.inject({ method: 'GET', url: '/v2/pub/a/0/v/0/list/0' })).body, 'octo-proxy');
    } finally {
      await disabled.close();
    }
  });
});
