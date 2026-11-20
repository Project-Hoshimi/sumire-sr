/**
 * Admin console API for NPC rosters, under `/sumire/admin/rosters`. Roster
 * validation, persistence, cache reload and usage lookup all live in
 * `services/rosters/cache.ts`; these routes only shape bodies and map results.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { listQuestIds } from '../master/index.ts';
import { readJsonBody, requireAdmin, type AdminRouteDeps } from './admin.ts';
import type { NpcRoster } from '../live/data/npcRosters.ts';
import { isUniqueViolation } from '../services/db/uniqueViolation.ts';
import {
  NpcRosterValidationError,
  createNpcRoster,
  duplicateNpcRoster,
  isValidRosterId,
  listRosterRecords,
  rosterRecord,
  rosterUsage,
  saveNpcRoster,
} from '../services/rosters/cache.ts';
import type { StoredRoster } from '../services/rosters/store.ts';
import { ensureTranslationsLoaded, textName } from '../services/translations.ts';

export interface AdminRosterRouteDeps {
  admin: AdminRouteDeps;
  /**
   * The main-story quest ids in the caller's master data. Looked up per request
   * so usage checks never read master data at registration time.
   */
  questIds?: () => Promise<Set<string>>;
}

/** The roster payload the API exposes, without the store wrapper. */
function publicRoster(row: StoredRoster): {
  id: string;
  name: string;
  managerLevel: number;
  cards: NpcRoster['Cards'];
  updatedBy: string | null;
  updatedAt: Date;
} {
  return {
    id: row.id,
    name: row.roster.Name,
    managerLevel: row.roster.ManagerLevel,
    cards: row.roster.Cards,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export const adminRosterRoutes: FastifyPluginAsync<AdminRosterRouteDeps> = async (app, opts) => {
  const viewer = requireAdmin('viewer', opts.admin);
  const editor = requireAdmin('editor', opts.admin);
  const questIds = opts.questIds ?? listQuestIds;

  app.get('/sumire/admin/rosters', { preHandler: viewer }, async () => {
    const ids = await questIds();
    await ensureTranslationsLoaded();
    return listRosterRecords().map((row) => {
      const usage = rosterUsage(row.id, { questExists: (questId) => ids.has(questId) });
      return {
        id: row.id,
        name: row.roster.Name,
        nameEn: textName(row.roster.Name) ?? null,
        managerLevel: row.roster.ManagerLevel,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
        usageCount: usage.quests.length + usage.events.length,
      };
    });
  });

  app.get('/sumire/admin/rosters/:id', { preHandler: viewer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = rosterRecord(id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const ids = await questIds();
    await ensureTranslationsLoaded();
    return {
      ...publicRoster(row),
      nameEn: textName(row.roster.Name) ?? null,
      usage: rosterUsage(id, { questExists: (questId) => ids.has(questId) }),
    };
  });

  app.put('/sumire/admin/rosters/:id', { preHandler: editor }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!rosterRecord(id)) return reply.code(404).send({ error: 'not found' });
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: 'invalid body' });

    const ids = await questIds();
    const usage = rosterUsage(id, { questExists: (questId) => ids.has(questId) });
    const shared = usage.quests.length > 0 || usage.events.length > 1;
    if (shared && body.confirmShared !== true) {
      return reply.code(409).send({ code: 'shared-roster', usage });
    }

    const roster = {
      Name: body.name,
      ManagerLevel: body.managerLevel,
      Cards: body.cards,
    } as NpcRoster;
    try {
      await saveNpcRoster(id, roster, req.adminUser!.id);
    } catch (error) {
      if (error instanceof NpcRosterValidationError) {
        return reply.code(400).send({ errors: error.errors });
      }
      throw error;
    }
    return publicRoster(rosterRecord(id) as StoredRoster);
  });

  app.post('/sumire/admin/rosters', { preHandler: editor }, async (req, reply) => {
    const body = readJsonBody(req.body);
    const id = body?.id;
    if (!body || typeof id !== 'string' || !isValidRosterId(id)) {
      return reply.code(400).send({ error: 'invalid roster id' });
    }
    if (rosterRecord(id)) {
      return reply.code(409).send({ error: 'roster already exists' });
    }

    const roster = {
      Name: body.name,
      ManagerLevel: body.managerLevel,
      Cards: body.cards,
    } as NpcRoster;
    try {
      await createNpcRoster(id, roster, req.adminUser!.id);
    } catch (error) {
      if (error instanceof NpcRosterValidationError) {
        return reply.code(400).send({ errors: error.errors });
      }
      // Another create inserted this id between our check and the insert.
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'roster already exists' });
      }
      throw error;
    }
    return reply.code(201).send(publicRoster(rosterRecord(id) as StoredRoster));
  });

  app.post('/sumire/admin/rosters/:id/duplicate', { preHandler: editor }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = readJsonBody(req.body);
    const newId = body?.newId;
    if (typeof newId !== 'string' || !isValidRosterId(newId)) {
      return reply.code(400).send({ error: 'invalid roster id' });
    }
    if (!rosterRecord(id)) return reply.code(404).send({ error: 'not found' });
    if (rosterRecord(newId)) {
      return reply.code(409).send({ error: 'roster already exists' });
    }
    try {
      await duplicateNpcRoster(id, newId, req.adminUser!.id);
    } catch (error) {
      // Another duplicate created this id between our check and the insert.
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'roster already exists' });
      }
      throw error;
    }
    return reply.code(201).send(publicRoster(rosterRecord(newId) as StoredRoster));
  });
};
