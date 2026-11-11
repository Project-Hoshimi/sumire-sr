import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, mkdir, open, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { config } from './config.ts';
import { db } from './db/client.ts';
import type { Executor } from './db/tx.ts';
import { accounts, photoImageMetadata, players } from './db/schema.ts';
import { verifyIdToken, FIREBASE_PROJECT_ID, SECURE_TOKEN_ISSUER } from './auth/firebaseTokens.ts';
import { getSingleton, listElements } from './services/playerState.ts';

/**
 * Firebase Storage emulation for photo images, ported from Solis
 * `internal/server/http/game/firebasestorage.googleapis.com.go` (+ the
 * `opuser/photo_image_metadata.go` store and `diver/photo_image.go`).
 *
 * Photo mode (Live 撮影 etc.) uploads each JPEG and its `_t` thumbnail to
 * `firebasestorage.googleapis.com/v0/b/udc-idolypride/o` with the Firebase
 * Android SDK's resumable protocol *before* it calls `Photo:Create*Shootings`.
 * Album / detail screens later fetch the bytes from the URLs that
 * `Photo:GetImageURL` hands out, which point back at `GET .../o/<name>`.
 */

export const FIREBASE_STORAGE_BUCKET = 'udc-idolypride';
/** Event modes (Photo Album / Shelf) upload their shots to a separate bucket. */
export const FIREBASE_STORAGE_EVENT_BUCKET = 'event-idolypride';
const FIREBASE_STORAGE_BUCKETS = [FIREBASE_STORAGE_BUCKET, FIREBASE_STORAGE_EVENT_BUCKET];
export const PHOTO_OBJECT_PREFIX = 'Photo';
const FIREBASE_STORAGE_CONTENT_TYPE = 'image/jpeg';
const FIREBASE_STORAGE_CHUNK_SIZE = '262144';
const FIREBASE_STORAGE_UPLOAD_ACTIVE = 'active';
const FIREBASE_STORAGE_UPLOAD_FINAL = 'final';
const PHOTO_UPLOAD_SESSION_MS = 24 * 3600 * 1000;
const PHOTO_UPLOAD_LEASE_MS = 3600 * 1000;
const MAXIMUM_PHOTO_PIXELS = 20_000_000;

export const UPLOAD_ACTIVE = 'active';
export const UPLOAD_FINALIZING = 'finalizing';
export const UPLOAD_FINALIZED = 'finalized';

export type PhotoImageMetadata = typeof photoImageMetadata.$inferSelect;

type PhotoObjectName = { name: string; publicUserId: string; filename: string };
type PhotoOwner = { serverUserId: string; publicUserId: string };

class HttpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Owner lookup (Solis opuser.GetUserAuthByFirebaseId → UserAuth)

/** Server user id + public user id for a Firebase UID, or null when unknown. */
export async function findPhotoOwnerByFirebaseUid(uid: string): Promise<PhotoOwner | null> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.firebaseUid, uid)).limit(1);
  if (!acct) return null;
  const [pl] = await db.select().from(players).where(eq(players.accountId, acct.id)).limit(1);
  if (!pl) return null;
  const publicUserId = (pl.data as { publicUserId?: string } | null)?.publicUserId ?? acct.seedId ?? '';
  if (!publicUserId) return null;
  return { serverUserId: pl.id, publicUserId };
}

/** Public user id stored for a server user (player) id. */
export async function publicUserIdForPlayer(playerId: string): Promise<string> {
  const [pl] = await db.select().from(players).where(eq(players.id, playerId)).limit(1);
  if (!pl) throw new Error(`no player ${playerId}`);
  const fromData = (pl.data as { publicUserId?: string } | null)?.publicUserId;
  if (fromData) return fromData;
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, pl.accountId)).limit(1);
  return acct?.seedId ?? '';
}

// ---------------------------------------------------------------------------
// Metadata store (Solis opuser/photo_image_metadata.go)

export async function findPhotoImageMetadata(name: string): Promise<PhotoImageMetadata | undefined> {
  const [row] = await db.select().from(photoImageMetadata).where(eq(photoImageMetadata.id, name)).limit(1);
  return row;
}

export async function findPhotoImageMetadataByNames(suid: string, names: string[]): Promise<PhotoImageMetadata[]> {
  if (!names.length) return [];
  return db
    .select()
    .from(photoImageMetadata)
    .where(and(eq(photoImageMetadata.playerId, suid), inArray(photoImageMetadata.id, names)));
}

export async function findFinalizedPhotoImageMetadataByNames(
  suid: string,
  names: string[],
): Promise<PhotoImageMetadata[]> {
  if (!names.length) return [];
  return db
    .select()
    .from(photoImageMetadata)
    .where(
      and(
        eq(photoImageMetadata.playerId, suid),
        inArray(photoImageMetadata.id, names),
        ne(photoImageMetadata.generation, ''),
      ),
    );
}

export async function deletePhotoImageMetadataByNames(suid: string, names: string[]): Promise<void> {
  if (!names.length) return;
  await db
    .delete(photoImageMetadata)
    .where(and(eq(photoImageMetadata.playerId, suid), inArray(photoImageMetadata.id, names)));
}

/**
 * Start a new object or a replacement upload without discarding the last
 * published generation. Live upload leases are kept: an existing row is only
 * taken over when it belongs to the same owner and is finalized or stale.
 */
