import { constants as fsConstants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Local asset mirror: serving side (docs/ASSET_MIRROR.md §4 step 3).
 *
 * Serves *already-extracted final artifacts* (`.opus`, `.png`, `.atlas`,
 * `.json`) from a local directory at `GET /assets/<relative path>`. Nothing
 * here downloads, decrypts, deobfuscates or extracts anything: the directory is
 * filled out of band (see `assetMirrorPipeline.ts` for the planned sync and
 * extraction contracts). Raw UnityFS bundles and Octo manifests are never served.
 *
 * This is unrelated to the `/v2/*` route in `server.ts`, which is a live
 * pass-through proxy to the upstream Octo API. The mirror does not read from
 * or write to that proxy, and the game client still fetches its bundles from
 * the official CDN: this route is for final artifacts, not a bundle CDN.
 *
 * Opt-in: the route is only registered when `SUMIRE_ASSET_MIRROR_DIR` is set
 * (see `config.assetMirrorDir`). Unset keeps the route table exactly as before.
 */

export const ASSET_MIRROR_ROUTE_PREFIX = '/assets';

/** Final-artifact types the mirror serves; anything else is rejected before touching disk. */
export const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.opus': 'audio/ogg; codecs=opus',
  '.png': 'image/png',
  '.atlas': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const MAX_PATH_SEGMENTS = 8;
const MAX_SEGMENT_LENGTH = 128;
/** Letters/digits first (no dot files, no `.`/`..`), then a conservative set; no trailing dot. */
const SEGMENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/;
/** DOS device names resolve to devices on Windows regardless of extension or directory. */
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

export type AssetPath = {
  /** Normalised `/`-joined relative path (the identifier used in URLs and logs). */
  id: string;
  segments: string[];
  contentType: string;
};

/**
 * Validate a decoded relative asset path. Returns null for anything that is not
 * a plain, allowlisted final artifact path: empty or absolute paths, `.`/`..`,
 * backslashes, NUL, percent signs (so double-encoded input stays rejected),
 * dot files, Windows device names, unknown extensions, or excessive depth/length.
 *
 * The future extractor must run its output paths through this same function
 * before writing, so everything it writes is servable and nothing else is.
 */
export function parseAssetPath(raw: string): AssetPath | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_PATH_SEGMENTS * (MAX_SEGMENT_LENGTH + 1)) return null;
  const segments = raw.split('/');
  if (segments.length > MAX_PATH_SEGMENTS) return null;
  for (const segment of segments) {
    if (segment.length > MAX_SEGMENT_LENGTH) return null;
    if (!SEGMENT_RE.test(segment)) return null;
    if (WINDOWS_RESERVED_RE.test(segment)) return null;
  }
  const contentType = ASSET_CONTENT_TYPES[extname(segments[segments.length - 1]).toLowerCase()];
  if (!contentType) return null;
  return { id: segments.join('/'), segments, contentType };
}

export type OpenedAsset = {
  handle: FileHandle;
  size: number;
  mtime: Date;
  contentType: string;
};

/** Read-only view of a mirror directory. Every lookup is confined to `root`. */
export class AssetMirrorStore {
  readonly root: string;

  constructor(root: string) {
    if (!root) throw new Error('AssetMirrorStore: root directory is required');
    this.root = resolve(root);
  }

