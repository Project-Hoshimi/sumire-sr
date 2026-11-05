import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assetEtag, parseByteRange } from './assetMirror.ts';

/**
 * EXPERIMENTAL, OPT-IN local Octo store (for local testing; see docs/ASSET_MIRROR.md §0
 * "Local Octo store"). Removable as a unit: delete this file and its test, and the
 * two `octoStore` lines in server.ts.
 *
 * Serves a locally kept, already *decrypted* Octo database (bare `octodb.Database`
 * protobuf) in place of the upstream `/v2/pub/a/<app>/v/<ver>/list/<rev>` answer,
 * with `urlFormat` rewritten so the client fetches every bundle from this server at
 * `/octo/<type>/<objectName>`. Bundle files are the unmodified CDN files, named by
 * their MD5 (`<dir>/<md5>` or `<dir>/<md5[0:2]>/<md5>`); the client deobfuscates and
 * loads them itself. Nothing is downloaded, decrypted to disk, or extracted here.
 *
 * Approach after the IdolyServer OctoStore (local database + MD5-named files); this is
 * an independent TypeScript implementation, not a port of its tar indexing.
 *
 * Enabled only when SUMIRE_OCTO_DATABASE is set. Then also required:
 *   SUMIRE_OCTO_ASSETS   bundle directories, separated by the platform path delimiter
 *   SUMIRE_OCTO_AES_KEY  hex AES-256 key the client uses for the list (never in source)
 *   SUMIRE_OCTO_AES_IV   hex 16-byte IV for the list (never in source)
 * Optional:
 *   SUMIRE_OCTO_URL_FORMAT  default https://api.octo-cloud.com/octo/{type}/{o}?v={v}&g={g}
 *                           (the client's api.octo-cloud.com traffic already reaches this server)
 * With SUMIRE_OCTO_DATABASE unset nothing is registered and `/v2/*` keeps proxying upstream.
 */

export const OCTO_FILE_ROUTE = '/octo/:type/:objectName';
export const OCTO_LIST_ROUTE = '/v2/pub/a/:app/v/:ver/list/:rev';
export const DEFAULT_OCTO_URL_FORMAT = 'https://api.octo-cloud.com/octo/{type}/{o}?v={v}&g={g}';
const OCTO_TYPES = new Set(['assetbundle', 'resources']);
const OBJECT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MD5_RE = /^[0-9a-f]{32}$/;

export type OctoAsset = { name: string; md5: string; size: number };

export type OctoStoreOptions = {
  /** Decrypted database bytes (bare protobuf). */
  database: Uint8Array;
  assetDirs: string[];
  aesKey: Buffer;
  aesIv: Buffer;
  urlFormat?: string;
};

// --- minimal protobuf field walker (wire types 0, 1, 2, 5) -------------------

type Field = { number: number; wire: number; start: number; valueStart: number; end: number; varint: bigint };

function readVarint(b: Uint8Array, pos: { i: number }): bigint {
  let value = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (pos.i >= b.length) throw new Error('octo database: truncated varint');
    const x = b[pos.i++];
    value |= BigInt(x & 0x7f) << shift;
    if (x < 0x80) return value;
  }
  throw new Error('octo database: varint too long');
}

function* fields(b: Uint8Array): Generator<Field> {
  const pos = { i: 0 };
  while (pos.i < b.length) {
    const start = pos.i;
    const key = readVarint(b, pos);
    const wire = Number(key & 7n);
    let valueStart = pos.i;
    let varint = 0n;
    if (wire === 0) varint = readVarint(b, pos);
    else if (wire === 1) pos.i += 8;
    else if (wire === 5) pos.i += 4;
    else if (wire === 2) {
      const len = Number(readVarint(b, pos));
      valueStart = pos.i;
      pos.i += len;
    } else throw new Error(`octo database: unsupported wire type ${wire} at ${start}`);
    if (pos.i > b.length) throw new Error('octo database: truncated field');
    yield { number: Number(key >> 3n), wire, start, valueStart, end: pos.i, varint };
  }
}

function varintBytes(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

/**
 * Index the database (`Database`: 1 revision, 2 assetBundleList, 4 resourceList, 5 urlFormat;
 * `Data`: 3 name, 4 size, 10 md5, 11 objectName) and return it with field 5 replaced.
 */
export function rewriteOctoDatabase(database: Uint8Array, urlFormat: string): {
  bytes: Buffer;
  revision: number;
  assets: Map<string, OctoAsset>;
} {
  const assets = new Map<string, OctoAsset>();
  const parts: Buffer[] = [];
  let revision = 0;
  const str = (b: Uint8Array, f: Field) => Buffer.from(b.subarray(f.valueStart, f.end)).toString('utf8');
  for (const f of fields(database)) {
    if (f.number === 1 && f.wire === 0) revision = Number(f.varint);
    if ((f.number === 2 || f.number === 4) && f.wire === 2) {
      const data = database.subarray(f.valueStart, f.end);
      let name = '';
      let md5 = '';
      let objectName = '';
      let size = 0;
      for (const g of fields(data)) {
        if (g.number === 3 && g.wire === 2) name = str(data, g);
        else if (g.number === 4 && g.wire === 0) size = Number(g.varint);
        else if (g.number === 10 && g.wire === 2) md5 = str(data, g).toLowerCase();
        else if (g.number === 11 && g.wire === 2) objectName = str(data, g);
      }
      if (objectName && MD5_RE.test(md5)) assets.set(objectName, { name, md5, size });
    }
    if (f.number !== 5) parts.push(Buffer.from(database.subarray(f.start, f.end)));
  }
  const url = Buffer.from(urlFormat, 'utf8');
  parts.push(Buffer.from([(5 << 3) | 2]), varintBytes(url.length), url);
  return { bytes: Buffer.concat(parts), revision, assets };
}

/** AES-256-CBC/PKCS7 over (16 random bytes || database), the shape the client skips and parses. */
export function encryptOctoList(plain: Uint8Array, key: Buffer, iv: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(randomBytes(16)), cipher.update(plain), cipher.final()]);
}