async function startPhotoImageUploadRow(meta: {
  id: string;
  playerId: string;
  publicUserId: string;
  uploadId: string;
  uploadState: string;
  uploadStateUpdatedAt: Date;
  uploadExpiresAt: Date;
  name: string;
  bucket: string;
  contentType: string;
}, staleBefore: Date): Promise<boolean> {
  const t = photoImageMetadata;
  const rows = await db
    .insert(t)
    .values({ ...meta, finalizationId: null })
    .onConflictDoUpdate({
      target: t.id,
      set: {
        uploadId: meta.uploadId,
        uploadState: meta.uploadState,
        uploadStateUpdatedAt: meta.uploadStateUpdatedAt,
        uploadExpiresAt: meta.uploadExpiresAt,
        name: meta.name,
        bucket: meta.bucket,
        contentType: meta.contentType,
        finalizationId: null,
      },
      setWhere: and(
        eq(t.playerId, meta.playerId),
        eq(t.publicUserId, meta.publicUserId),
        or(
          eq(t.uploadState, UPLOAD_FINALIZED),
          and(inArray(t.uploadState, [UPLOAD_ACTIVE, UPLOAD_FINALIZING]), lte(t.uploadStateUpdatedAt, staleBefore)),
        ),
      ),
    })
    .returning({ id: t.id });
  return rows.length === 1;
}

/** Atomically reserve an active session for its finalizer. */
async function claimPhotoImageUpload(
  name: string,
  suid: string,
  uploadId: string,
  finalizationId: string,
  stateUpdatedAt: Date,
  expiresAt: Date,
): Promise<boolean> {
  const t = photoImageMetadata;
  const rows = await db
    .update(t)
    .set({ uploadState: UPLOAD_FINALIZING, finalizationId, uploadStateUpdatedAt: stateUpdatedAt, uploadExpiresAt: expiresAt })
    .where(and(eq(t.id, name), eq(t.playerId, suid), eq(t.uploadId, uploadId), eq(t.uploadState, UPLOAD_ACTIVE)))
    .returning({ id: t.id });
  return rows.length === 1;
}

async function completePhotoImageUpload(meta: PhotoImageMetadata): Promise<boolean> {
  const t = photoImageMetadata;
  const { id, ...rest } = meta;
  const rows = await db
    .update(t)
    .set(rest)
    .where(
      and(
        eq(t.id, id),
        eq(t.playerId, meta.playerId),
        eq(t.uploadId, meta.uploadId),
        eq(t.uploadState, UPLOAD_FINALIZING),
        eq(t.finalizationId, meta.finalizationId ?? ''),
      ),
    )
    .returning({ id: t.id });
  return rows.length === 1;
}

async function releasePhotoImageUploadRow(
  name: string,
  suid: string,
  uploadId: string,
  finalizationId: string,
  stateUpdatedAt: Date,
  expiresAt: Date,
): Promise<boolean> {
  const t = photoImageMetadata;
  const rows = await db
    .update(t)
    .set({ uploadState: UPLOAD_ACTIVE, uploadStateUpdatedAt: stateUpdatedAt, uploadExpiresAt: expiresAt, finalizationId: null })
    .where(
      and(
        eq(t.id, name),
        eq(t.playerId, suid),
        eq(t.uploadId, uploadId),
        eq(t.uploadState, UPLOAD_FINALIZING),
        eq(t.finalizationId, finalizationId),
      ),
    )
    .returning({ id: t.id });
  return rows.length === 1;
}

/** Expiring an unfinished replacement must not delete the published object. */
async function deleteExpiredPhotoImageUploads(now: Date): Promise<void> {
  const t = photoImageMetadata;
  await db.delete(t).where(and(lte(t.uploadExpiresAt, now), eq(t.generation, '')));
}

// ---------------------------------------------------------------------------
// On-disk publication (Solis diver/photo_image.go)

// Metadata and the on-disk image must be read/published together. Bounded
// locks avoid retaining a lock for every image ever uploaded.
const photoObjectLocks: Promise<void>[] = Array.from({ length: 64 }, () => Promise.resolve());

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export async function lockPhotoObject(name: string): Promise<() => void> {
  const index = fnv1a32(name) % photoObjectLocks.length;
  const previous = photoObjectLocks[index];
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  photoObjectLocks[index] = previous.then(() => mine);
  await previous;
  return release;
}

type PhotoImagePublication = { commit(): Promise<void>; rollback(): Promise<void> };

async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Atomically replace a validated image path, keeping a hard link to the
 * previous image until the new metadata has committed. The caller must hold
 * lockPhotoObject until it commits or rolls back.
 */
