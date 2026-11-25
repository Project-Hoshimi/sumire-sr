// Octo store operator tool tests. Data-free: the database, files, key and IV are
// synthetic and generated per run; no network access.
//
//   node --test src/tools/octoStoreTool.test.ts
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { encryptOctoList } from '../octoStore.ts';
import { decryptList, importStore, main, parseSize, verifyStore } from './octoStoreTool.ts';

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

function data(id: number, name: string, objectName: string, body: Buffer, state = 2): Buffer {
  return Buffer.concat([
    vField(1, id),
    lField(3, name),
    vField(4, body.length),
    vField(9, state),
    lField(10, md5(body)),
    lField(11, objectName),
    vField(12, 1700000000000000 + id),
    vField(13, 202050),
  ]);
}

// A and D share content (one file, two entries); E is listed but never supplied.
const A = Buffer.from('synthetic bundle A, not a real asset');
const B = Buffer.from('synthetic resource B');
const C = Buffer.from('synthetic bundle C, a little longer than the others');
const E = Buffer.from('synthetic bundle E that no source has');

function database(state = 2): Buffer {
  return Buffer.concat([
    vField(1, 4242),
    lField(2, data(1, 'img_fixture_a', 'objA01', A, state)),
    lField(2, data(3, 'mov_fixture_c', 'objC03', C)),
    lField(2, data(4, 'img_fixture_d', 'objD04', A)),
    lField(2, data(5, 'img_fixture_e', 'objE05', E)),
    lField(4, data(2, 'adv_fixture_b', 'objB02', B)),
    lField(5, 'https://cdn.invalid/solis-{v}-{type}/{o}?generation={g}&alt=media'),
  ]);
}
const db = database();

