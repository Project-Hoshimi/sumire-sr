import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { type Executor } from '../db/tx.ts';
import { playerEntities, players } from '../db/schema.ts';
import {
  decodeMessage,
  encodeMessage,
  msgRegistry,
  Reader,
  Writer,
  type Decoded,
  type MessageShape,
} from '@sumire-sr/protocol/runtime/proto.ts';
import userGetShapeImport from '@sumire-sr/protocol/gen/Solis_Common_Proto_Api_UserGetResponse.ts';

/**
 * Full player-state layer.
 *
 * Every field of the `User:Get` response (except the synthesized `UserPublic`)
 * is treated as a piece of per-player state stored in the generic
 * `player_entities` table: repeated message fields as ordered collections and
 * singular message fields as singletons. Each element/singleton is stored as a
 * base64-encoded protobuf blob, so arbitrary nested/computed fields survive
 * without modelling every message.
 *
 * State is seeded lazily from the captured `User:Get` corpus template on first
 * read, then owned by the DB. Any RPC response carrying
 * `CommonResponse.UpdatedData`/`DeletedData` is materialized back into the same
 * store (see `applyCommonResponse`), so the whole captured surface becomes
 * server-authoritative and mutable per account.
 */

const RESPONSE_MSG = 'Solis.Common.Proto.Api.UserGetResponse';
const SYNTHESized_FIELD = 'UserPublic';

/**
 * `players.data.seed` marker for accounts created after the fresh-account
 * capture landed. Rows without it predate the marker and stay corpus-seeded.
 */
export const FRESH_SEED = 'fresh';

export type PlayerRow = typeof players.$inferSelect;

/** True when the player was created against the fresh (not corpus) template. */
export function isFreshPlayer(player: Pick<PlayerRow, 'data'>): boolean {
  return (player.data as { seed?: string } | null)?.seed === FRESH_SEED;
}

/** The player row owned by an authenticated account, if any. */
export async function findPlayerByAccountId(accountId: string | undefined): Promise<PlayerRow | undefined> {
  if (!accountId) return undefined;
  const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  return pl;
}

/** Identity fields used to merge `UpdatedData` elements into a collection. */
const KEY_FIELDS: Record<string, string[]> = {
  Items: ['ItemId'],
  Cards: ['CardId'],
  Characters: ['CharacterId'],
  Costumes: ['CostumeId'],
  Accessories: ['AccessoryId'],
  Photos: ['PhotoId'],
  Decks: ['Number'],
  DeckPositions: ['Number', 'Position'],
  Stories: ['StoryId'],
  Points: ['PointType'],
  Messages: ['MessageId'],
  Telephones: ['TelephoneId'],
  Tutorials: ['TutorialType'],
  Missions: ['MissionId'],
  Emblems: ['EmblemId'],
  CharacterMusics: ['CharacterId', 'MusicId'],
  Areas: ['AreaId'],
  Quests: ['QuestId'],
  GachaButtons: ['GachaButtonId'],
  HomeTalks: ['HomeTalkId'],
  CardSupports: ['Number', 'CardId'],
  MessageSchedules: ['MessageId'],
  Notifications: [],
  HomePositions: ['HomePositionType'],
  Musics: ['MusicId'],
  Decorations: ['DecorationId'],
  PhotoRecipes: ['PhotoRecipeId'],
  Hairs: ['HairId'],
  Loves: ['LoveId'],
  LeagueDeckPositions: ['LeagueSeasonId', 'Position'],
  Duties: ['DutyId'],
  DutyPoints: ['DutyPointId'],
  Showcases: ['Number'],
  ShowcaseMusics: ['ShowcaseMusicId'],
  ShowcaseToys: ['ShowcaseToyId'],
  ShowcaseMysets: ['Number'],
  TourAreas: ['TourId'],
  PhotoPoses: ['PhotoPoseId'],
  ExcursionGazeReactions: ['CharacterId', 'ExcursionPlaceId', 'GazeReactionNumber'],
};