async function publishPhotoImage(destination: string, body: Buffer, modifiedAt: Date): Promise<PhotoImagePublication> {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const temporaryPath = join(directory, `.photo-upload-${randomBytes(8).toString('hex')}`);
  let previous = '';
  let published = false;
  const commit = async () => {
    if (previous) await rm(previous);
  };
  const rollback = async () => {
    if (!published) return commit();
    if (previous) return rename(previous, destination);
    await removeIfExists(destination);
  };
  const handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o640);
  try {
    try {
      await handle.writeFile(body);
      await handle.chmod(0o640);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await utimes(temporaryPath, modifiedAt, modifiedAt);
    try {
      await link(destination, `${temporaryPath}.previous`);
      previous = `${temporaryPath}.previous`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await rename(temporaryPath, destination);
    published = true;
    // Persist the rename (POSIX). Windows cannot open a directory for fsync (EPERM, which
    // would roll the published image back); NTFS journals the rename itself, so skip it there.
    if (process.platform !== 'win32') {
      const dirHandle = await open(directory, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    }
  } catch (e) {
    if (!published) await removeIfExists(temporaryPath);
    await rollback().catch(() => undefined);
    throw e;
  }
  return { commit, rollback };
}

export function photoImagePath(publicUserId: string, filename: string): string {
  return join(config.resourceDir, PHOTO_OBJECT_PREFIX, publicUserId, `${filename}.jpg`);
}

// ---------------------------------------------------------------------------
// Helpers

function parsePhotoObjectName(name: string): PhotoObjectName {
  const parts = name.split('/');
  if (parts.length !== 3 || parts[0] !== PHOTO_OBJECT_PREFIX || !isPublicUserId(parts[1]) || !isPhotoFilename(parts[2])) {
    throw new Error('invalid photo object name');
  }
  return { name, publicUserId: parts[1], filename: parts[2] };
}

function isPublicUserId(value: string): boolean {
  return /^[A-Z0-9]{8}$/.test(value);
}

/** Keep room for the .jpg suffix on filesystems with a 255-byte segment limit. */
export function isPhotoFilename(value: string): boolean {
  if (value === '' || value === '.' || value === '..' || value.length > 251) return false;
  return /^[A-Za-z0-9\-_.~]+$/.test(value);
}

function firebaseStorageUploadUrl(bucket: string, name: string, uploadId: string): string {
  // Go url.Values.Encode sorts keys and uses QueryEscape (space → '+').
  const query = new URLSearchParams([
    ['name', name],
    ['uploadType', 'resumable'],
    ['upload_id', uploadId],
    ['upload_protocol', 'resumable'],
  ]);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?${query.toString()}`;
}

/** Download URL handed out by Photo:GetImageURL (Solis photoFirebaseDownloadURL). */
export function photoFirebaseDownloadUrl(name: string, metadata: PhotoImageMetadata | undefined): string {
  const query = new URLSearchParams([['alt', 'media']]);
  if (metadata && metadata.downloadTokens !== '') query.set('token', metadata.downloadTokens);
  if (metadata && metadata.generation !== '') query.set('v', metadata.generation);
  const bucket = metadata?.bucket || FIREBASE_STORAGE_BUCKET;
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(name)}?${query.toString()}`;
}

function newFirebaseUploadId(): string {
  return 'AJjja9' + randomBytes(72).toString('base64url');
}

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32c(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32C_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Minimal stand-in for Go's `image/jpeg.DecodeConfig`: walk the markers to the
 * first SOF and return its dimensions. Like Go, only baseline / extended
 * sequential / progressive frames with 1, 3 or 4 components are accepted.
 */
export function jpegDimensions(body: Buffer): { width: number; height: number } {
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) throw new Error('missing SOI marker');
  let offset = 2;
  while (offset < body.length) {
    if (body[offset] !== 0xff) throw new Error('missing 0xff marker start');
    while (offset < body.length && body[offset] === 0xff) offset++;
    if (offset >= body.length) break;
    const marker = body[offset++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) throw new Error('missing SOF marker');
    if (offset + 2 > body.length) break;
    const length = body.readUInt16BE(offset);
    if (length < 2) throw new Error('short segment length');
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (offset + 8 > body.length) break;
      const height = body.readUInt16BE(offset + 3);
      const width = body.readUInt16BE(offset + 5);
      const components = body[offset + 7];
      if (components !== 1 && components !== 3 && components !== 4) throw new Error('unsupported number of components');
      return { width, height };
    }
    if ((marker >= 0xc3 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error('unsupported JPEG process');
    }
    offset += length;
  }
  throw new Error('unexpected EOF');
}

const TIME_FORMAT = (date: Date) => date.toISOString(); // 2006-01-02T15:04:05.000Z

function completePhotoMetadata(
  session: PhotoImageMetadata,
  filename: string,
  body: Buffer,
  createdAt: Date,
): PhotoImageMetadata {
  const md5Digest = createHash('md5').update(body).digest();
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crc32c(body));
  let generation = BigInt(createdAt.getTime()) * 1000n;
  if (/^-?\d+$/.test(session.generation)) {
    const previous = BigInt(session.generation);
    if (generation <= previous) generation = previous + 1n;
  }
  const timeCreated = TIME_FORMAT(createdAt);
  return {
    ...session,
    uploadState: UPLOAD_FINALIZED,
    uploadStateUpdatedAt: createdAt,
    uploadExpiresAt: null,
    generation: generation.toString(),
    metageneration: '1',
    timeCreated,
    updated: timeCreated,
    storageClass: 'REGIONAL',
    size: String(body.length),
    md5Hash: md5Digest.toString('base64'),
    contentEncoding: 'identity',
    contentDisposition: `inline; filename*=utf-8''${filename}`,
    crc32c: crcBytes.toString('base64'),
    etag: md5Digest.subarray(0, 8).toString('base64'),
    // Firebase derives GetDownloadURL from downloadTokens: rotate it for each
    // newly published upload.
    downloadTokens: randomUUID(),
  };
}

function samePublishedPhoto(current: PhotoImageMetadata, expected: PhotoImageMetadata): boolean {
  return (
    current.uploadState === UPLOAD_FINALIZED &&
    current.id === expected.id &&
    current.playerId === expected.playerId &&
    current.uploadId === expected.uploadId &&
    current.finalizationId === expected.finalizationId &&
    current.generation === expected.generation &&
    current.size === expected.size &&
    current.md5Hash === expected.md5Hash &&
    current.crc32c === expected.crc32c &&
    current.downloadTokens === expected.downloadTokens
  );
}

/** The Firebase metadata JSON (session bookkeeping is never exposed). */
export function firebaseMetadataJson(m: PhotoImageMetadata): Record<string, string> {
  return {
    name: m.name,
    bucket: m.bucket,
    generation: m.generation,
    metageneration: m.metageneration,
    contentType: m.contentType,
    timeCreated: m.timeCreated,
    updated: m.updated,
    storageClass: m.storageClass,
    size: m.size,
    md5Hash: m.md5Hash,
    contentEncoding: m.contentEncoding,
    contentDisposition: m.contentDisposition,
    crc32c: m.crc32c,
    etag: m.etag,
    downloadTokens: m.downloadTokens,
  };
}

function setFirebaseMetadataHeaders(reply: FastifyReply, uploadId: string, status: string): void {
  reply.header('content-type', 'application/json; charset=UTF-8');
  reply.header('x-guploader-uploadid', uploadId);
  if (status !== '') reply.header('x-goog-upload-status', status);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('access-control-expose-headers', 'Content-Range, X-Firebase-Storage-XSRF');
  reply.header('access-control-allow-origin', '*');
  reply.header('cache-control', 'private, max-age=0');
  reply.header('expires', new Date().toUTCString());
}

function sendMetadata(reply: FastifyReply, uploadId: string, status: string, m: PhotoImageMetadata) {
  setFirebaseMetadataHeaders(reply, uploadId, status);
  return reply.send(JSON.stringify(firebaseMetadataJson(m)));
}

const STATUS_TEXT: Record<number, string> = {
  400: 'bad request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not found',
  409: 'conflict',
  416: 'requested range not satisfiable',
};

/** Solis middleware.ErrorHandler: log the detail, send a terse plain-text body. */
function sendError(req: FastifyRequest, reply: FastifyReply, err: unknown) {
  const code = err instanceof HttpError ? err.code : 500;
  req.log.error({ status: code, err: (err as Error)?.message ?? String(err) }, 'firebase storage request failed');
  const message = code < 500 ? (STATUS_TEXT[code] ?? 'client error') : 'internal error';
  return reply
    .code(code)
    .header('content-type', 'text/plain; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(message);
}

function header(req: FastifyRequest, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** Bucket named in the request path (`/v0/b/<bucket>/o...`); routes only match known buckets. */
function bucketOf(req: FastifyRequest): string {
  const match = /^\/v0\/b\/([^/?]+)\/o/.exec(req.url ?? '');
  return match ? match[1] : FIREBASE_STORAGE_BUCKET;
}

function queryOf(req: FastifyRequest): URLSearchParams {
  const url = req.url ?? '';
  const q = url.indexOf('?');
  return new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
}

function bodyOf(req: FastifyRequest): Buffer {
  const body = req.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.alloc(0);
}

// ---------------------------------------------------------------------------
// Resumable upload chunks (in-memory, per upload session)
//
// The Firebase Android SDK uploads larger photos in several resumable
// requests: a non-final `upload` chunk, possibly `query` calls, then a final
// `upload, finalize`. The database row tracks the session; the bytes received
// so far live here, keyed by upload id. `postPhoto` serializes requests for the
// same object name, so appends cannot interleave.

type PhotoUploadChunkState = { data: Buffer; updatedAt: number };

const photoUploadChunks = new Map<string, PhotoUploadChunkState>();

export function photoUploadBytesReceived(uploadId: string): number {
  return photoUploadChunks.get(uploadId)?.data.length ?? 0;
}

/**
 * Append `chunk` at `offset`, or return null when the offset does not match
 * the bytes received so far (the caller answers 400). An empty chunk at the
 * current offset leaves the accumulated bytes untouched.
 */
export function appendPhotoUploadChunk(uploadId: string, offset: number, chunk: Buffer): Buffer | null {
  const current = photoUploadChunks.get(uploadId)?.data ?? Buffer.alloc(0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset !== current.length) return null;
  const data = chunk.length === 0 ? current : Buffer.concat([current, chunk]);
  photoUploadChunks.set(uploadId, { data, updatedAt: Date.now() });
  return data;
}

export function clearPhotoUploadChunk(uploadId: string): void {
  photoUploadChunks.delete(uploadId);
}

function purgeStalePhotoUploadChunks(now: number): void {
  for (const [uploadId, state] of photoUploadChunks) {
    if (now - state.updatedAt >= PHOTO_UPLOAD_SESSION_MS) photoUploadChunks.delete(uploadId);
  }
}

function parseUploadOffset(raw: string): number {
  if (!/^\d+$/.test(raw)) return Number.NaN;
  return Number(raw);
}

function sendUploadActive(reply: FastifyReply, uploadId: string, sizeReceived: number) {
  reply.header('content-type', 'text/plain; charset=utf-8');
  reply.header('x-guploader-uploadid', uploadId);
  reply.header('x-goog-upload-status', FIREBASE_STORAGE_UPLOAD_ACTIVE);
  reply.header('x-goog-upload-size-received', String(sizeReceived));
  reply.header('x-content-type-options', 'nosniff');
  reply.header('access-control-expose-headers', 'Content-Range, X-Firebase-Storage-XSRF');
  reply.header('access-control-allow-origin', '*');
  reply.header('cache-control', 'private, max-age=0');
  reply.header('expires', new Date().toUTCString());
  return reply.send('');
}

// ---------------------------------------------------------------------------
// Authentication (Solis authenticatePhotoOwner)

async function authenticatePhotoOwner(req: FastifyRequest, publicUserId: string): Promise<PhotoOwner> {
  return authenticatePhotoUser(req, publicUserId);
}

/**
 * Authenticate the Firebase user behind a storage request. With
 * `publicUserId` the caller must be that photo owner; with `null` any player
 * of this server is accepted and returned (used for shared profile photos).
 */
async function authenticatePhotoUser(req: FastifyRequest, publicUserId: string | null): Promise<PhotoOwner> {
  const parts = header(req, 'authorization').split(/\s+/).filter(Boolean);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'firebase' || !parts[1]) {
    throw new HttpError(401, 'invalid Firebase authorization');
  }
  const verified = verifyIdToken(parts[1]);
  if (!verified) throw new HttpError(401, 'parse Firebase authorization token failed');
  const claims = verified.claims;
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  const userId = claims.user_id;
  const tokenPublicUserId = claims.puid;
  if (
    claims.iss !== SECURE_TOKEN_ISSUER ||
    !audiences.includes(FIREBASE_PROJECT_ID) ||
    typeof claims.sub !== 'string' ||
    claims.sub === '' ||
    claims.sub !== userId ||
    typeof userId !== 'string' ||
    // Deviation from Solis: ID tokens minted before `puid` was added carry no
    // such claim (the SDK caches them for up to an hour). Those are accepted on
    // the strength of the user_id → account lookup below; a present `puid`
    // must still match.
    (publicUserId !== null && tokenPublicUserId !== undefined && tokenPublicUserId !== publicUserId)
  ) {
    throw new HttpError(401, 'invalid Firebase token claims');
  }
  const owner = await findPhotoOwnerByFirebaseUid(userId);
  if (!owner) throw new HttpError(401, 'retrieve photo owner by Firebase identity failed');
  if (tokenPublicUserId !== undefined && owner.publicUserId !== tokenPublicUserId) {
    throw new HttpError(403, 'photo owner mismatch');
  }
  if (publicUserId !== null && owner.publicUserId !== publicUserId) {
    throw new HttpError(403, 'photo owner mismatch');
  }
  return owner;
}

/**
 * Whether `filename` is the image (or thumbnail) of the favourite photo on
 * that player's profile. A business card is visible to every player of the server (friend
 * lists, user search), so its photo may be read by other players; every other
 * photo stays owner-only.
 */
async function isProfileFavoritePhoto(publicUserId: string, filename: string): Promise<boolean> {
  const [pl] = await db
    .select()
    .from(players)
    .where(sql`${players.data}->>'publicUserId' = ${publicUserId}`)
    .limit(1);
  if (!pl) return false;
  const profile = await getSingleton(pl.id, 'Profile');
  const favoritePhotoId = String(profile?.FavoritePhotoId ?? '');
  if (!favoritePhotoId) return false;
  const photo = (await listElements(pl.id, 'Photos')).find((p) => String(p.PhotoId ?? '') === favoritePhotoId);
  if (!photo) return false;
  const assetId = String(photo.AssetId ?? '');
  // `<asset>_t` is the same photo's thumbnail.
  return assetId !== '' && (filename === assetId || filename === `${assetId}_t`);
}

// ---------------------------------------------------------------------------
// Upload (POST /v0/b/udc-idolypride/o)

async function postPhoto(req: FastifyRequest, reply: FastifyReply) {
  try {
    const query = queryOf(req);
    let name: PhotoObjectName;
    try {
      name = parsePhotoObjectName(query.get('name') ?? '');
    } catch (e) {
      throw new HttpError(400, `parse photo upload name: ${(e as Error).message}`);
    }
    if (query.get('uploadType') !== 'resumable' || header(req, 'x-goog-upload-protocol') !== 'resumable') {
      throw new HttpError(400, 'invalid upload protocol');
    }
    const owner = await authenticatePhotoOwner(req, name.publicUserId);
    const unlock = await lockPhotoObject(name.name);
    try {
      const uploadId = query.get('upload_id') ?? '';
      if (uploadId === '') return await startPhotoUpload(req, reply, query, name, owner);
      return await finalizePhotoUpload(req, reply, query, name, owner, uploadId);
    } finally {
      unlock();
    }
  } catch (e) {
    return sendError(req, reply, e);
  }
}

function sendPhotoUploadStart(reply: FastifyReply, bucket: string, name: string, uploadId: string) {
  const uploadUrl = firebaseStorageUploadUrl(bucket, name, uploadId);
  return reply
    .header('content-type', 'text/plain; charset=utf-8')
    .header('x-guploader-uploadid', uploadId)
    .header('x-goog-upload-status', FIREBASE_STORAGE_UPLOAD_ACTIVE)
    .header('x-goog-upload-url', uploadUrl)
    .header('x-goog-upload-control-url', uploadUrl)
    .header('x-goog-upload-chunk-granularity', FIREBASE_STORAGE_CHUNK_SIZE)
    .send('');
}

async function startPhotoUpload(
  req: FastifyRequest,
  reply: FastifyReply,
  query: URLSearchParams,
  name: PhotoObjectName,
  owner: PhotoOwner,
) {
  if (header(req, 'x-goog-upload-command') !== 'start' || (query.get('upload_protocol') ?? '') !== '') {
    throw new HttpError(400, 'invalid upload command');
  }
  if (header(req, 'x-goog-upload-header-content-type') !== FIREBASE_STORAGE_CONTENT_TYPE) {
    throw new HttpError(400, 'invalid photo content type');
  }
  let request: { contentType?: unknown };
  try {
    // Fastify's built-in parser already decodes `application/json` bodies.
    const raw = req.body;
    request =
      raw !== null && typeof raw === 'object' && !Buffer.isBuffer(raw)
        ? (raw as { contentType?: unknown })
        : JSON.parse(bodyOf(req).toString('utf8'));
  } catch (e) {
    throw new HttpError(400, `decode photo upload metadata: ${(e as Error).message}`);
  }
  if (request?.contentType !== FIREBASE_STORAGE_CONTENT_TYPE) {
    throw new HttpError(400, 'photo upload metadata content type must be image/jpeg');
  }
  const now = new Date();
  purgeStalePhotoUploadChunks(now.getTime());
  await deleteExpiredPhotoImageUploads(now);

  const uploadId = newFirebaseUploadId();
  const started = await startPhotoImageUploadRow(
    {
      id: name.name,
      playerId: owner.serverUserId,
      publicUserId: name.publicUserId,
      uploadId,
      uploadState: UPLOAD_ACTIVE,
      uploadStateUpdatedAt: now,
      uploadExpiresAt: new Date(now.getTime() + PHOTO_UPLOAD_SESSION_MS),
      name: name.name,
      bucket: bucketOf(req),
      contentType: FIREBASE_STORAGE_CONTENT_TYPE,
    },
    new Date(now.getTime() - PHOTO_UPLOAD_LEASE_MS),
  );
  if (!started) {
    const existing = await findPhotoImageMetadata(name.name);
    if (
      existing &&
      existing.playerId === owner.serverUserId &&
      existing.publicUserId === name.publicUserId &&
      existing.uploadState === UPLOAD_ACTIVE
    ) {
      return sendPhotoUploadStart(reply, bucketOf(req), name.name, existing.uploadId);
    }
    if (!existing) throw new HttpError(409, 'retrieve existing photo upload after unsuccessful start: not found');
    throw new HttpError(409, 'photo upload is being finalized');
  }
  req.log.info({ name: name.name, uploadId: uploadId.slice(0, 12) }, 'photo upload started');
  return sendPhotoUploadStart(reply, bucketOf(req), name.name, uploadId);
}

async function releasePhotoUpload(req: FastifyRequest, session: PhotoImageMetadata): Promise<void> {
  const now = new Date();
  try {
    const released = await releasePhotoImageUploadRow(
      session.name,
      session.playerId,
      session.uploadId,
      session.finalizationId ?? '',
      now,
      new Date(now.getTime() + PHOTO_UPLOAD_SESSION_MS),
    );
    if (!released) req.log.warn('photo upload session was no longer owned while releasing it');
  } catch (e) {
    req.log.error({ err: (e as Error).message }, 'failed to release photo upload session');
  }
}

async function finalizePhotoUpload(
  req: FastifyRequest,
  reply: FastifyReply,
  query: URLSearchParams,
  name: PhotoObjectName,
  owner: PhotoOwner,
  uploadId: string,
) {
  const command = header(req, 'x-goog-upload-command');
  const offsetHeader = header(req, 'x-goog-upload-offset');
  if (query.get('upload_protocol') !== 'resumable') {
    throw new HttpError(400, `invalid upload finalization (command=${command} offset=${offsetHeader})`);
  }

  let session = await findPhotoImageMetadata(name.name);
  if (!session) throw new HttpError(400, 'unknown upload session');
  if (session.playerId !== owner.serverUserId || session.publicUserId !== name.publicUserId || session.uploadId !== uploadId) {
    throw new HttpError(403, 'invalid upload session');
  }
  if (session.uploadState === UPLOAD_FINALIZED) {
    clearPhotoUploadChunk(uploadId);
    return sendMetadata(reply, uploadId, FIREBASE_STORAGE_UPLOAD_FINAL, session);
  }
  if (session.uploadState !== UPLOAD_ACTIVE) throw new HttpError(409, 'upload is being finalized');
  if (session.uploadExpiresAt && session.uploadExpiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, 'upload session expired');
  }

  if (command === 'query') {
    return sendUploadActive(reply, uploadId, photoUploadBytesReceived(uploadId));
  }
  if (command !== 'upload' && command !== 'upload, finalize' && command !== 'finalize') {
    throw new HttpError(400, `invalid upload finalization (command=${command} offset=${offsetHeader})`);
  }

  const finalizedBody = appendPhotoUploadChunk(uploadId, parseUploadOffset(offsetHeader), bodyOf(req));
  if (finalizedBody === null) {
    throw new HttpError(400, `invalid upload finalization (command=${command} offset=${offsetHeader})`);
  }
  if (command === 'upload') {
    return sendUploadActive(reply, uploadId, finalizedBody.length);
  }

  const body = finalizedBody;
  if (body.length === 0) throw new HttpError(400, 'empty photo');
  let dims: { width: number; height: number };
  try {
    dims = jpegDimensions(body);
  } catch (e) {
    throw new HttpError(400, `decode JPEG photo configuration: ${(e as Error).message}`);
  }
  if (dims.width <= 0 || dims.height <= 0 || dims.width * dims.height > MAXIMUM_PHOTO_PIXELS) {
    throw new HttpError(400, `invalid JPEG photo dimensions: ${dims.width}x${dims.height} exceeds permitted dimensions`);
  }

  const finalizationId = randomUUID();
  const claimTime = new Date();
  const claimExpiresAt = new Date(claimTime.getTime() + PHOTO_UPLOAD_SESSION_MS);
  const claimed = await claimPhotoImageUpload(name.name, owner.serverUserId, uploadId, finalizationId, claimTime, claimExpiresAt);
  if (!claimed) {
    const current = await findPhotoImageMetadata(name.name);
    if (
      current &&
      current.playerId === owner.serverUserId &&
      current.uploadId === uploadId &&
      current.uploadState === UPLOAD_FINALIZED
    ) {
      clearPhotoUploadChunk(uploadId);
      return sendMetadata(reply, uploadId, FIREBASE_STORAGE_UPLOAD_FINAL, current);
    }
    if (!current) throw new HttpError(409, 'retrieve photo upload after unsuccessful claim: not found');
    throw new HttpError(409, 'upload is no longer active');
  }
  session = {
    ...session,
    finalizationId,
    uploadState: UPLOAD_FINALIZING,
    uploadStateUpdatedAt: claimTime,
    uploadExpiresAt: claimExpiresAt,
  };

  // Go truncates to milliseconds; JS Dates already are.
  const createdAt = new Date();
  const metadata = completePhotoMetadata(session, name.filename, body, createdAt);
  let publication: PhotoImagePublication;
  try {
    publication = await publishPhotoImage(photoImagePath(name.publicUserId, name.filename), body, createdAt);
  } catch (e) {
    await releasePhotoUpload(req, session);
    throw new HttpError(500, `store photo image: ${(e as Error).message}`);
  }

  let completed = false;
  let completeErr: unknown = null;
  try {
    completed = await completePhotoImageUpload(metadata);
  } catch (e) {
    completeErr = e;
  }
  if (!completed) {
    const current = await findPhotoImageMetadata(name.name).catch(() => undefined);
    if (current && samePublishedPhoto(current, metadata)) {
      await publication.commit().catch((e) => req.log.error({ err: (e as Error).message }, 'failed to remove previous photo image'));
      clearPhotoUploadChunk(uploadId);
      return sendMetadata(reply, uploadId, FIREBASE_STORAGE_UPLOAD_FINAL, current);
    }
    const reason = completeErr ? (completeErr as Error).message : 'photo metadata completion did not update the upload session';
    if (
      current &&
      current.playerId === session.playerId &&
      current.uploadId === session.uploadId &&
      current.finalizationId === session.finalizationId &&
      current.uploadState === UPLOAD_FINALIZING
    ) {
      try {
        await publication.rollback();
      } catch (rollbackErr) {
        throw new HttpError(500, `photo metadata remained uncommitted: ${reason}; roll back image publication: ${(rollbackErr as Error).message}`);
      }
      await releasePhotoUpload(req, session);
      throw new HttpError(500, `photo metadata remained uncommitted; image publication rolled back: ${reason}`);
    }
    if (!current) {
      await publication.rollback().catch(() => undefined);
      throw new HttpError(500, `photo metadata disappeared during finalization; image publication rolled back: ${reason}`);
    }
    // Ambiguous outcome: preserve the published bytes.
    throw new HttpError(500, `photo metadata finalization outcome is ambiguous; preserving published image: ${reason}`);
  }
  await publication.commit().catch((e) => req.log.error({ err: (e as Error).message }, 'failed to remove previous photo image'));
  clearPhotoUploadChunk(uploadId);
  req.log.info({ name: name.name, size: body.length, width: dims.width, height: dims.height }, 'photo upload finalized');
  return sendMetadata(reply, uploadId, FIREBASE_STORAGE_UPLOAD_FINAL, metadata);
}

/**
 * Copy a published image (and its `_t` thumbnail) to a fresh asset id.
 *
 * The client caches downloaded images by asset id and reuses ids, so minting a
 * photo against an already-used id shows the previous image. Cloning into a new
 * id publishes an independent object with fresh generation/download token.
 */
export async function clonePhotoImage(
  playerId: string,
  publicUserId: string,
  sourceAssetId: string,
  targetAssetId: string,
  // Callers inside a player transaction must pass it: the metadata row's player
  // foreign key would otherwise wait on that transaction's player row lock.
  exec: Executor = db,
): Promise<void> {
  if (!isPhotoFilename(sourceAssetId) || !isPhotoFilename(targetAssetId)) {
    throw new Error('clonePhotoImage: invalid asset id');
  }
  const createdAt = new Date();
  for (const suffix of ['', '_t']) {
    const sourceName = `${PHOTO_OBJECT_PREFIX}/${publicUserId}/${sourceAssetId}${suffix}`;
    const targetName = `${PHOTO_OBJECT_PREFIX}/${publicUserId}/${targetAssetId}${suffix}`;
    const source = await findPhotoImageMetadata(sourceName);
    // A nonempty generation marks the last published bytes (the same rule as
    // Photo:GetImageURL); unfinished uploads cannot be cloned.
    if (!source || source.generation === '' || source.playerId !== playerId || source.publicUserId !== publicUserId) {
      throw new Error(`clonePhotoImage: source ${sourceName} missing`);
    }
    const targetFilename = `${targetAssetId}${suffix}`;
    const sourcePath = photoImagePath(source.publicUserId, `${sourceAssetId}${suffix}`);
    const targetPath = photoImagePath(publicUserId, targetFilename);
    const unlock = await lockPhotoObject(targetName);
    try {
      const body = await readFile(sourcePath);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o750 });
      await copyFile(sourcePath, targetPath);
      const metadata = completePhotoMetadata(
        {
          ...source,
          id: targetName,
          name: targetName,
          // Per-object bookkeeping and derived fields are regenerated exactly
          // as an upload finalization would, so the clone is served normally.
          uploadId: newFirebaseUploadId(),
          uploadState: UPLOAD_ACTIVE,
          finalizationId: null,
          uploadStateUpdatedAt: createdAt,
          uploadExpiresAt: null,
          generation: '',
          metageneration: '',
        },
        targetFilename,
        body,
        createdAt,
      );
      try {
        await exec.insert(photoImageMetadata).values(metadata);
      } catch (e) {
        await removeIfExists(targetPath);
        throw e;
      }
    } finally {
      unlock();
    }
  }
}

