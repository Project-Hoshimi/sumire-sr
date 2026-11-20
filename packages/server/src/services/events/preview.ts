/**
 * Player-state readers and draft-diff helpers used by `previewPublish`.
 *
 * A publish changes boxes, items, and stage rosters that saved player progress
 * points at. `previewPublish` diffs the published draft against the candidate,
 * counts how many players each player-sensitive impact touches, and reports
 * whether the publish must be refused. The Drizzle reader is loaded lazily so
 * importing this module never opens a DB connection.
 */
import type { MarathonState } from '../marathon/state.ts';
import { draftHash } from './canonicalJson.ts';
import type { StateImpact } from './plugin.ts';

export interface MarathonPlayerStateRow {
  playerId: string;
  /**
   * null when the stored blob could not be decoded. `affectedPlayerCount` treats
   * such a player as affected by every player-sensitive impact, the conservative
   * choice, because their draws are unknown.
   */
  state: MarathonState | null;
}

/** Reads every player's marathon state for one event; tests use the memory form. */
export interface MarathonPlayerStateReader {
  listStates(eventId: string): Promise<MarathonPlayerStateRow[]>;
}

/** A player-sensitive impact with the number of players whose progress it touches. */
export type PreviewImpact = StateImpact & { affectedPlayers?: number };

export interface PublishPreview {
  eventId: string;
  fromVersion: number;
  /**
   * SHA-256 hex of the canonical JSON of the draft this preview was computed
   * from. The publish request echoes it back so a draft edited after the
   * preview is refused instead of published unseen.
   */
  draftHash: string;
  /** Top-level draft keys whose JSON differs from the published draft. */
  changedKeys: string[];
  impacts: PreviewImpact[];
  /**
   * True when a `block` impact refuses the publish: a player-sensitive block with
   * at least one affected player, or any block that needs no player check.
   */
  blocking: boolean;
}

/** In-memory reader for DB-free tests; `reset` replaces every stored state. */
export function memoryMarathonPlayerStateReader(
  initial: MarathonPlayerStateRow[] = [],
): MarathonPlayerStateReader & { reset(rows?: MarathonPlayerStateRow[]): void } {
  let rows = initial.map(cloneRow);
  return {
    async listStates(): Promise<MarathonPlayerStateRow[]> {
      return rows.map(cloneRow);
    },
    reset(next: MarathonPlayerStateRow[] = []): void {
      rows = next.map(cloneRow);
    },
  };
}

function cloneRow(row: MarathonPlayerStateRow): MarathonPlayerStateRow {
  return { playerId: row.playerId, state: structuredClone(row.state) };
}

/**
 * Default reader: every `player_entities` row whose kind is the event's
 * `MarathonState:<id>` JSON singleton, decoded through the same helper
 * `playerState.getSingleton` uses. Rows are read in pages of 500 ordered by
 * player id; a row whose blob cannot be decoded is returned with `state: null`
 * (after a warning) so the preview can count that player conservatively.
 */
export function drizzleMarathonPlayerStateReader(): MarathonPlayerStateReader {
  return {
    async listStates(eventId: string): Promise<MarathonPlayerStateRow[]> {
      const [{ db }, { playerEntities }, { asc, eq }, { marathonStateField }, { decodeJsonSingletonBlob }] =
        await Promise.all([
          import('../../db/client.ts'),
          import('../../db/schema.ts'),
          import('drizzle-orm'),
          import('../marathon/state.ts'),
          import('../playerState.ts'),
        ]);
      const pageSize = 500;
      const result: MarathonPlayerStateRow[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const rows = await db
          .select({ playerId: playerEntities.playerId, blob: playerEntities.blob })
          .from(playerEntities)
          .where(eq(playerEntities.kind, marathonStateField(eventId)))
          .orderBy(asc(playerEntities.playerId))
          .limit(pageSize)
          .offset(offset);
        for (const row of rows) {
          try {
            const state = decodeJsonSingletonBlob(row.blob);
            if (state === null) throw new Error('blob is not a JSON singleton');
            result.push({ playerId: row.playerId, state: state as unknown as MarathonState });
          } catch (error) {
            console.warn(
              `[events] cannot decode marathon state for player ${row.playerId}: ${(error as Error).message}`,
            );
            result.push({ playerId: row.playerId, state: null });
          }
        }
        if (rows.length < pageSize) break;
      }
      return result;
    },
  };
}

/** Count players whose saved draws make `impact` relevant. */
export function affectedPlayerCount(
  impact: StateImpact,
  states: MarathonPlayerStateRow[],
): number {
  if (impact.boxId === undefined) return 0;
  let count = 0;
  for (const { state } of states) {
    // Unknown progress counts as affected by every player-sensitive impact.
    if (state === null) {
      count += 1;
      continue;
    }
    const box = state.boxes?.[impact.boxId];
    if (box === undefined) continue;
    const drawn = box.drawn ?? {};
    if (impact.itemKey === undefined) {
      if (Object.values(drawn).some((value) => value > 0)) count += 1;
      continue;
    }
    const drawCount = drawn[impact.itemKey] ?? 0;
    const relevant =
      impact.code === 'stock-lowered' && impact.newStock !== undefined
        ? drawCount > impact.newStock
        : drawCount > 0;
    if (relevant) count += 1;
  }
  return count;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural JSON equality; object key order does not matter, array order does. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => jsonEqual(value, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/** Top-level keys whose JSON differs between the published and next draft. */
export function changedDraftKeys(
  published: Record<string, unknown> | undefined,
  draft: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(published ?? {}), ...Object.keys(draft)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (!jsonEqual(published?.[key], draft[key])) changed.push(key);
  }
  return changed;
}