/** Player-row scalar fields that stay authoritative over the entity store. */
const SCALAR_USER = { name: 'Name', level: 'ManagerLevel', exp: 'ManagerExp' } as const;

export type FieldSpec = {
  field: string;
  repeated: boolean;
  shape: MessageShape;
  keyFields: string[];
};

let specsCache: FieldSpec[] | null = null;

function elementShape(name: string | undefined): MessageShape | null {
  if (!name) return null;
  return msgRegistry.get(name) ?? null;
}

/** Derive per-field specs once from the User:Get response schema. */
export function fieldSpecs(): FieldSpec[] {
  if (specsCache) return specsCache;
  const shape = msgRegistry.get(RESPONSE_MSG) ?? (userGetShapeImport as MessageShape);
  const specs: FieldSpec[] = [];
  for (const f of shape.fields) {
    if (f.name === SYNTHESized_FIELD) continue;
    const el = f.repeated ? f.element : f;
    const name = el?.message;
    const s = elementShape(name);
    if (!s) continue;
    specs.push({
      field: f.name!,
      repeated: !!f.repeated,
      shape: s,
      keyFields: KEY_FIELDS[f.name!] ?? [],
    });
  }
  specsCache = specs;
  return specs;
}

function keyOf(spec: FieldSpec, el: Decoded): string | null {
  if (spec.keyFields.length === 0) return null;
  const parts = spec.keyFields.map((k) => {
    const v = el[k];
    return v === undefined || v === null ? '' : typeof v === 'bigint' ? v.toString() : String(v);
  });
  if (parts.every((p) => p === '')) return null;
  return parts.join('\u0001');
}

function encodeElement(shape: MessageShape, el: Decoded): string {
  const w = new Writer();
  encodeMessage(shape, el, w);
  return Buffer.from(w.toBytes()).toString('base64');
}

function decodeElement(shape: MessageShape, blob: string): Decoded {
  return decodeMessage(shape, new Reader(Uint8Array.from(Buffer.from(blob, 'base64'))));
}

type Row = typeof playerEntities.$inferSelect;

async function rowsForPlayer(playerId: string): Promise<Row[]> {
  return db
    .select()
    .from(playerEntities)
    .where(eq(playerEntities.playerId, playerId))
    .orderBy(asc(playerEntities.ordinal));
}

/**
 * Seed any missing fields from the template and return the effective state for
 * the whole `User:Get` surface. Existing kinds are served from the DB as-is.
 */
export async function loadOrSeed(
  playerId: string,
  template: Decoded,
): Promise<{
  collections: Record<string, Decoded[]>;
  singletons: Record<string, Decoded>;
  seeded: number;
  served: number;
}> {
  const rows = await rowsForPlayer(playerId);
  const byKind = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byKind.get(r.kind);
    if (list) list.push(r);
    else byKind.set(r.kind, [r]);
  }

  const collections: Record<string, Decoded[]> = {};
  const singletons: Record<string, Decoded> = {};
  let seeded = 0;
  let served = 0;

  for (const spec of fieldSpecs()) {
    const existing = byKind.get(spec.field);
    if (existing && existing.length > 0) {
      const decoded = existing.map((r) => decodeElement(spec.shape, r.blob));
      if (spec.repeated) collections[spec.field] = decoded;
      else singletons[spec.field] = decoded[0];
      served++;
      continue;
    }
    const source = template[spec.field];
    if (source === undefined || source === null) continue;
    if (spec.repeated) {
      const arr = source as Decoded[];
      if (!Array.isArray(arr)) continue;
      collections[spec.field] = arr;
      await insertElements(playerId, spec, arr, 0);
    } else {
      singletons[spec.field] = source as Decoded;
      await insertElements(playerId, spec, [source as Decoded], 0);
    }
    seeded++;
  }

  return { collections, singletons, seeded, served };
}