  /**
   * Open an artifact for reading, or return null when it does not exist or
   * resolves outside the root (symlinks/junctions are followed, then checked).
   * The caller owns the returned handle and must close it or stream from it.
   */
  async open(asset: AssetPath): Promise<OpenedAsset | null> {
    let rootReal: string;
    let fileReal: string;
    try {
      rootReal = await realpath(this.root);
      fileReal = await realpath(join(rootReal, ...asset.segments));
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    const rel = relative(rootReal, fileReal);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;

    let handle: FileHandle;
    try {
      // O_NOFOLLOW (POSIX only) closes the window where the resolved file is
      // swapped for a symlink between realpath() and open().
      handle = await open(fileReal, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) {
        await handle.close();
        return null;
      }
      return { handle, size: st.size, mtime: st.mtime, contentType: asset.contentType };
    } catch (e) {
      await handle.close();
      throw e;
    }
  }
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'ENAMETOOLONG' || code === 'EISDIR';
}

/** Weak validator from size + mtime: cheap (no hashing per request) and changes on every rewrite. */
export function assetEtag(size: number, mtime: Date): string {
  return `W/"${size.toString(16)}-${Math.floor(mtime.getTime()).toString(16)}"`;
}

export type ByteRange = { start: number; end: number };

/**
 * Parse a single `bytes=` range. Returns `null` to serve the full body (no
 * header, malformed or multi-range: RFC 9110 lets servers ignore those) and
 * `'unsatisfiable'` for a well-formed range outside the representation.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (m[2] !== '' && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

function etagMatches(header: string, etag: string): boolean {
  const opaque = etag.replace(/^W\//, '');
  return header.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag.replace(/^W\//, '') === opaque;
  });
}

function sendText(reply: FastifyReply, code: number, text: string) {
  return reply.code(code).header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'no-store').send(text);
}

export function assetMirrorHandler(store: AssetMirrorStore) {
  return async function serveAsset(req: FastifyRequest, reply: FastifyReply) {
    // Decode the raw path exactly once and validate the result, so encoded
    // separators and dot segments cannot slip past the segment checks.
    const rawPath = (req.url ?? '').split('?')[0];
    const prefix = `${ASSET_MIRROR_ROUTE_PREFIX}/`;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath.slice(prefix.length));
    } catch {
      return sendText(reply, 400, 'bad asset path');
    }
    const asset = rawPath.startsWith(prefix) ? parseAssetPath(decoded) : null;
    if (!asset) return sendText(reply, 400, 'bad asset path');

    let opened: OpenedAsset | null;
    try {
      opened = await store.open(asset);
    } catch (e) {
      req.log.error({ asset: asset.id, err: (e as Error).message }, 'asset mirror open failed');
      return sendText(reply, 500, 'asset read failed');
    }
    if (!opened) {
      req.log.info({ asset: asset.id }, 'asset mirror miss');
      return sendText(reply, 404, 'not found');
    }

    const { handle, size, mtime, contentType } = opened;
    const etag = assetEtag(size, mtime);
    reply
      .header('content-type', contentType)
      .header('etag', etag)
      .header('last-modified', mtime.toUTCString())
      .header('cache-control', 'no-cache')
      .header('accept-ranges', 'bytes')
      .header('x-content-type-options', 'nosniff');

    const ifNoneMatch = headerValue(req, 'if-none-match');
    if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
      await handle.close();
      return reply.code(304).send();
    }

    // If-Range with a stale validator means "send the whole thing".
    const ifRange = headerValue(req, 'if-range');
    const range = ifRange && ifRange.trim() !== etag ? null : parseByteRange(headerValue(req, 'range'), size);
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

/**
 * Register `GET|HEAD /assets/*` when a mirror root is configured. With an empty
 * root nothing is registered, so the existing routes (`/:service/:method`,
 * `/v2/*`, ...) behave exactly as before.
 */
export function registerAssetMirror(app: FastifyInstance, root: string): AssetMirrorStore | null {
  if (!root) return null;
  const store = new AssetMirrorStore(root);
  // Explicit HEAD: Fastify's auto-generated HEAD route rewrites an empty
  // payload's content-length to 0, which would misreport the artifact size.
  app.route({ method: ['GET', 'HEAD'], url: `${ASSET_MIRROR_ROUTE_PREFIX}/*`, handler: assetMirrorHandler(store) });
  app.log.info({ assetMirrorRoot: store.root }, 'asset mirror: serving final artifacts at /assets/*');
  return store;
}
