/**
 * Admin console API for event definitions and schedules, under
 * `/sumire/admin/events`. All persistence, validation, publish, preview,
 * rollback and schedule logic lives in `services/events/registry.ts` and the
 * kind plugins; these routes only authenticate, shape bodies and map errors.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { readJsonBody, requireAdmin, type AdminRouteDeps } from './admin.ts';
import type { MarathonPlayerStateReader } from '../services/events/preview.ts';
import {
  EventDefaultDraftUnsupportedError,
  EventDefinitionExistsError,
  EventDefinitionNotFoundError,
  EventLiveError,
  EventPublishConflictError,
  EventPublishImpactError,
  EventPublishStalePreviewError,
  EventPublishValidationError,
  EventReadOnlyFieldError,
  EventScheduleValidationError,
  EventVersionNotFoundError,
  UnknownEventKindError,
  createEventDefinition,
  deleteEvent,
  eventDefinitionDetail,
  eventHistoryVersion,
  importEventFromMaster,
  listEventSummaries,
  previewPublish,
  publishEventDefinition,
  replaceEventSchedule,
  rollbackEventDefinition,
  saveEventDraft,
  validateEventDraft,
  type EventScheduleInputRow,
} from '../services/events/registry.ts';
import { eventPlugin } from '../services/events/plugin.ts';
import type { AdminStore } from '../services/admin/store.ts';
import { isValidAdminId } from '../services/ids.ts';
import { ensureTranslationsLoaded, textName } from '../services/translations.ts';

export interface AdminEventRouteDeps {
  admin: AdminRouteDeps;
  /** Player-state reader used by preview/publish; production defaults to Drizzle. */
  players?: MarathonPlayerStateReader;
}

/** Map a registry service error onto the admin API response; false when unhandled. */
function respondServiceError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof EventDefinitionNotFoundError || error instanceof EventVersionNotFoundError) {
    reply.code(404).send({ error: 'not found' });
    return true;
  }
  if (error instanceof EventPublishValidationError) {
    reply.code(400).send({ errors: error.errors });
    return true;
  }
  if (error instanceof EventScheduleValidationError) {
    reply.code(400).send({ errors: error.errors });
    return true;
  }
  if (error instanceof EventReadOnlyFieldError) {
    reply.code(400).send({ error: 'read-only fields changed', paths: error.paths });
    return true;
  }
  if (error instanceof EventPublishImpactError) {
    reply.code(409).send({ impacts: error.impacts });
    return true;
  }
  if (error instanceof EventPublishStalePreviewError) {
    reply.code(409).send({ error: 'draft changed since preview', code: 'stale-preview' });
    return true;
  }
  if (error instanceof EventDefinitionExistsError) {
    reply.code(409).send({ error: 'event definition already exists' });
    return true;
  }
  if (error instanceof EventPublishConflictError) {
    reply.code(409).send({ error: 'publish conflict, retry' });
    return true;
  }
  if (error instanceof EventLiveError) {
    reply.code(409).send({ error: 'Event is live. Disable its schedule first.' });
    return true;
  }
  if (error instanceof UnknownEventKindError) {
    reply.code(400).send({ error: 'unknown event kind' });
    return true;
  }
  if (error instanceof EventDefaultDraftUnsupportedError) {
    reply.code(400).send({ error: 'event kind cannot create a default draft' });
    return true;
  }
  return false;
}

/** Header-safe download name; ids are admin-authored so keep it conservative. */
function downloadName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

/**
 * Resolve stored admin ids to usernames with one store query. Ids that name no
 * admin user (system values such as `catalog-import` or `system-upgrade`) are
 * absent from the map, so callers keep the stored value and report no name.
 */
async function adminNamesById(
  store: AdminStore,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (unique.length === 0) return new Map();
  const users = await store.listByIds(unique);
  return new Map(users.map((user) => [user.id, user.username]));
}

/** `publishedByName` / `updatedByName` from the resolved map; null for system or empty values. */
function nameFor(names: Map<string, string>, value: string | null): string | null {
  return value === null ? null : (names.get(value) ?? null);
}

