/**
 * Event definition/schedule/history store interfaces plus an in-memory
 * implementation for tests. The Drizzle-backed implementation lives in
 * `./store.drizzle.ts` so importing this module never opens a DB connection.
 */

export interface EventDefinitionRow {
  id: string;
  kind: string;
  title: string;
  draft: unknown;
  published: unknown | null;
  publishedVersion: number;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface EventScheduleRow {
  id: number;
  eventId: string;
  startsAt: Date;
  endsAt: Date;
  exchangeEndsAt: Date;
  enabled: boolean;
}

export interface EventHistoryRow {
  eventId: string;
  version: number;
  published: unknown;
  publishedBy: string | null;
  publishedAt: Date;
}

export interface NewEventDefinition {
  id: string;
  kind: string;
  title: string;
  draft: unknown;
  published: unknown | null;
  publishedVersion: number;
  updatedBy: string | null;
}

export interface NewEventSchedule {
  eventId: string;
  startsAt: Date;
  endsAt: Date;
  exchangeEndsAt: Date;
  enabled: boolean;
}

export interface EventDraftUpdate {
  draft: unknown;
  /** New title; absent leaves the current one. */
  title?: string;
  updatedBy: string | null;
}

/** Prefix of the `server_meta` keys that tombstone a deleted event id. */
export const DELETED_EVENT_PREFIX = 'deleted_event:';

export interface EventStore {
  listDefinitions(): Promise<EventDefinitionRow[]>;
  getDefinition(id: string): Promise<EventDefinitionRow | undefined>;
  /**
   * Delete the definition; the schedule and history rows go with it (FK
   * cascade in SQL, explicit filtering in the memory store).
   */
  deleteDefinition(id: string): Promise<void>;
  /** Record a tombstone so the startup catalog import never re-creates the id. */
  markDeleted(id: string, by: string | null): Promise<void>;
  /** Remove the tombstone (used when the id is deliberately re-created). */
  clearDeleted(id: string): Promise<void>;
  /** Every tombstoned event id. */
  listDeleted(): Promise<Set<string>>;
  /** Replace the stored draft (as-is) and optionally the title; bumps updatedBy/updatedAt. No history row is written. */
  updateDraft(id: string, update: EventDraftUpdate): Promise<void>;
  /** Delete every schedule row of `eventId` and insert `schedule` in one transaction. */
  replaceSchedule(eventId: string, schedule: NewEventSchedule[]): Promise<void>;
  /** Insert a definition and its schedule rows in one transaction. When def.published is non-null, also insert a history row (version = def.publishedVersion, publishedBy = def.updatedBy). */
  createDefinition(def: NewEventDefinition, schedule: NewEventSchedule[]): Promise<void>;
  /**
   * In one transaction: set draft (if given), published, publishedVersion,
   * updatedBy, updatedAt = now on the definition and insert a history row.
   * When `schedule` is given, also replace every schedule row of that event
   * with the given ones; when absent, leave the existing rows untouched.
   */
  publish(id: string, update: { draft?: unknown; published: unknown; publishedVersion: number; updatedBy: string | null; schedule?: NewEventSchedule[] }): Promise<void>;
  listSchedule(): Promise<EventScheduleRow[]>;
  listHistory(eventId: string): Promise<EventHistoryRow[]>;
}

/** In-memory implementation with the same semantics, for tests. */
export function memoryEventStore(): EventStore & { reset(): void } {
  let definitions: EventDefinitionRow[] = [];
  let schedule: EventScheduleRow[] = [];
  let history: EventHistoryRow[] = [];
  const deleted = new Map<string, string>();
  let nextScheduleId = 1;

  const store: EventStore & { reset(): void } = {
    async listDefinitions() {
      return definitions.map((row) => ({ ...row }));
    },
    async getDefinition(id) {
      const row = definitions.find((r) => r.id === id);
      return row ? { ...row } : undefined;
    },
    async deleteDefinition(id) {
      definitions = definitions.filter((row) => row.id !== id);
      schedule = schedule.filter((row) => row.eventId !== id);
      history = history.filter((row) => row.eventId !== id);
    },
    async markDeleted(id, by) {
      deleted.set(id, JSON.stringify({ at: new Date().toISOString(), by }));
    },
    async clearDeleted(id) {
      deleted.delete(id);
    },
    async listDeleted() {
      return new Set(deleted.keys());
    },
    async updateDraft(id, update) {
      const row = definitions.find((r) => r.id === id);
      if (!row) {
        throw new Error(`event definition not found: ${id}`);
      }
      row.draft = update.draft;
      if (update.title !== undefined) row.title = update.title;
      row.updatedBy = update.updatedBy;
      row.updatedAt = new Date();
    },
    async replaceSchedule(eventId, scheduleRows) {
      schedule = schedule.filter((s) => s.eventId !== eventId);
      for (const s of scheduleRows) {
        schedule.push({
          id: nextScheduleId++,
          eventId,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          exchangeEndsAt: s.exchangeEndsAt,
          enabled: s.enabled,
        });
      }
    },
    async createDefinition(def, scheduleRows) {
      if (definitions.some((r) => r.id === def.id)) {
        throw new Error(`event definition already exists: ${def.id}`);
      }
      definitions.push({
        id: def.id,
        kind: def.kind,
        title: def.title,
        draft: def.draft,
        published: def.published,
        publishedVersion: def.publishedVersion,
        updatedBy: def.updatedBy,
        updatedAt: new Date(),
      });
      for (const s of scheduleRows) {
        schedule.push({
          id: nextScheduleId++,
          eventId: s.eventId,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          exchangeEndsAt: s.exchangeEndsAt,
          enabled: s.enabled,
        });
      }
      if (def.published !== null && def.published !== undefined) {
        history.push({
          eventId: def.id,
          version: def.publishedVersion,
          published: def.published,
          publishedBy: def.updatedBy,
          publishedAt: new Date(),
        });
      }
    },
    async publish(id, update) {
      const row = definitions.find((r) => r.id === id);
      if (!row) {
        throw new Error(`event definition not found: ${id}`);
      }
      if (update.draft !== undefined) row.draft = update.draft;
      row.published = update.published;
      row.publishedVersion = update.publishedVersion;
      row.updatedBy = update.updatedBy;
      row.updatedAt = new Date();
      if (update.schedule !== undefined) {
        schedule = schedule.filter((s) => s.eventId !== id);
        for (const s of update.schedule) {
          schedule.push({
            id: nextScheduleId++,
            eventId: s.eventId,
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            exchangeEndsAt: s.exchangeEndsAt,
            enabled: s.enabled,
          });
        }
      }
      history.push({
        eventId: id,
        version: update.publishedVersion,
        published: update.published,
        publishedBy: update.updatedBy,
        publishedAt: new Date(),
      });
    },
    async listSchedule() {
      return schedule.map((row) => ({ ...row }));
    },
    async listHistory(eventId) {
      return history.filter((row) => row.eventId === eventId).map((row) => ({ ...row }));
    },
    reset() {
      definitions = [];
      schedule = [];
      history = [];
      deleted.clear();
      nextScheduleId = 1;
    },
  };
  return store;
}