const base = mkdtempSync(join(tmpdir(), 'sumire-octotool-'));
after(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
const fresh = (label: string) => {
  const dir = join(base, `${label}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const put = (path: string, body: Buffer | string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
};
const nested = (dir: string, body: Buffer) => join(dir, md5(body).slice(0, 2), md5(body));
const hexKey = (s: string) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

/**
 * Three source layouts: a flat folder, a nested store, and a client download cache
 * (`<app>/<n>/<hex key>/<md5>` plus `.meta`). The flat folder also holds a same-size
 * corrupt copy of B and a wrong-size copy of C, which must be rejected.
 */
function makeSources(): string[] {
  const flat = fresh('flat');
  put(join(flat, md5(A)), A);
  put(join(flat, md5(B)), Buffer.alloc(B.length, 0x55));
  put(join(flat, md5(C)), C.subarray(1));
  put(join(flat, 'notes.txt'), 'not an md5 name');
  const cache = fresh('cache');
  const cacheDir = (obj: string) => join(cache, 'v1', '212', '3', hexKey(`A${obj}`));
  put(join(cacheDir('objB02'), md5(B)), B);
  put(join(cacheDir('objB02'), '.meta'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  put(join(cacheDir('objC03'), md5(C).toUpperCase()), C);
  return [flat, cache];
}

const lines = () => {
  const out: string[] = [];
  return { out, log: (l: string) => void out.push(l) };
};

describe('parseSize', () => {
  test('reads plain numbers and binary units', () => {
    assert.equal(parseSize('123'), 123);
    assert.equal(parseSize('64K'), 65536);
    assert.equal(parseSize('1.5G'), 1.5 * 1024 ** 3);
    assert.equal(parseSize('2MiB'), 2 * 1024 ** 2);
    assert.throws(() => parseSize('lots'));
  });
});

describe('decrypt', () => {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const env = { SUMIRE_OCTO_AES_KEY: key.toString('hex'), SUMIRE_OCTO_AES_IV: iv.toString('hex') };

  test('round-trips a list body and reports its contents', () => {
    const r = decryptList(encryptOctoList(db, key, iv), key, iv);
    assert.deepEqual(r.database, db);
    assert.equal(r.revision, 4242);
    assert.equal(r.assetbundles, 4);
    assert.equal(r.resources, 1);
    assert.equal(r.notLatest, 0);
  });

  test('flags a diff list', () => {
    assert.equal(decryptList(encryptOctoList(database(1), key, iv), key, iv).notLatest, 1);
  });

  test('rejects a wrong key and non-database plaintext', () => {
    assert.throws(() => decryptList(encryptOctoList(db, key, iv), randomBytes(32), iv), /cannot decrypt|not an Octo|no entries/);
    assert.throws(() => decryptList(encryptOctoList(Buffer.from('plain text'), key, iv), key, iv), /not an Octo database|no entries/);
    assert.throws(() => decryptList(encryptOctoList(db, key, iv), randomBytes(16), iv), /32 bytes/);
  });

  test('command writes the database, refuses to overwrite without --force', async () => {
    const dir = fresh('decrypt');
    const list = join(dir, 'list.bin');
    const outFile = join(dir, 'rev.plain');
    writeFileSync(list, encryptOctoList(db, key, iv));
    const a = lines();
    assert.equal(await main(['decrypt', list, outFile], env, a.log), 0);
    assert.deepEqual(readFileSync(outFile), db);
    assert.match(a.out.join('\n'), /revision 4242: 4 asset bundles, 1 resources/);
    const b = lines();
    assert.equal(await main(['decrypt', list, outFile], env, b.log), 2);
    assert.match(b.out.join('\n'), /exists; pass --force/);
    assert.equal(await main(['decrypt', list, outFile, '--force'], env, () => {}), 0);
    assert.deepEqual(readdirSync(dir).sort(), ['list.bin', 'rev.plain']);
  });

  test('command needs the key from the environment', async () => {
    const dir = fresh('decrypt-nokey');
    writeFileSync(join(dir, 'list.bin'), encryptOctoList(db, key, iv));
    const o = lines();
    assert.equal(await main(['decrypt', join(dir, 'list.bin'), join(dir, 'out')], {}, o.log), 2);
    assert.match(o.out.join('\n'), /SUMIRE_OCTO_AES_KEY must be set/);
  });
});

describe('import', () => {
  test('preview finds all layouts and writes nothing', async () => {
    const sources = makeSources();
    const to = fresh('store');
    const r = await importStore({ database: db, to, sources, apply: false });
    assert.equal(r.selected, 4);
    assert.equal(r.present, 0);
    assert.deepEqual(r.copied, { files: 3, bytes: A.length + B.length + C.length });
    assert.deepEqual(r.notFound, { files: 1, bytes: E.length });
    // Preview checks sizes only: the wrong-size C copy is rejected, the corrupt B copy is not seen yet.
    assert.deepEqual(r.rejected.map((x) => x.reason), [`size ${C.length - 1}, manifest ${C.length}`]);
    assert.deepEqual(readdirSync(to), []);
  });

  test('apply copies verified files, rejects bad copies, and is idempotent', async () => {
    const sources = makeSources();
    const to = fresh('store');
    const r = await importStore({ database: db, to, sources, apply: true });
    assert.deepEqual(r.copied, { files: 3, bytes: A.length + B.length + C.length });
    for (const body of [A, B, C]) assert.deepEqual(readFileSync(nested(to, body)), body);
    assert.ok(!existsSync(nested(to, E)));
    const reasons = r.rejected.map((x) => x.reason).sort();
    assert.deepEqual(reasons, ['md5 mismatch', `size ${C.length - 1}, manifest ${C.length}`]);
    // No temp files are left behind.
    const left = readdirSync(to, { recursive: true }).map(String).filter((p) => p.includes('.tmp-'));
    assert.deepEqual(left, []);

    const again = await importStore({ database: db, to, sources, apply: true });
    assert.equal(again.present, 3);
    assert.equal(again.copied.files, 0);
  });

  test('removes the temp file when the final rename fails', async () => {
    const sources = makeSources();
    const to = fresh('store');
    // The destination path is a non-empty directory, so the final rename cannot replace it.
    const dest = nested(to, A);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'keep'), 'not a file');
    await assert.rejects(
      importStore({ database: db, to, sources, apply: true, prefixes: ['img_'] }),
      /EISDIR|ENOTEMPTY|EPERM|ENOTDIR/,
    );
    const left = readdirSync(to, { recursive: true }).map(String).filter((p) => p.includes('.tmp-'));
    assert.deepEqual(left, []);
    assert.equal(readFileSync(join(dest, 'keep'), 'utf8'), 'not a file');
  });

  test('prefix filter and byte budget', async () => {
    const sources = makeSources();
    const onlyAdv = await importStore({ database: db, to: fresh('store'), sources, apply: false, prefixes: ['adv_'] });
    assert.equal(onlyAdv.selected, 1);
    assert.equal(onlyAdv.copied.files, 1);

    const to = fresh('store');
    const budget = await importStore({ database: db, to, sources, apply: true, maxBytes: Math.max(A.length, B.length, C.length) });
    assert.equal(budget.copied.files, 1);
    assert.ok(budget.copied.bytes <= Math.max(A.length, B.length, C.length));
    assert.equal(budget.overBudget.files, 2);
  });

  test('command: preview by default, exit 1 when files were rejected', async () => {
    const sources = makeSources();
    const dir = fresh('cmd');
    const dbFile = join(dir, 'rev.plain');
    writeFileSync(dbFile, db);
    const to = join(dir, 'store');
    const p = lines();
    assert.equal(await main(['import', '--db', dbFile, '--to', to, ...sources], {}, p.log), 1);
    assert.match(p.out.join('\n'), /import preview \(nothing written/);
    assert.ok(!existsSync(to));
    const a = lines();
    assert.equal(await main(['import', '--to', to, '--apply', ...sources], { SUMIRE_OCTO_DATABASE: dbFile }, a.log), 1);
    assert.match(a.out.join('\n'), /copied\s+3 files/);
    assert.equal(await main(['import', '--db', dbFile, '--to', to, '--max-bytes', 'lots', ...sources], {}, () => {}), 2);
    assert.equal(await main(['import', '--db', dbFile, ...sources], {}, () => {}), 2);
  });
});

describe('verify', () => {
  async function store(): Promise<string> {
    const to = fresh('store');
    await importStore({ database: db, to, sources: makeSources(), apply: true });
    return to;
  }

  test('reports missing, wrong-size and wrong-content files per entry', async () => {
    const to = await store();
    put(nested(to, E), E.subarray(2));
    writeFileSync(nested(to, C), Buffer.alloc(C.length, 0x33));
    const r = await verifyStore({ database: db, assetDirs: [to] });
    assert.equal(r.revision, 4242);
    assert.equal(r.entries, 5);
    assert.equal(r.files, 4);
    assert.deepEqual(r.ok, { entries: 3, files: 2, bytes: A.length + B.length });
    const byName = Object.fromEntries(r.problems.map((p) => [p.name, p.problem]));
    assert.deepEqual(byName, { img_fixture_e: 'size', mov_fixture_c: 'md5' });
    assert.equal(r.byPrefix.mov_fixture.md5, 1);

    const quick = await verifyStore({ database: db, assetDirs: [to], quick: true });
    assert.deepEqual(quick.problems.map((p) => p.problem), ['size']);
  });

  test('uses the server lookup order across several directories', async () => {
    const first = fresh('store');
    const second = await store();
    put(join(first, md5(B)), B.subarray(1));
    const r = await verifyStore({ database: db, assetDirs: [first, second] });
    assert.deepEqual(r.problems.map((p) => [p.name, p.problem]), [['img_fixture_e', 'missing']]);
  });

  test('lists orphans and leftover temp files', async () => {
    const to = await store();
    put(join(to, 'ff', 'f'.repeat(32)), 'unknown md5');
    put(join(to, 'stray.tmp-abc'), 'partial');
    const r = await verifyStore({ database: db, assetDirs: [to], orphans: true });
    assert.equal(r.orphans?.length, 2);
  });

  test('a missing asset directory yields no orphans and exit 0', async () => {
    const to = await store();
    put(nested(to, E), E);
    const dir = fresh('cmd');
    const dbFile = join(dir, 'rev.plain');
    writeFileSync(dbFile, db);
    const missing = join(dir, 'no-such-store');
    const o = lines();
    assert.equal(await main(['verify', '--db', dbFile, '--assets', to, '--assets', missing, '--orphans'], {}, o.log), 0);
    assert.match(o.out.join('\n'), /orphans\s+0 files/);
  });

  test('command: --orphans exits 1 when an orphan is found', async () => {
    const to = await store();
    put(nested(to, E), E);
    put(join(to, 'stray.tmp-abc'), 'partial');
    const dir = fresh('cmd');
    const dbFile = join(dir, 'rev.plain');
    writeFileSync(dbFile, db);
    const o = lines();
    assert.equal(await main(['verify', '--db', dbFile, '--assets', to, '--orphans'], {}, o.log), 1);
    assert.match(o.out.join('\n'), /orphans\s+1 files/);
  });

  test('command: exit codes, env defaults and JSON report', async () => {
    const to = await store();
    const dir = fresh('cmd');
    const dbFile = join(dir, 'rev.plain');
    writeFileSync(dbFile, db);
    const report = join(dir, 'report.json');
    const o = lines();
    assert.equal(await main(['verify', '--db', dbFile, '--assets', to, '--report', report], {}, o.log), 1);
    assert.match(o.out.join('\n'), /missing\s+1 entries/);
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(parsed.problems[0].objectName, 'objE05');

    put(nested(to, E), E);
    const env = { SUMIRE_OCTO_DATABASE: dbFile, SUMIRE_OCTO_ASSETS: to };
    assert.equal(await main(['verify'], env, () => {}), 0);
    assert.equal(await main(['verify', '--db', dbFile], {}, () => {}), 2);
    assert.equal(await main(['verify', '--assets', to], {}, () => {}), 2);
    assert.equal(await main(['nope'], {}, () => {}), 2);
  });
});