// ---------------------------------------------------------------------------
// Download / metadata (GET /v0/b/udc-idolypride/o/<name>)

async function getPhoto(req: FastifyRequest, reply: FastifyReply) {
  try {
    // Use the raw path segment (Solis decodes `c.Params("*")` exactly once).
    const rawPath = (req.url ?? '').split('?')[0];
    const prefix = `/v0/b/${bucketOf(req)}/o/`;
    let decodedName: string;
    try {
      decodedName = decodeURIComponent(rawPath.slice(prefix.length));
    } catch (e) {
      throw new HttpError(400, `decode photo download name: ${(e as Error).message}`);
    }
    let name: PhotoObjectName;
    try {
      name = parsePhotoObjectName(decodedName);
    } catch (e) {
      throw new HttpError(400, `parse photo download name: ${(e as Error).message}`);
    }
    const query = queryOf(req);
    const responseType = query.get('alt') ?? '';
    if (responseType !== '' && responseType !== 'media') throw new HttpError(400, 'invalid alternate response type');
    let owner: PhotoOwner | null = null;
    let sharedProfilePhoto = false;
    if (responseType === '') {
      const viewer = await authenticatePhotoUser(req, null);
      if (viewer.publicUserId === name.publicUserId) {
        owner = await authenticatePhotoOwner(req, name.publicUserId);
      } else if (await isProfileFavoritePhoto(name.publicUserId, name.filename)) {
        sharedProfilePhoto = true;
      } else {
        throw new HttpError(403, 'photo owner mismatch');
      }
    }

    const unlock = await lockPhotoObject(name.name);
    try {
      const metadata = await findPhotoImageMetadata(name.name);
      if (!metadata || metadata.generation === '') throw new HttpError(404, 'photo not found');
      if (responseType === 'media') {
        const token = query.get('token') ?? '';
        if (token === '' || token !== metadata.downloadTokens) throw new HttpError(403, 'invalid download token');
        return await sendPhotoImage(req, reply, name, metadata);
      }
      if (
        !sharedProfilePhoto &&
        (!owner || metadata.playerId !== owner.serverUserId || metadata.publicUserId !== owner.publicUserId)
      ) {
        throw new HttpError(403, 'photo owner mismatch');
      }
      return sendMetadata(reply, newFirebaseUploadId(), '', metadata);
    } finally {
      unlock();
    }
  } catch (e) {
    return sendError(req, reply, e);
  }
}

