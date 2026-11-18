/**
 * NPC roster store interface plus an in-memory implementation for tests. The
 * Drizzle-backed implementation lives in `./store.drizzle.ts` so importing this
 * module never opens a DB connection.
 */
import type { NpcRoster } from '../../live/data/npcRosters.ts';

export interface StoredRoster {
  id: string;
  roster: NpcRoster;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface RosterStore {
  listRosters(): Promise<StoredRoster[]>;
  getRoster(id: string): Promise<StoredRoster | undefined>;
  upsertRoster(id: string, roster: NpcRoster, updatedBy: string | null): Promise<void>;
  /**
   * Insert a new roster. Unlike `upsertRoster`, an id that already exists must
   * fail with a unique violation (SQLSTATE `23505`) so concurrent creates can
   * be mapped to a conflict.
   */
  insertRoster(id: string, roster: NpcRoster, updatedBy: string | null): Promise<void>;
  /** Insert every roster that has no row yet; existing rows are never modified. Returns the number inserted. */
  insertMissing(rosters: Record<string, NpcRoster>, updatedBy: string): Promise<number>;
}

/** In-memory implementation with the same semantics, for tests. */
export function memoryRosterStore(seed?: Record<string, NpcRoster>): RosterStore & { reset(): void } {
  const rows = new Map<string, StoredRoster>();
  const sorted = (): StoredRoster[] =>
    [...rows.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row) => ({ ...row, roster: structuredClone(row.roster) }));

  if (seed) {
    for (const [id, roster] of Object.entries(seed)) {
      rows.set(id, {
        id,
        roster: structuredClone(roster),
        updatedBy: 'seed',
        updatedAt: new Date(0),
      });
    }
  }

  const store: RosterStore & { reset(): void } = {
    async listRosters() {
      return sorted();
    },
    async getRoster(id) {
      const row = rows.get(id);
      return row ? { ...row, roster: structuredClone(row.roster) } : undefined;
    },
    async upsertRoster(id, roster, updatedBy) {
      rows.set(id, {
        id,
        roster: structuredClone(roster),
        updatedBy,
        updatedAt: new Date(),
      });
    },
    async insertRoster(id, roster, updatedBy) {
      if (rows.has(id)) {
        // Same SQLSTATE the Postgres store's insert raises, so route handlers
        // can map memory-store races to 409 as well.
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        });
      }
      rows.set(id, {
        id,
        roster: structuredClone(roster),
        updatedBy,
        updatedAt: new Date(),
      });
    },
    async insertMissing(rosters, updatedBy) {
      let inserted = 0;
      for (const [id, roster] of Object.entries(rosters)) {
        if (rows.has(id)) continue;
        rows.set(id, {
          id,
          roster: structuredClone(roster),
          updatedBy,
          updatedAt: new Date(),
        });
        inserted += 1;
      }
      return inserted;
    },
    reset() {
      rows.clear();
    },
  };
  return store;
}