async function insertElements(
  playerId: string,
  spec: FieldSpec,
  elements: Decoded[],
  startOrdinal: number,
  exec: Executor = db,
): Promise<void> {
  if (!elements.length) return;
  const rows = elements.map((el, i) => ({
    id: randomUUID(),
    playerId,
    kind: spec.field,
    entityKey: keyOf(spec, el) ?? `#${startOrdinal + i}`,
    ordinal: startOrdinal + i,
    blob: encodeElement(spec.shape, el),
  }));
  await exec.insert(playerEntities).values(rows).onConflictDoNothing();
}

/** Replace or append elements of a collection, matching on the identity key. */
async function upsertElements(
  playerId: string,
  spec: FieldSpec,
  elements: Decoded[],
  exec: Executor = db,
): Promise<void> {
  if (!elements.length) return;
  // Keyless collections (Staffs/Notifications/Tutorials) have no way to merge
  // element-wise; skip delta application rather than append duplicates.
  if (spec.keyFields.length === 0) return;
  const existing = await exec
    .select()
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, spec.field)));

  const byKey = new Map<string, Row>();
  let maxOrdinal = -1;
  for (const r of existing) {
    if (r.entityKey) byKey.set(r.entityKey, r);
    if (r.ordinal > maxOrdinal) maxOrdinal = r.ordinal;
  }

  const inserts: (typeof playerEntities.$inferInsert)[] = [];
  for (const el of elements) {
    const key = keyOf(spec, el);
    const blob = encodeElement(spec.shape, el);
    const hit = key !== null ? byKey.get(key) : undefined;
    if (hit) {
      await exec.update(playerEntities).set({ blob, entityKey: key! }).where(eq(playerEntities.id, hit.id));
    } else {
      maxOrdinal++;
      inserts.push({
        id: randomUUID(),
        playerId,
        kind: spec.field,
        entityKey: key ?? `#${maxOrdinal}`,
        ordinal: maxOrdinal,
        blob,
      });
    }
  }
  if (inserts.length) await exec.insert(playerEntities).values(inserts);
}

/** Store (or clear) a singleton field blob. */
async function upsertSingleton(
  playerId: string,
  spec: FieldSpec,
  value: Decoded | null,
  exec: Executor = db,
): Promise<void> {
  await exec
    .delete(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, spec.field)));
  if (value === null) return;
  await exec.insert(playerEntities).values({
    id: randomUUID(),
    playerId,
    kind: spec.field,
    entityKey: '',
    ordinal: 0,
    blob: encodeElement(spec.shape, value),
  });
}

/** Delete collection elements by identity key. */
async function deleteElements(
  playerId: string,
  spec: FieldSpec,
  elements: Decoded[],
  exec: Executor = db,
): Promise<void> {
  const keys = elements.map((el) => keyOf(spec, el)).filter((k): k is string => k !== null);
  if (!keys.length) return;
  await exec
    .delete(playerEntities)
    .where(
      and(
        eq(playerEntities.playerId, playerId),
        eq(playerEntities.kind, spec.field),
        inArray(playerEntities.entityKey, keys),
      ),
    );
}

/**
 * Replace a single deck (by `Number`) with the given name + positions. Positions
 * submitted for that deck are upserted; any previously stored position for the
 * same deck that is absent from the request is removed.
 */
export async function saveDeck(
  playerId: string,
  deck: { Number: number; Name: string },
  positions: Decoded[],
  exec: Executor = db,
): Promise<void> {
  const specs = new Map(fieldSpecs().map((s) => [s.field, s]));
  const deckSpec = specs.get('Decks');
  const posSpec = specs.get('DeckPositions');
  if (!deckSpec || !posSpec) return;

  await upsertElements(
    playerId,
    deckSpec,
    [{ __msg: deckSpec.shape.name, Number: deck.Number, Name: deck.Name } as Decoded],
    exec,
  );

  const submitted = new Set(positions.map((p) => keyOf(posSpec, p)).filter((k): k is string => k !== null));
  const existing = await exec
    .select()
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, 'DeckPositions')));
  const stale = existing.filter((r) => {
    const el = decodeElement(posSpec.shape, r.blob);
    if (el.Number !== deck.Number) return false;
    const key = keyOf(posSpec, el);
    return key === null || !submitted.has(key);
  });
  if (stale.length) {
    await exec.delete(playerEntities).where(inArray(playerEntities.id, stale.map((r) => r.id)));
  }

  await upsertElements(playerId, posSpec, positions, exec);
}

