import { eq, like } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { sql } from 'drizzle-orm';
import {
  eventDefinitions,
  eventDefinitionHistory,
  eventSchedule,
  serverMeta,
} from '../../db/schema.ts';
import {
  DELETED_EVENT_PREFIX,
  type EventDefinitionRow,
  type EventHistoryRow,
  type EventScheduleRow,
  type EventStore,
  type NewEventDefinition,
  type NewEventSchedule,
} from './store.ts';

type Database = typeof db;

/** Drizzle-backed event store; defaults to the shared `db` handle. */
export function drizzleEventStore(database: Database = db): EventStore {
  return {
    async listDefinitions(): Promise<EventDefinitionRow[]> {
      return database.select().from(eventDefinitions);
    },
    async getDefinition(id): Promise<EventDefinitionRow | undefined> {
      const rows = await database
        .select()
        .from(eventDefinitions)
        .where(eq(eventDefinitions.id, id))
        .limit(1);
      return rows[0];
    },
    async deleteDefinition(id): Promise<void> {
      // event_schedule and event_definition_history cascade from the FK.
      await database.delete(eventDefinitions).where(eq(eventDefinitions.id, id));
    },
    async markDeleted(id, by): Promise<void> {
      const value = JSON.stringify({ at: new Date().toISOString(), by });
      await database
        .insert(serverMeta)
        .values({ key: `${DELETED_EVENT_PREFIX}${id}`, value })
        .onConflictDoUpdate({
          target: serverMeta.key,
          set: { value, updatedAt: sql`now()` },
        });
    },
    async clearDeleted(id): Promise<void> {
      await database
        .delete(serverMeta)
        .where(eq(serverMeta.key, `${DELETED_EVENT_PREFIX}${id}`));
    },
    async listDeleted(): Promise<Set<string>> {
      const rows = await database
        .select({ key: serverMeta.key })
        .from(serverMeta)
        // '_' is a LIKE wildcard; the startsWith filter below keeps only exact-prefix keys.
        .where(like(serverMeta.key, `${DELETED_EVENT_PREFIX}%`));
      return new Set(
        rows
          .filter((row) => row.key.startsWith(DELETED_EVENT_PREFIX))
          .map((row) => row.key.slice(DELETED_EVENT_PREFIX.length)),
      );
    },
    async updateDraft(id, update): Promise<void> {
      await database
        .update(eventDefinitions)
        .set({
          draft: update.draft,
          ...(update.title !== undefined ? { title: update.title } : {}),
          updatedBy: update.updatedBy,
          updatedAt: sql`now()`,
        })
        .where(eq(eventDefinitions.id, id));
    },
    async replaceSchedule(eventId, schedule): Promise<void> {
      await database.transaction(async (tx) => {
        await tx.delete(eventSchedule).where(eq(eventSchedule.eventId, eventId));
        if (schedule.length > 0) {
          await tx.insert(eventSchedule).values(schedule);
        }
      });
    },
    async createDefinition(def: NewEventDefinition, schedule: NewEventSchedule[]): Promise<void> {
      await database.transaction(async (tx) => {
        await tx.insert(eventDefinitions).values({
          id: def.id,
          kind: def.kind,
          title: def.title,
          draft: def.draft,
          published: def.published,
          publishedVersion: def.publishedVersion,
          updatedBy: def.updatedBy,
        });
        if (schedule.length > 0) {
          await tx.insert(eventSchedule).values(schedule);
        }
        if (def.published !== null && def.published !== undefined) {
          await tx.insert(eventDefinitionHistory).values({
            eventId: def.id,
            version: def.publishedVersion,
            published: def.published,
            publishedBy: def.updatedBy,
          });
        }
      });
    },
    async publish(
      id: string,
      update: {
        draft?: unknown;
        published: unknown;
        publishedVersion: number;
        updatedBy: string | null;
        schedule?: NewEventSchedule[];
      },
    ): Promise<void> {
      await database.transaction(async (tx) => {
        await tx
          .update(eventDefinitions)
          .set({
            ...(update.draft !== undefined ? { draft: update.draft } : {}),
            published: update.published,
            publishedVersion: update.publishedVersion,
            updatedBy: update.updatedBy,
            updatedAt: sql`now()`,
          })
          .where(eq(eventDefinitions.id, id));
        await tx.insert(eventDefinitionHistory).values({
          eventId: id,
          version: update.publishedVersion,
          published: update.published,
          publishedBy: update.updatedBy,
        });
        if (update.schedule !== undefined) {
          await tx.delete(eventSchedule).where(eq(eventSchedule.eventId, id));
          if (update.schedule.length > 0) {
            await tx.insert(eventSchedule).values(update.schedule);
          }
        }
      });
    },
    async listSchedule(): Promise<EventScheduleRow[]> {
      return database.select().from(eventSchedule);
    },
    async listHistory(eventId): Promise<EventHistoryRow[]> {
      return database
        .select({
          eventId: eventDefinitionHistory.eventId,
          version: eventDefinitionHistory.version,
          published: eventDefinitionHistory.published,
          publishedBy: eventDefinitionHistory.publishedBy,
          publishedAt: eventDefinitionHistory.publishedAt,
        })
        .from(eventDefinitionHistory)
        .where(eq(eventDefinitionHistory.eventId, eventId));
    },
  };
}