async function sendPhotoImage(req: FastifyRequest, reply: FastifyReply, name: PhotoObjectName, metadata: PhotoImageMetadata) {
  const md5Digest = Buffer.from(metadata.md5Hash, 'base64');
  if (md5Digest.length !== 16) {
    throw new HttpError(500, `invalid stored photo MD5 length: got ${md5Digest.length} bytes, want 16`);
  }
  const createdAt = new Date(metadata.timeCreated);
  if (Number.isNaN(createdAt.getTime())) throw new HttpError(500, 'parse stored photo creation time failed');
  const etag = `"${md5Digest.toString('hex')}"`;

  reply.header('content-type', metadata.contentType);
  reply.header('x-guploader-uploadid', newFirebaseUploadId());
  reply.header('expires', new Date().toUTCString());
  reply.header('cache-control', 'private, no-cache, max-age=0');
  reply.header('last-modified', createdAt.toUTCString());
  reply.header('etag', etag);
  reply.header('x-goog-generation', metadata.generation);
  reply.header('x-goog-metageneration', metadata.metageneration);
  reply.header('x-goog-stored-content-encoding', metadata.contentEncoding);
  reply.header('x-goog-stored-content-length', metadata.size);
  reply.header('x-goog-meta-firebasestoragedownloadtokens', metadata.downloadTokens);
  reply.header('content-disposition', metadata.contentDisposition);
  reply.header('x-goog-hash', [`crc32c=${metadata.crc32c}`, `md5=${metadata.md5Hash}`]);
  reply.header('x-goog-storage-class', metadata.storageClass);

  // Only the content ETag validates mutable photo URLs (If-Modified-Since is
  // ignored, as in Solis). A request `Cache-Control: no-cache` is never fresh.
  const ifNoneMatch = header(req, 'if-none-match');
  const noCache = /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(header(req, 'cache-control'));
  if (ifNoneMatch && !noCache) {
    const tags = ifNoneMatch.split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (tags.includes('*') || tags.includes(etag)) return reply.code(304).send();
  }

  const path = photoImagePath(name.publicUserId, name.filename);
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (e) {
    throw new HttpError(500, `send photo image "${name.name}": ${(e as Error).message}`);
  }
  reply.header('accept-ranges', 'bytes');
  const range = header(req, 'range');
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (range && match && (match[1] !== '' || match[2] !== '')) {
    let start: number;
    let end: number;
    if (match[1] === '') {
      start = Math.max(0, data.length - Number(match[2]));
      end = data.length - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? data.length - 1 : Math.min(Number(match[2]), data.length - 1);
    }
    if (start >= data.length || start > end) {
      return reply.code(416).header('content-range', `bytes */${data.length}`).send('');
    }
    return reply
      .code(206)
      .header('content-range', `bytes ${start}-${end}/${data.length}`)
      .send(data.subarray(start, end + 1));
  }
  return reply.send(data);
}