/** Persist `User`/`Balance`/`Points` scalars onto the player row. */
async function applyScalars(playerId: string, updated: Decoded, exec: Executor = db): Promise<void> {
  const patch: Partial<typeof players.$inferInsert> = {};
  const u = updated.User as Decoded | undefined;
  if (u) {
    if (u[SCALAR_USER.name] != null) patch.name = String(u[SCALAR_USER.name]);
    if (u[SCALAR_USER.level] != null) patch.level = Number(u[SCALAR_USER.level]);
    if (u[SCALAR_USER.exp] != null) patch.exp = Number(u[SCALAR_USER.exp]);
  }
  const b = updated.Balance as Decoded | undefined;
  if (b && b.FreeBalance != null) patch.freeJewel = Number(b.FreeBalance);
  const pts = updated.Points as Decoded[] | undefined;
  if (Array.isArray(pts)) {
    for (const p of pts) {
      if (p.PointType === 1 && p.Amount != null) patch.gold = Number(p.Amount);
      else if (p.PointType === 4 && p.Amount != null) patch.stamina = Number(p.Amount);
    }
  }
  if (Object.keys(patch).length) {
    await exec.update(players).set(patch).where(eq(players.id, playerId));
  }
}

/**
 * Apply an `UpdatedData` / `DeletedData` pair to a player's state. Repeated
 * fields are merged element-wise by identity key (absolute values, so the
 * operation is idempotent); singular fields replace; `DeletedData` removes.
 */
export async function applyUpdatedData(
  playerId: string,
  updated: Decoded | null,
  deleted: Decoded | null,
  exec: Executor = db,
): Promise<void> {
  const specs = new Map(fieldSpecs().map((s) => [s.field, s]));

  if (updated) {
    await applyScalars(playerId, updated, exec);
    for (const spec of specs.values()) {
      const v = updated[spec.field];
      if (v === undefined || v === null) continue;
      if (spec.repeated) {
        if (Array.isArray(v)) await upsertElements(playerId, spec, v, exec);
      } else {
        await upsertSingleton(playerId, spec, v as Decoded, exec);
      }
    }
  }

  if (deleted) {
    for (const spec of specs.values()) {
      const v = deleted[spec.field];
      if (v === undefined || v === null) continue;
      if (spec.repeated && Array.isArray(v)) await deleteElements(playerId, spec, v, exec);
      else if (!spec.repeated) await upsertSingleton(playerId, spec, null, exec);
    }
  }
}

const COMMON_MSG = 'Solis.Common.Proto.Api.CommonResponse';

/**
 * Inspect a decoded RPC response for a `CommonResponse` and materialize any
 * `UpdatedData`/`DeletedData` into the player state. Safe no-op otherwise.
 */
export async function applyCommonResponse(
  playerId: string,
  responseShape: MessageShape | null,
  decoded: Decoded,
  exec: Executor = db,
): Promise<boolean> {
  const field =
    responseShape?.fields.find((f) => f.name === 'CommonResponse' && f.message) ??
    (responseShape?.name === COMMON_MSG ? { message: COMMON_MSG } : undefined);
  const msg = field?.message;
  if (!msg) return false;
  const common =
    responseShape?.name === COMMON_MSG ? decoded : (decoded.CommonResponse as Decoded | undefined);
  if (!common) return false;
  const updated = (common.UpdatedData as Decoded | undefined) ?? null;
  const deleted = (common.DeletedData as Decoded | undefined) ?? null;
  if (!updated && !deleted) return false;
  await applyUpdatedData(playerId, updated, deleted, exec);
  return true;
}

function specFor(field: string): FieldSpec | undefined {
  return fieldSpecs().find((s) => s.field === field);
}