export const adminEventRoutes: FastifyPluginAsync<AdminEventRouteDeps> = async (app, opts) => {
  const viewer = requireAdmin('viewer', opts.admin);
  const editor = requireAdmin('editor', opts.admin);
  const publisher = requireAdmin('publisher', opts.admin);

  app.get('/sumire/admin/events', { preHandler: viewer }, async () => {
    const summaries = await listEventSummaries();
    const names = await adminNamesById(
      opts.admin.store,
      summaries.map((row) => row.updatedBy),
    );
    await ensureTranslationsLoaded();
    return summaries.map((row) => ({
      ...row,
      titleEn: textName(row.title) ?? null,
      updatedByName: nameFor(names, row.updatedBy),
    }));
  });

  app.get('/sumire/admin/events/:id', { preHandler: viewer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await eventDefinitionDetail(id);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    const { definition, schedule, history } = detail;
    const names = await adminNamesById(opts.admin.store, [
      definition.updatedBy,
      ...history.map((row) => row.publishedBy),
    ]);
    await ensureTranslationsLoaded();
    return {
      id: definition.id,
      kind: definition.kind,
      title: definition.title,
      titleEn: textName(definition.title) ?? null,
      draft: definition.draft,
      published: definition.published,
      publishedVersion: definition.publishedVersion,
      updatedBy: definition.updatedBy,
      updatedByName: nameFor(names, definition.updatedBy),
      updatedAt: definition.updatedAt,
      schema: eventPlugin(definition.kind)?.schema ?? null,
      schedule,
      history: history.map((row) => ({
        version: row.version,
        publishedBy: row.publishedBy,
        publishedByName: nameFor(names, row.publishedBy),
        publishedAt: row.publishedAt,
      })),
    };
  });

  app.get(
    '/sumire/admin/events/:id/history/:version',
    { preHandler: viewer },
    async (req, reply) => {
      const { id, version: rawVersion } = req.params as { id: string; version: string };
      if (!/^[1-9]\d*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion))) {
        return reply.code(400).send({ error: 'version must be a positive integer' });
      }
      try {
        const row = await eventHistoryVersion(id, Number(rawVersion));
        const names = await adminNamesById(opts.admin.store, [row.publishedBy]);
        return {
          version: row.version,
          published: row.published,
          publishedBy: row.publishedBy,
          publishedByName: nameFor(names, row.publishedBy),
          publishedAt: row.publishedAt,
        };
      } catch (error) {
        if (respondServiceError(reply, error)) return reply;
        throw error;
      }
    },
  );

  app.post('/sumire/admin/events', { preHandler: editor }, async (req, reply) => {
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: 'invalid body' });
    const { id, kind, title, draft } = body;
    if (typeof id !== 'string' || id.trim() === '') {
      return reply.code(400).send({ error: 'id is required' });
    }
    const eventId = id.trim();
    if (!isValidAdminId(eventId)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    if (typeof kind !== 'string' || kind.trim() === '') {
      return reply.code(400).send({ error: 'kind is required' });
    }
    if (typeof title !== 'string') {
      return reply.code(400).send({ error: 'title is required' });
    }
    if (
      draft !== undefined &&
      (draft === null || typeof draft !== 'object' || Array.isArray(draft))
    ) {
      return reply.code(400).send({ error: 'draft must be an object' });
    }
    try {
      const definition = await createEventDefinition({
        id: eventId,
        kind,
        title,
        ...(draft !== undefined ? { draft } : {}),
        by: req.adminUser!.id,
      });
      return reply.code(201).send({
        id: definition.id,
        kind: definition.kind,
        title: definition.title,
        draft: definition.draft,
        publishedVersion: definition.publishedVersion,
      });
    } catch (error) {
      if (respondServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.put('/sumire/admin/events/:id/draft', { preHandler: editor }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: 'invalid body' });
    if (
      body.draft === undefined ||
      body.draft === null ||
      typeof body.draft !== 'object' ||
      Array.isArray(body.draft)
    ) {
      return reply.code(400).send({ error: 'draft must be an object' });
    }
    if (body.title !== undefined && typeof body.title !== 'string') {
      return reply.code(400).send({ error: 'title must be a string' });
    }
    try {
      const validation = await saveEventDraft(id, {
        draft: body.draft,
        ...(body.title !== undefined ? { title: body.title } : {}),
        by: req.adminUser!.id,
      });
      return { saved: true, validation };
    } catch (error) {
      if (respondServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.post('/sumire/admin/events/:id/validate', { preHandler: editor }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = readJsonBody(req.body);
    try {
      return await validateEventDraft(id, body && body.draft !== undefined ? body.draft : undefined);
    } catch (error) {
      if (respondServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.get('/sumire/admin/events/:id/preview', { preHandler: viewer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await previewPublish(id, { players: opts.players });
    } catch (error) {
      if (respondServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.post('/sumire/admin/events/:id/publish', { preHandler: publisher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = readJsonBody(req.body);
    const expectedDraftHash = body?.expectedDraftHash;
    if (expectedDraftHash !== undefined && typeof expectedDraftHash !== 'string') {
      return reply.code(400).send({ error: 'expectedDraftHash must be a string' });
    }
    try {
      // publishEventDefinition reloads the registry itself before resolving.
      return await publishEventDefinition(id, {
        by: req.adminUser!.id,
        players: opts.players,
        ...(expectedDraftHash !== undefined ? { expectedDraftHash } : {}),
      });
    } catch (error) {
      if (respondServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.post('/sumire/admin/events/:id/rollback', { preHandler: publisher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = readJsonBody(req.body);
    const version = body?.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      return reply.code(400).send({ error: 'version must be a positive integer' });
    }
    try {
      return await rollbackEventDefinition(id, version, {
        by: req.adminUser!.id,
        players: opts.players,
      });
    } catch (error) {
      if (respondServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.post('/sumire/admin/events/import-from-master', { preHandler: editor }, async (req, reply) => {
    const body = readJsonBody(req.body);
    if (!body) return reply.code(400).send({ error: 'invalid body' });
    const { kind, eventId } = body;
    if (typeof kind !== 'string' || kind.trim() === '') {
      return reply.code(400).send({ error: 'kind is required' });
    }
    if (typeof eventId !== 'string' || eventId.trim() === '') {
      return reply.code(400).send({ error: 'eventId is required' });
    }
    try {
      const definition = await importEventFromMaster(kind, eventId, { by: req.adminUser!.id });
      return reply.code(201).send({
        id: definition.id,
        kind: definition.kind,
        title: definition.title,
        draft: definition.draft,
        publishedVersion: definition.publishedVersion,
      });
    } catch (error) {
      if (respondServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.get('/sumire/admin/events/:id/export', { preHandler: viewer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { which } = req.query as { which?: string };
    const side = which ?? 'draft';
    if (side !== 'draft' && side !== 'published') {
      return reply.code(400).send({ error: 'which must be draft or published' });
    }
    const detail = await eventDefinitionDetail(id);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    const value = side === 'draft' ? detail.definition.draft : detail.definition.published;
    if (value === null || value === undefined) {
      return reply.code(404).send({ error: 'nothing to export' });
    }
    return reply
      .header('Content-Disposition', `attachment; filename="${downloadName(id)}"`)
      .type('application/json')
      .send(JSON.stringify(value, null, 2));
  });

  app.delete('/sumire/admin/events/:id', { preHandler: publisher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deleteEvent(id, { by: req.adminUser!.id });
      return reply.code(204).send();
    } catch (error) {
      if (respondServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.put('/sumire/admin/events/:id/schedule', { preHandler: publisher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = readJsonBody(req.body);
    const schedules = body?.schedules;
    if (!Array.isArray(schedules)) {
      return reply.code(400).send({ error: 'schedules must be an array' });
    }
    // Non-object entries become empty rows so validation reports their fields.
    const rows = schedules.map((row) =>
      row && typeof row === 'object' && !Array.isArray(row) ? row : {},
    ) as EventScheduleInputRow[];
    try {
      return await replaceEventSchedule(id, rows);
    } catch (error) {
      if (respondServiceError(reply, error)) return reply;
      throw error;
    }
  });
};
