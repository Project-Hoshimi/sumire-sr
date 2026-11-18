import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { npcRostersTable } from '../../db/schema.ts';
import type { NpcRoster } from '../../live/data/npcRosters.ts';
import type { RosterStore, StoredRoster } from './store.ts';

type Database = typeof db;

/** Drizzle-backed roster store; defaults to the shared `db` handle. */
export function drizzleRosterStore(database: Database = db): RosterStore {
  return {
    async listRosters(): Promise<StoredRoster[]> {
      const rows = await database.select().from(npcRostersTable);
      return rows
        .map((row) => ({
          id: row.id,
          roster: { Name: row.name, ManagerLevel: row.managerLevel, Cards: row.cards },
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async getRoster(id): Promise<StoredRoster | undefined> {
      const rows = await database
        .select()
        .from(npcRostersTable)
        .where(eq(npcRostersTable.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        roster: { Name: row.name, ManagerLevel: row.managerLevel, Cards: row.cards },
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      };
    },
    async upsertRoster(id: string, roster: NpcRoster, updatedBy: string | null): Promise<void> {
      await database
        .insert(npcRostersTable)
        .values({
          id,
          name: roster.Name,
          managerLevel: roster.ManagerLevel,
          cards: roster.Cards,
          updatedBy,
        })
        .onConflictDoUpdate({
          target: npcRostersTable.id,
          set: {
            name: roster.Name,
            managerLevel: roster.ManagerLevel,
            cards: roster.Cards,
            updatedBy,
            updatedAt: sql`now()`,
          },
        });
    },
    async insertRoster(id: string, roster: NpcRoster, updatedBy: string | null): Promise<void> {
      // No conflict handling: an existing id raises SQLSTATE 23505, which the
      // routes map to 409.
      await database.insert(npcRostersTable).values({
        id,
        name: roster.Name,
        managerLevel: roster.ManagerLevel,
        cards: roster.Cards,
        updatedBy,
      });
    },
    async insertMissing(rosters: Record<string, NpcRoster>, updatedBy: string): Promise<number> {
      const values = Object.entries(rosters).map(([id, roster]) => ({
        id,
        name: roster.Name,
        managerLevel: roster.ManagerLevel,
        cards: roster.Cards,
        updatedBy,
      }));
      if (values.length === 0) return 0;
      const inserted = await database
        .insert(npcRostersTable)
        .values(values)
        .onConflictDoNothing({ target: npcRostersTable.id })
        .returning({ id: npcRostersTable.id });
      return inserted.length;
    },
  };
}