/** Read an ordered collection (decoded) for a player. */
export async function listElements(
  playerId: string,
  field: string,
  exec: Executor = db,
): Promise<Decoded[]> {
  const spec = specFor(field);
  if (!spec) return [];
  const rows = await exec
    .select()
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, field)))
    .orderBy(asc(playerEntities.ordinal));
  return rows.map((r) => decodeElement(spec.shape, r.blob));
}

/** Merge elements into a collection by identity key (upsert). */
export async function putElements(
  playerId: string,
  field: string,
  elements: Decoded[],
  exec: Executor = db,
): Promise<void> {
  const spec = specFor(field);
  if (!spec) return;
  await upsertElements(playerId, spec, elements, exec);
}

/**
 * Replace an entire collection with `elements` in two statements (delete +
 * multi-row insert). Used by the sandbox seeder, which owns the full desired
 * state for maxed collections and must not pay one round-trip per row.
 */
export async function replaceElements(
  playerId: string,
  field: string,
  elements: Decoded[],
  exec: Executor = db,
): Promise<void> {
  const spec = specFor(field);
  if (!spec) return;
  await exec
    .delete(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, field)));
  await insertElements(playerId, spec, elements, 0, exec);
}

/** Remove collection elements by identity key. */
export async function removeElements(
  playerId: string,
  field: string,
  elements: Decoded[],
  exec: Executor = db,
): Promise<void> {
  const spec = specFor(field);
  if (!spec) return;
  await deleteElements(playerId, spec, elements, exec);
}

/** The registered element shape name for a collection (e.g. `Items`). */
export function collectionElementMsg(field: string): string | null {
  return specFor(field)?.shape.name ?? null;
}

/**
 * Marker for singleton rows that are not part of the `User:Get` schema. Such
 * rows hold a base64-encoded JSON document instead of a protobuf blob, which
 * lets server-only state (e.g. `ActivityPromotion`) share the same
 * `player_entities` store without inventing a table.
 */
const JSON_SINGLETON_PREFIX = 'json:';

async function readJsonSingleton(
  playerId: string,
  field: string,
  exec: Executor,
): Promise<Decoded | null> {
  const rows = await exec
    .select()
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, field)))
    .limit(1);
  if (!rows.length) return null;
  const blob = rows[0].blob;
  if (!blob.startsWith(JSON_SINGLETON_PREFIX)) return null;
  const raw = Buffer.from(blob.slice(JSON_SINGLETON_PREFIX.length), 'base64').toString('utf8');
  return JSON.parse(raw) as Decoded;
}

async function writeJsonSingleton(
  playerId: string,
  field: string,
  value: Decoded | null,
  exec: Executor,
): Promise<void> {
  await exec
    .delete(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, field)));
  if (value === null) return;
  const raw = JSON.stringify(value);
  await exec.insert(playerEntities).values({
    id: randomUUID(),
    playerId,
    kind: field,
    entityKey: '',
    ordinal: 0,
    blob: JSON_SINGLETON_PREFIX + Buffer.from(raw, 'utf8').toString('base64'),
  });
}

/** Read a singleton field (decoded) for a player, or null when unset. */
export async function getSingleton(
  playerId: string,
  field: string,
  exec: Executor = db,
): Promise<Decoded | null> {
  const spec = specFor(field);
  if (!spec) return readJsonSingleton(playerId, field, exec);
  if (spec.repeated) return null;
  const rows = await exec
    .select()
    .from(playerEntities)
    .where(and(eq(playerEntities.playerId, playerId), eq(playerEntities.kind, field)))
    .limit(1);
  if (!rows.length) return null;
  return decodeElement(spec.shape, rows[0].blob);
}

/** Store (or clear, when `value` is null) a singleton field for a player. */
export async function putSingleton(
  playerId: string,
  field: string,
  value: Decoded | null,
  exec: Executor = db,
): Promise<void> {
  const spec = specFor(field);
  if (!spec) {
    await writeJsonSingleton(playerId, field, value, exec);
    return;
  }
  if (spec.repeated) return;
  await upsertSingleton(playerId, spec, value, exec);
}