export class OctoStore {
  readonly revision: number;
  readonly assetCount: number;
  readonly list: Buffer;
  private readonly assets: Map<string, OctoAsset>;
  private readonly assetDirs: string[];

  constructor(opts: OctoStoreOptions) {
    if (opts.aesKey.length !== 32) throw new Error('octo store: AES key must be 32 bytes (64 hex chars)');
    if (opts.aesIv.length !== 16) throw new Error('octo store: AES IV must be 16 bytes (32 hex chars)');
    if (opts.assetDirs.length === 0) throw new Error('octo store: at least one asset directory is required');
    const rewritten = rewriteOctoDatabase(opts.database, opts.urlFormat ?? DEFAULT_OCTO_URL_FORMAT);
    this.revision = rewritten.revision;
    this.assets = rewritten.assets;
    this.assetCount = rewritten.assets.size;
    this.assetDirs = opts.assetDirs.map((d) => resolve(d));
    // Encrypted once: the database does not change while the server runs.
    this.list = encryptOctoList(rewritten.bytes, opts.aesKey, opts.aesIv);
  }

  find(objectName: string): OctoAsset | undefined {
    return OBJECT_NAME_RE.test(objectName) ? this.assets.get(objectName) : undefined;
  }

  /** Open the MD5-named file of an asset; only a regular file of the manifest size counts. */
  async open(asset: OctoAsset): Promise<{ handle: FileHandle; size: number; mtime: Date } | null> {
    for (const dir of this.assetDirs) {
      for (const path of [join(dir, asset.md5.slice(0, 2), asset.md5), join(dir, asset.md5)]) {
        let st;
        try {
          st = await stat(path);
        } catch {
          continue;
        }
        if (!st.isFile() || st.size !== asset.size) continue;
        const handle = await open(path, 'r');
        return { handle, size: st.size, mtime: st.mtime };
      }
    }
    return null;
  }
}

function text(reply: FastifyReply, code: number, body: string) {
  return reply.code(code).header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'no-store').send(body);
}

export function octoListHandler(store: OctoStore) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { app, ver } = req.params as { app: string; ver: string };
    if (!/^\d{1,9}$/.test(app) || !/^\d{1,9}$/.test(ver)) return text(reply, 400, 'bad octo list path');
    req.log.info({ revision: store.revision, assets: store.assetCount }, 'octo store: list served locally');
    return reply
      .header('content-type', 'application/x-protobuf')
      .header('etag', `"3.${app}.${ver}.0.${store.revision}"`)
      .header('cache-control', 'no-store')
      .send(store.list);
  };
}

export function octoFileHandler(store: OctoStore) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { type, objectName } = req.params as { type: string; objectName: string };
    if (!OCTO_TYPES.has(type)) return text(reply, 400, 'bad octo type');
    const asset = store.find(objectName);
    if (!asset) return text(reply, 404, 'not found');
    const opened = await store.open(asset);
    if (!opened) {
      req.log.warn({ objectName, name: asset.name }, 'octo store: file missing');
      return text(reply, 404, 'not found');
    }
    const { handle, size, mtime } = opened;
    reply
      .header('content-type', 'application/octet-stream')
      .header('etag', assetEtag(size, mtime))
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'no-cache');
    const range = parseByteRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      await handle.close();
      return reply.code(416).header('content-range', `bytes */${size}`).send();
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
    reply.header('content-length', String(length));
    if (req.method === 'HEAD' || length === 0) {
      await handle.close();
      return reply.send();
    }
    return reply.send(handle.createReadStream({ start, end, autoClose: true }));
  };
}

export function registerOctoStoreRoutes(app: FastifyInstance, store: OctoStore): void {
  // A specific GET route wins over the `/v2/*` proxy catch-all; other methods still proxy.
  app.get(OCTO_LIST_ROUTE, octoListHandler(store));
  app.route({ method: ['GET', 'HEAD'], url: OCTO_FILE_ROUTE, handler: octoFileHandler(store) });
}

function hexEnv(env: NodeJS.ProcessEnv, name: string): Buffer {
  const v = (env[name] ?? '').trim();
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(v)) throw new Error(`${name} must be set to a hex string when SUMIRE_OCTO_DATABASE is set`);
  return Buffer.from(v, 'hex');
}

/** Register the local Octo store when SUMIRE_OCTO_DATABASE is set; otherwise do nothing. */
export function registerOctoStore(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): OctoStore | null {
  const databasePath = env.SUMIRE_OCTO_DATABASE;
  if (!databasePath) return null;
  const store = new OctoStore({
    database: readFileSync(resolve(databasePath)),
    assetDirs: (env.SUMIRE_OCTO_ASSETS ?? '').split(delimiter).filter(Boolean),
    aesKey: hexEnv(env, 'SUMIRE_OCTO_AES_KEY'),
    aesIv: hexEnv(env, 'SUMIRE_OCTO_AES_IV'),
    urlFormat: env.SUMIRE_OCTO_URL_FORMAT || undefined,
  });
  registerOctoStoreRoutes(app, store);
  app.log.warn(
    { revision: store.revision, assets: store.assetCount },
    'octo store (experimental): serving the local Octo database and bundle files instead of the upstream list',
  );
  return store;
}