// ---------------------------------------------------------------------------
// Photo:Delete cleanup (Solis photo/delete.go removeUserPhotoImageObjects)

export async function removeUserPhotoImageObjects(
  log: { warn: (obj: object, msg: string) => void },
  suid: string,
  assetIds: string[],
): Promise<void> {
  if (!assetIds.length) return;
  let publicUserId: string;
  try {
    publicUserId = await publicUserIdForPlayer(suid);
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'failed to find photo owner while cleaning image objects');
    return;
  }
  const names = assetIds.map((assetId) => `${PHOTO_OBJECT_PREFIX}/${publicUserId}/${assetId}`);
  let metadata: PhotoImageMetadata[];
  try {
    metadata = await findPhotoImageMetadataByNames(suid, names);
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'failed to find photo image metadata for cleanup');
    return;
  }
  const removedNames: string[] = [];
  for (const object of metadata) {
    const path = photoImagePath(object.publicUserId, basename(object.name));
    try {
      await rm(path, { force: true });
    } catch (e) {
      log.warn({ path, err: (e as Error).message }, 'failed to delete photo image file');
      continue;
    }
    removedNames.push(object.name);
  }
  // Keep metadata for files that could not be removed so a later cleanup can retry.
  try {
    await deletePhotoImageMetadataByNames(suid, removedNames);
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'failed to delete photo image metadata');
  }
}

export function isPhotoAssetId(value: string): boolean {
  return isPhotoFilename(value);
}

export async function photoFileExists(publicUserId: string, filename: string): Promise<boolean> {
  try {
    await stat(photoImagePath(publicUserId, filename));
    return true;
  } catch {
    return false;
  }
}

export function registerFirebaseStorage(app: FastifyInstance): void {
  for (const bucket of FIREBASE_STORAGE_BUCKETS) {
    app.post(`/v0/b/${bucket}/o`, postPhoto);
    app.get(`/v0/b/${bucket}/o/*`, getPhoto);
  }
}
