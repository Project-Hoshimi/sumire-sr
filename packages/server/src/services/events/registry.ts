/**
 * In-process event registry.
 *
 * The registry owns the DB-backed event definitions: it imports catalog drafts
 * on startup, compiles published definitions through their kind's plugin, and
 * answers the runtime lookups the services use ("which events are open now",
 * "the compiled config of event X"). It is deliberately independent of the
 * marathon catalog files, and the Drizzle store is loaded lazily so importing
 * this module never opens a DB connection.
 */
import { eventPlugin, type EventPlugin, type ValidationIssue } from './plugin.ts';
import { isUniqueViolation } from '../db/uniqueViolation.ts';
import { draftHash } from './canonicalJson.ts';
import {
  affectedPlayerCount,
  changedDraftKeys,
  drizzleMarathonPlayerStateReader,
  jsonEqual,
  type MarathonPlayerStateReader,
  type PreviewImpact,
  type PublishPreview,
} from './preview.ts';
import type {
  EventDefinitionRow,
  EventHistoryRow,
  EventScheduleRow,
  EventStore,
  NewEventSchedule,
} from './store.ts';
// Side-effect import: registers the marathon plugin with the event plugin registry.
import '../marathon/plugin.ts';
// Side-effect import: registers the moshikoi plugin (permanent, no schedule).
import '../moshikoi/plugin.ts';

/** A compiled event plus its authored kind. */
interface CompiledEvent {
  kind: string;
  runtime: unknown;
  /** The published version the runtime was compiled from. */
  publishedVersion: number;
}

/** Event window in epoch milliseconds; same meaning as `MarathonWindow`. */
export interface EventWindow {
  startTime: number;
  endTime: number;
  exchangeEndTime: number;
}

/**
 * Admin-facing read shapes. They carry raw store rows; the route layer picks
 * the fields it exposes and lets Fastify serialise `Date` values.
 */
export interface EventSummary {
  id: string;
  kind: string;
  title: string;
  publishedVersion: number;
  updatedBy: string | null;
  updatedAt: Date;
  draftDiffersFromPublished: boolean;
  schedule: EventScheduleRow[];
}

export interface EventDetail {
  definition: EventDefinitionRow;
  schedule: EventScheduleRow[];
  history: EventHistoryRow[];
}

/** Result of validating a draft through its kind's plugin. */
export interface DraftValidation {
  ok: boolean;
  errors: ValidationIssue[];
}

/** One authored schedule window submitted by the admin API. */
export interface EventScheduleInputRow {
  startsAt: unknown;
  endsAt: unknown;
  exchangeEndsAt: unknown;
  enabled?: unknown;
}

/** Unknown definition id; routes map this to 404. */
export class EventDefinitionNotFoundError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`event definition not found: ${eventId}`);
    this.name = 'EventDefinitionNotFoundError';
    this.eventId = eventId;
  }
}

/** The event has a schedule window covering now; routes map this to 409. */
export class EventLiveError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super('Event is live. Disable its schedule first.');
    this.name = 'EventLiveError';
    this.eventId = eventId;
  }
}

/** No plugin is registered for the definition's (or requested) kind. */
export class UnknownEventKindError extends Error {
  readonly eventId: string;
  readonly kind: string;

  constructor(eventId: string, kind: string) {
    super(`event ${eventId}: unknown event kind ${kind}`);
    this.name = 'UnknownEventKindError';
    this.eventId = eventId;
    this.kind = kind;
  }
}

/** A definition with this id already exists. */
export class EventDefinitionExistsError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`event definition already exists: ${eventId}`);
    this.name = 'EventDefinitionExistsError';
    this.eventId = eventId;
  }
}

/** A create request omitted `draft` but the kind's plugin has no default draft. */
export class EventDefaultDraftUnsupportedError extends Error {
  readonly eventId: string;
  readonly kind: string;

  constructor(eventId: string, kind: string) {
    super(`event ${eventId}: kind ${kind} cannot create a default draft`);
    this.name = 'EventDefaultDraftUnsupportedError';
    this.eventId = eventId;
    this.kind = kind;
  }
}

/** A concurrent publish claimed the same version; routes map this to 409. */
export class EventPublishConflictError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`event ${eventId}: publish conflict, retry`);
    this.name = 'EventPublishConflictError';
    this.eventId = eventId;
  }
}

/** No history row with this version exists for the event. */
export class EventVersionNotFoundError extends Error {
  readonly eventId: string;
  readonly version: number;

  constructor(eventId: string, version: number) {
    super(`event ${eventId}: no published version ${version}`);
    this.name = 'EventVersionNotFoundError';
    this.eventId = eventId;
    this.version = version;
  }
}

/** The draft has error-severity validation issues; routes map this to 400. */
export class EventPublishValidationError extends Error {
  readonly eventId: string;
  readonly errors: ValidationIssue[];

  constructor(eventId: string, errors: ValidationIssue[]) {
    super(
      `event ${eventId} has validation errors: ${errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
    this.name = 'EventPublishValidationError';
    this.eventId = eventId;
    this.errors = errors;
  }
}

/** A `block` impact refuses the publish; routes map this to 409. */
export class EventPublishImpactError extends Error {
  readonly eventId: string;
  readonly impacts: PreviewImpact[];

  constructor(eventId: string, impacts: PreviewImpact[]) {
    super(
      `event ${eventId} publish blocked by player-state impacts: ${impacts.map(describeImpact).join('; ')}`,
    );
    this.name = 'EventPublishImpactError';
    this.eventId = eventId;
    this.impacts = impacts;
  }
}

/**
 * The draft changed after the preview the caller confirmed. Routes map this to
 * 409 `{error: 'draft changed since preview', code: 'stale-preview'}`.
 */
export class EventPublishStalePreviewError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`event ${eventId}: draft changed since preview`);
    this.name = 'EventPublishStalePreviewError';
    this.eventId = eventId;
  }
}

/** A read-only schema field changed in a draft save; routes map this to 400. */
export class EventReadOnlyFieldError extends Error {
  readonly eventId: string;
  readonly paths: string[];

  constructor(eventId: string, paths: string[]) {
    super(`event ${eventId}: read-only fields changed: ${paths.join(', ')}`);
    this.name = 'EventReadOnlyFieldError';
    this.eventId = eventId;
    this.paths = paths;
  }
}

/** One or more submitted schedule windows are malformed; routes map this to 400. */
export class EventScheduleValidationError extends Error {
  readonly eventId: string;
  readonly errors: string[];

  constructor(eventId: string, errors: string[]) {
    super(`event ${eventId}: invalid schedule: ${errors.join('; ')}`);
    this.name = 'EventScheduleValidationError';
    this.eventId = eventId;
    this.errors = errors;
  }
}

/** Human-readable target of one preview impact, used in error messages. */
function describeImpact(impact: PreviewImpact): string {
  const target =
    impact.itemKey !== undefined
      ? `box "${impact.boxId}" item "${impact.itemKey}"`
      : impact.boxId !== undefined
        ? `box "${impact.boxId}"`
        : impact.questId ?? impact.code;
  const players = impact.affectedPlayers ?? 0;
  return `${impact.code} (${target}, ${players} affected player${players === 1 ? '' : 's'}): ${impact.message}`;
}

let store: EventStore | undefined;
let loaded = false;
let compiled = new Map<string, CompiledEvent>();
let scheduleRows: EventScheduleRow[] = [];
/**
 * Monotonic counter bumped on every successful reload; consumers that cache a
 * projection of the registry (e.g. the client-state fingerprint) key it on this.
 */
let revision = 0;
/** Tail of the serialized reload queue; resolved once nothing is pending. */
let reloadChain: Promise<void> = Promise.resolve();

/** The store the registry reads through; undefined until `initEventRegistry`. */
function requireStore(): EventStore {
  if (!store) throw new Error('event registry: store is not initialized');
  return store;
}

/** One enabled schedule row from an authored draft, or no rows when absent. */
function scheduleFromDraft(eventId: string, input: { startsAt: string; endsAt: string; exchangeEndsAt: string } | undefined): NewEventSchedule[] {
  if (!input) return [];
  return [
    {
      eventId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      exchangeEndsAt: new Date(input.exchangeEndsAt),
      enabled: true,
    },
  ];
}

/**
 * Run each plugin's optional `upgradeDraft` over the stored draft and published
 * JSON of its definitions, so rows written before a schema change pick up the
 * migration on the next boot. A new version is written only when the *published*
 * payload changes: a draft-only change is left alone because `parseDraft` fills
 * the same defaults at read time anyway. Otherwise nothing is written, which
 * keeps this idempotent across restarts, and no schedule is passed, so existing
 * schedules survive.
 *
 * Each definition is upgraded on its own: a failure is warned about and skipped,
 * so one bad row can never reject `initEventRegistry`.
 */
async function upgradeStoredDrafts(activeStore: EventStore): Promise<void> {
  const deleted = await activeStore.listDeleted();
  for (const definition of await activeStore.listDefinitions()) {
    if (deleted.has(definition.id)) continue;
    try {
      const plugin = eventPlugin(definition.kind);
      if (!plugin?.upgradeDraft) continue;
      // Nothing is published, so there is no live payload to upgrade.
      if (definition.published === null || definition.published === undefined) continue;
      const draft = plugin.upgradeDraft(definition.draft) ?? definition.draft;
      const published = plugin.upgradeDraft(definition.published) ?? definition.published;
      if (published === definition.published) continue;
      const publishedVersion = definition.publishedVersion + 1;
      await activeStore.publish(definition.id, {
        // Persist the upgraded draft only when the upgrade changed it too.
        ...(draft !== definition.draft ? { draft } : {}),
        published,
        publishedVersion,
        updatedBy: 'system-upgrade',
      });
      console.info(
        `[events] upgraded ${definition.kind} definition ${definition.id} to version ${publishedVersion}`,
      );
    } catch (error) {
      console.warn(
        `[events] failed to upgrade definition ${definition.id}: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * Import the given catalog drafts into the store, skipping any whose id already
 * has a definition (existing definitions are never modified), then reload.
 */
export async function initEventRegistry(
  opts: { store?: EventStore; drafts?: { kind: string; draft: unknown }[] } = {},
): Promise<{ imported: string[] }> {
  if (opts.store) {
    store = opts.store;
  } else {
    const { drizzleEventStore } = await import('./store.drizzle.ts');
    store = drizzleEventStore();
  }
  const activeStore = store;
  const imported: string[] = [];
  const deleted = await activeStore.listDeleted();

  for (const { kind, draft } of opts.drafts ?? []) {
    const plugin = eventPlugin(kind);
    if (!plugin) {
      console.warn(`[events] cannot import draft: unknown event kind ${kind}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = plugin.parseDraft(draft);
    } catch (error) {
      console.warn(`[events] cannot import ${kind} draft: ${(error as Error).message}`);
      continue;
    }

    const id = plugin.draftId(parsed);
    if (!id) {
      console.warn(`[events] cannot import ${kind} draft: no event id`);
      continue;
    }

    const existing = await activeStore.getDefinition(id);
    if (existing) continue;
    // A deleted event stays deleted even though its catalog source still exists.
    if (deleted.has(id)) continue;

    const errors = plugin.validate(parsed).filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      for (const issue of errors) {
        console.warn(`[events] cannot import ${kind} draft ${id}: ${issue.path}: ${issue.message}`);
      }
      continue;
    }

    await activeStore.createDefinition(
      {
        id,
        kind,
        title: plugin.draftTitle(parsed),
        draft: parsed,
        published: parsed,
        publishedVersion: 1,
        updatedBy: 'catalog-import',
      },
      scheduleFromDraft(id, plugin.draftSchedule(parsed)),
    );
    imported.push(id);
  }

  await upgradeStoredDrafts(activeStore);
  await reloadEventRegistry();
  return { imported };
}

/**
 * Recompile every published definition and replace the in-process state.
 * Definitions that fail to parse or compile are warned about and skipped.
 *
 * Calls are serialized: each one waits for the previous reload to finish before
 * doing its own full read and swap, so two overlapping reloads can never leave
 * the registry on a stale snapshot. A failed reload rejects only its own
 * caller's promise; later reloads still run.
 */
export function reloadEventRegistry(): Promise<void> {
  const run = reloadChain.then(() => doReloadEventRegistry());
  reloadChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function doReloadEventRegistry(): Promise<void> {
  const activeStore = requireStore();
  const definitions = await activeStore.listDefinitions();
  const schedule = await activeStore.listSchedule();

  const next = new Map<string, CompiledEvent>();
  for (const definition of definitions) {
    if (definition.published === null || definition.published === undefined) continue;
    const plugin = eventPlugin(definition.kind);
    if (!plugin) {
      console.warn(`[events] ${definition.id}: unknown event kind ${definition.kind}`);
      continue;
    }
    try {
      const runtime = plugin.compile(plugin.parseDraft(definition.published));
      next.set(definition.id, {
        kind: definition.kind,
        runtime,
        publishedVersion: definition.publishedVersion,
      });
    } catch (error) {
      console.warn(`[events] ${definition.id}: ${(error as Error).message}`);
    }
  }

  compiled = next;
  scheduleRows = schedule;
  revision += 1;
  loaded = true;
}

/** Current registry revision: changes once per successful reload. */
export function eventRegistryRevision(): number {
  return revision;
}

/** One schedule row as exposed in the client-state projection. */
export interface ClientStateSchedule {
  startsAt: number;
  endsAt: number;
  exchangeEndsAt: number;
  enabled: boolean;
}

/**
 * One published event as the client can see it today: identity, published
 * version, enabled/disabled schedule windows. Drafts are deliberately absent —
 * an unpublished edit is invisible to the client. Sorted by id.
 */
export interface ClientStateEvent {
  id: string;
  kind: string;
  publishedVersion: number;
  schedule: ClientStateSchedule[];
}

/**
 * The static part of the client-state projection (no time-dependent phase).
 * Rebuilt on every call from the loaded registry; callers that need it per
 * request should cache it against `eventRegistryRevision()`.
 */
export function clientStateEvents(): ClientStateEvent[] {
  return [...compiled.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, event]) => ({
      id,
      kind: event.kind,
      publishedVersion: event.publishedVersion,
      schedule: scheduleRows
        .filter((row) => row.eventId === id)
        .map((row) => ({
          startsAt: row.startsAt.getTime(),
          endsAt: row.endsAt.getTime(),
          exchangeEndsAt: row.exchangeEndsAt.getTime(),
          enabled: row.enabled,
        }))
        .sort(
          (a, b) =>
            a.startsAt - b.startsAt ||
            a.endsAt - b.endsAt ||
            a.exchangeEndsAt - b.exchangeEndsAt ||
            Number(a.enabled) - Number(b.enabled),
        ),
    }));
}

/** True once a reload has completed at least once. */
export function registryLoaded(): boolean {
  return loaded;
}

/** The compiled runtime of event `id`, when it exists and is of `kind`. */
export function compiledEvent<T>(kind: string, id: string): T | undefined {
  const event = compiled.get(id);
  if (!event || event.kind !== kind) return undefined;
  return event.runtime as T;
}

/** Every compiled event with its authored kind and runtime, ordered by id. */
export function compiledEvents(): { id: string; kind: string; runtime: unknown }[] {
  return [...compiled.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, event]) => ({ id, kind: event.kind, runtime: event.runtime }));
}

/**
 * The enabled schedule window of compiled event `id` covering `now`: the
 * earliest-starting row with `startsAt <= now < exchangeEndsAt`.
 */
export function eventWindowAt(kind: string, id: string, now: number): EventWindow | undefined {
  if (!compiledEvent(kind, id)) return undefined;
  let best: EventWindow | undefined;
  let bestStart = Number.POSITIVE_INFINITY;
  for (const row of scheduleRows) {
    if (!row.enabled || row.eventId !== id) continue;
    const start = row.startsAt.getTime();
    const exchangeEnd = row.exchangeEndsAt.getTime();
    if (!(start <= now && now < exchangeEnd)) continue;
    if (start < bestStart) {
      bestStart = start;
      best = {
        startTime: start,
        endTime: row.endsAt.getTime(),
        exchangeEndTime: exchangeEnd,
      };
    }
  }
  return best;
}

/** Every compiled event of `kind` that has a window at `now`, ordered by start then id. */
export function openEvents<T>(
  kind: string,
  now: number,
): { id: string; runtime: T; window: EventWindow }[] {
  const result: { id: string; runtime: T; window: EventWindow }[] = [];
  for (const [id, event] of compiled) {
    if (event.kind !== kind) continue;
    const window = eventWindowAt(kind, id, now);
    if (!window) continue;
    result.push({ id, runtime: event.runtime as T, window });
  }
  result.sort((a, b) => a.window.startTime - b.window.startTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return result;
}

/**
 * Parse a stored or submitted draft through the plugin. A parse failure means
 * the saved draft is malformed, so report it as an ordinary validation error
 * (routes map `EventPublishValidationError` to 400) instead of letting the
 * plugin's plain `Error` surface as a 500.
 */
function parseDraftOrThrow(eventId: string, plugin: EventPlugin, raw: unknown): unknown {
  try {
    return plugin.parseDraft(raw);
  } catch (error) {
    throw new EventPublishValidationError(eventId, [
      { path: 'draft', message: (error as Error).message, severity: 'error' },
    ]);
  }
}

export interface PreviewPublishOptions {
  /** Candidate draft; defaults to the stored draft. */
  draft?: unknown;
  players?: MarathonPlayerStateReader;
}

/**
 * Preview a publish without writing anything: diff the published draft against
 * the candidate, derive the plugin's player-state impacts, and count affected
 * players through the reader. Impacts that do not need a player check carry no
 * `affectedPlayers`; only a `block` impact with at least one affected player
 * makes the preview `blocking`.
 */
export async function previewPublish(
  id: string,
  opts: PreviewPublishOptions = {},
): Promise<PublishPreview> {
  const activeStore = requireStore();
  const definition = await activeStore.getDefinition(id);
  if (!definition) throw new EventDefinitionNotFoundError(id);
  const plugin = eventPlugin(definition.kind);
  if (!plugin) throw new UnknownEventKindError(id, definition.kind);

  const published =
    definition.published === null || definition.published === undefined
      ? undefined
      : parseDraftOrThrow(id, plugin, definition.published);
  // The key-missing check needs the authored payload before `parseDraft` fills
  // default itemKeys, so pass the same raw draft through to the plugin.
  const rawDraft = opts.draft ?? definition.draft;
  const draft = parseDraftOrThrow(id, plugin, rawDraft);
  const rawImpacts = plugin.stateImpact(published, draft, rawDraft);

  const needsPlayers = rawImpacts.some((impact) => impact.requiresPlayerCheck);
  const states = needsPlayers
    ? await (opts.players ?? drizzleMarathonPlayerStateReader()).listStates(id)
    : [];
  const impacts: PreviewImpact[] = rawImpacts.map((impact) =>
    impact.requiresPlayerCheck
      ? { ...impact, affectedPlayers: affectedPlayerCount(impact, states) }
      : { ...impact },
  );

  return {
    eventId: id,
    fromVersion: definition.publishedVersion,
    draftHash: draftHash(rawDraft),
    changedKeys: changedDraftKeys(
      published as Record<string, unknown> | undefined,
      draft as Record<string, unknown>,
    ),
    impacts,
    blocking: impacts.some(blocksPublish),
  };
}

/** A `block` impact refuses the publish: unconditionally when no player check applies, otherwise only when it touches a player. */
export function blocksPublish(impact: PreviewImpact): boolean {
  return (
    impact.severity === 'block' &&
    (!impact.requiresPlayerCheck || (impact.affectedPlayers ?? 0) > 0)
  );
}

/**
 * Publish a definition: validate and compile the draft, bump the version
 * through the store, then reload the registry so the change applies live.
 */
export async function publishEventDefinition(
  id: string,
  opts: {
    by?: string | null;
    draft?: unknown;
    players?: MarathonPlayerStateReader;
    /**
     * Hash of the draft the caller previewed. When set, publishing is refused
     * if the draft being published hashes differently.
     */
    expectedDraftHash?: string;
  } = {},
): Promise<{ version: number; warnings: ValidationIssue[] }> {
  const activeStore = requireStore();
  const definition = await activeStore.getDefinition(id);
  if (!definition) throw new EventDefinitionNotFoundError(id);
  const plugin = eventPlugin(definition.kind);
  if (!plugin) throw new UnknownEventKindError(id, definition.kind);

  const rawDraft = opts.draft ?? definition.draft;
  const draft = parseDraftOrThrow(id, plugin, rawDraft);
  const issues = plugin.validate(draft);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) throw new EventPublishValidationError(id, errors);
  plugin.compile(draft);

  // Pass the authored payload, not the parsed draft: the key-missing check must
  // see itemKeys before `parseDraft` fills them.
  const preview = await previewPublish(id, { draft: rawDraft, players: opts.players });
  if (preview.blocking) {
    throw new EventPublishImpactError(id, preview.impacts.filter(blocksPublish));
  }

  // Checked immediately before publishing: the stores' publish transaction
  // (Drizzle) starts inside `activeStore.publish`, but the draft read above is
  // not part of it, so a concurrent draft save can still slip in between. The
  // check narrows that window; it is not a lock.
  if (
    opts.expectedDraftHash !== undefined &&
    opts.expectedDraftHash !== draftHash(rawDraft)
  ) {
    throw new EventPublishStalePreviewError(id);
  }

  const version = definition.publishedVersion + 1;
  const schedule = plugin.draftSchedule(draft);
  try {
    await activeStore.publish(id, {
      draft: opts.draft,
      published: draft,
      publishedVersion: version,
      updatedBy: opts.by ?? null,
      // A draft without a schedule leaves any existing schedule rows untouched.
      ...(schedule ? { schedule: scheduleFromDraft(id, schedule) } : {}),
    });
  } catch (error) {
    // Another publish inserted this version between our read and write.
    if (isUniqueViolation(error)) throw new EventPublishConflictError(id);
    throw error;
  }
  await reloadEventRegistry();
  return { version, warnings: issues.filter((issue) => issue.severity === 'warning') };
}

/** ISO-8601 instant in UTC, e.g. `2026-01-01T00:00:00Z` (optionally with millis). */
const ISO_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isoInstant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_UTC_INSTANT.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Load a definition or throw the not-found error routes map to 404. */
async function requireDefinition(id: string): Promise<EventDefinitionRow> {
  const definition = await requireStore().getDefinition(id);
  if (!definition) throw new EventDefinitionNotFoundError(id);
  return definition;
}

/** The kind plugin of a definition, or the unknown-kind error routes map to 400/409. */
function requirePlugin(definition: EventDefinitionRow): EventPlugin {
  const plugin = eventPlugin(definition.kind);
  if (!plugin) throw new UnknownEventKindError(definition.id, definition.kind);
  return plugin;
}

/**
 * Validate a raw draft through its plugin. A parse failure becomes a single
 * `draft` error so malformed-but-saved drafts still produce a report.
 */
function validationOf(plugin: EventPlugin, rawDraft: unknown): DraftValidation {
  let issues: ValidationIssue[];
  try {
    issues = plugin.validate(plugin.parseDraft(rawDraft));
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: 'draft', message: (error as Error).message, severity: 'error' }],
    };
  }
  const errors = issues.filter((issue) => issue.severity === 'error');
  return { ok: errors.length === 0, errors };
}

/** The schedule rows of one event, ordered by start then id. */
function scheduleFor(rows: EventScheduleRow[], eventId: string): EventScheduleRow[] {
  return rows
    .filter((row) => row.eventId === eventId)
    .map((row) => ({ ...row }))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
}

/**
 * Every stored event definition id, sorted ascending. Recomputed on every call
 * (definitions change at runtime), unlike the cached master-data lookups.
 */
export async function listEventDefinitionIds(): Promise<string[]> {
  const definitions = await requireStore().listDefinitions();
  return definitions
    .map((definition) => definition.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Every definition with the fields the admin list screen needs, ordered by id. */
export async function listEventSummaries(): Promise<EventSummary[]> {
  const activeStore = requireStore();
  const [definitions, schedule] = await Promise.all([
    activeStore.listDefinitions(),
    activeStore.listSchedule(),
  ]);
  return definitions
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((definition) => ({
      id: definition.id,
      kind: definition.kind,
      title: definition.title,
      publishedVersion: definition.publishedVersion,
      updatedBy: definition.updatedBy,
      updatedAt: definition.updatedAt,
      draftDiffersFromPublished: !jsonEqual(definition.draft, definition.published),
      schedule: scheduleFor(schedule, definition.id),
    }));
}

/** One definition with its schedule and publish history, or undefined when unknown. */
export async function eventDefinitionDetail(id: string): Promise<EventDetail | undefined> {
  const activeStore = requireStore();
  const definition = await activeStore.getDefinition(id);
  if (!definition) return undefined;
  const [schedule, history] = await Promise.all([
    activeStore.listSchedule(),
    activeStore.listHistory(id),
  ]);
  return {
    definition,
    schedule: scheduleFor(schedule, id),
    history: history
      .map((row) => ({ ...row }))
      .sort((a, b) => a.version - b.version),
  };
}

/** One stored history payload by version; unknown definitions/versions throw not-found errors. */
export async function eventHistoryVersion(
  id: string,
  version: number,
): Promise<EventHistoryRow> {
  const activeStore = requireStore();
  await requireDefinition(id);
  const entry = (await activeStore.listHistory(id)).find((row) => row.version === version);
  if (!entry) throw new EventVersionNotFoundError(id, version);
  return { ...entry };
}

/** Validate the stored draft (or an explicit candidate) through its plugin. */
export async function validateEventDraft(id: string, draft?: unknown): Promise<DraftValidation> {
  const definition = await requireDefinition(id);
  const plugin = requirePlugin(definition);
  return validationOf(plugin, draft === undefined ? definition.draft : draft);
}

/** Read an own-property path from a JSON value; `undefined` when any segment is missing. */
function readJsonPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    if (!Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * The read-only schema paths whose stored value exists and would change.
 * Creating, importing from master and rolling back set initial/historical
 * values directly, so only the draft-save path enforces this.
 */
function changedReadOnlyPaths(
  plugin: EventPlugin,
  storedDraft: unknown,
  nextDraft: unknown,
): string[] {
  const paths: string[] = [];
  for (const field of plugin.schema.fields) {
    if (field.readOnly !== true) continue;
    const stored = readJsonPath(storedDraft, field.path);
    if (stored === undefined) continue;
    if (!jsonEqual(stored, readJsonPath(nextDraft, field.path))) paths.push(field.path);
  }
  return paths;
}

/**
 * Save a draft as-is (invalid drafts are allowed while editing) and report the
 * plugin's validation of what was saved.
 */
export async function saveEventDraft(
  id: string,
  update: { draft: unknown; title?: string; by?: string | null },
): Promise<DraftValidation> {
  const activeStore = requireStore();
  const definition = await requireDefinition(id);
  const plugin = requirePlugin(definition);
  const changedReadOnly = changedReadOnlyPaths(plugin, definition.draft, update.draft);
  if (changedReadOnly.length > 0) throw new EventReadOnlyFieldError(id, changedReadOnly);
  await activeStore.updateDraft(id, {
    draft: update.draft,
    ...(update.title !== undefined ? { title: update.title } : {}),
    updatedBy: update.by ?? null,
  });
  return validationOf(plugin, update.draft);
}

/** Create a new unpublished definition with only a draft. */
export async function createEventDefinition(input: {
  id: string;
  kind: string;
  title: string;
  /** Omitted means the kind's plugin supplies its default draft. */
  draft?: unknown;
  by?: string | null;
}): Promise<EventDefinitionRow> {
  const plugin = eventPlugin(input.kind);
  if (!plugin) throw new UnknownEventKindError(input.id, input.kind);
  let draft = input.draft;
  if (draft === undefined) {
    if (plugin.defaultDraft === undefined) {
      throw new EventDefaultDraftUnsupportedError(input.id, input.kind);
    }
    draft = plugin.parseDraft(plugin.defaultDraft(input.id, input.title));
  }
  const activeStore = requireStore();
  if (await activeStore.getDefinition(input.id)) throw new EventDefinitionExistsError(input.id);
  try {
    await activeStore.createDefinition(
      {
        id: input.id,
        kind: input.kind,
        title: input.title,
        draft,
        published: null,
        publishedVersion: 0,
        updatedBy: input.by ?? null,
      },
      [],
    );
  } catch (error) {
    // Lost a create race after the pre-check; the unique key still protects us.
    if (isUniqueViolation(error)) throw new EventDefinitionExistsError(input.id);
    throw error;
  }
  // Deliberately re-creating a deleted id makes it eligible for catalog import again.
  await activeStore.clearDeleted(input.id);
  return requireDefinition(input.id);
}

/** Build a draft from the master catalog and create it as an unpublished definition. */
export async function importEventFromMaster(
  kind: string,
  eventId: string,
  opts: { by?: string | null } = {},
): Promise<EventDefinitionRow> {
  const plugin = eventPlugin(kind);
  if (!plugin) throw new UnknownEventKindError(eventId, kind);
  const draft = plugin.parseDraft(await plugin.importFromMaster(eventId));
  const id = plugin.draftId(draft);
  const activeStore = requireStore();
  if (await activeStore.getDefinition(id)) throw new EventDefinitionExistsError(id);
  try {
    await activeStore.createDefinition(
      {
        id,
        kind,
        title: plugin.draftTitle(draft),
        draft,
        published: null,
        publishedVersion: 0,
        updatedBy: opts.by ?? null,
      },
      [],
    );
  } catch (error) {
    // Lost a create race after the pre-check; the unique key still protects us.
    if (isUniqueViolation(error)) throw new EventDefinitionExistsError(id);
    throw error;
  }
  await activeStore.clearDeleted(id);
  return requireDefinition(id);
}

/**
 * Delete a definition, its schedule and its history, and tombstone the id so a
 * catalog draft with the same id cannot bring it back on the next startup.
 * Player progress and rosters are deliberately untouched.
 */
export async function deleteEvent(
  id: string,
  opts: { by?: string | null; now?: number } = {},
): Promise<void> {
  const activeStore = requireStore();
  const definition = await requireDefinition(id);
  const now = opts.now ?? Date.now();
  if (eventWindowAt(definition.kind, id, now)) {
    throw new EventLiveError(id);
  }
  const by = opts.by ?? null;
  // Tombstone first: if the delete then fails, a tombstone next to a live
  // definition is harmless, but a delete without a tombstone would let the
  // startup catalog import re-create the event.
  await activeStore.markDeleted(id, by);
  try {
    await activeStore.deleteDefinition(id);
  } catch (err) {
    await activeStore.clearDeleted(id).catch(() => undefined);
    throw err;
  }
  await reloadEventRegistry();
  console.info('[events] deleted', id, 'by', by);
}

/**
 * Re-publish a historical version. History rows store the published payload in
 * the same draft shape as `event_definitions.draft` (publish persists
 * `published: draft`), so the entry goes straight back through
 * `publishEventDefinition`: the payload is re-validated and impact-checked,
 * written over the working draft, and its authored schedule replaces the
 * event's schedule rows.
 */
export async function rollbackEventDefinition(
  id: string,
  version: number,
  opts: { by?: string | null; players?: MarathonPlayerStateReader } = {},
): Promise<{ version: number; warnings: ValidationIssue[] }> {
  const activeStore = requireStore();
  await requireDefinition(id);
  const entry = (await activeStore.listHistory(id)).find((row) => row.version === version);
  if (!entry) throw new EventVersionNotFoundError(id, version);
  return publishEventDefinition(id, {
    draft: entry.published,
    by: opts.by,
    players: opts.players,
  });
}

/**
 * Replace every schedule row of one event. Each input row must be a valid
 * UTC instant window with `startsAt < endsAt <= exchangeEndsAt`; the registry
 * is reloaded afterwards so the new windows apply live.
 */
export async function replaceEventSchedule(
  id: string,
  input: EventScheduleInputRow[],
): Promise<{ schedule: EventScheduleRow[]; warnings: string[] }> {
  const activeStore = requireStore();
  await requireDefinition(id);

  const rows: NewEventSchedule[] = [];
  const errors: string[] = [];
  input.forEach((entry, index) => {
    const at = `schedules[${index}]`;
    const starts = isoInstant(entry.startsAt);
    const ends = isoInstant(entry.endsAt);
    const exchange = isoInstant(entry.exchangeEndsAt);
    let ok = true;
    if (starts === undefined) {
      errors.push(`${at}.startsAt must be an ISO-8601 UTC timestamp`);
      ok = false;
    }
    if (ends === undefined) {
      errors.push(`${at}.endsAt must be an ISO-8601 UTC timestamp`);
      ok = false;
    }
    if (exchange === undefined) {
      errors.push(`${at}.exchangeEndsAt must be an ISO-8601 UTC timestamp`);
      ok = false;
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      errors.push(`${at}.enabled must be a boolean`);
      ok = false;
    }
    if (starts !== undefined && ends !== undefined && !(starts < ends)) {
      errors.push(`${at}: startsAt must be before endsAt`);
      ok = false;
    }
    if (ends !== undefined && exchange !== undefined && !(ends <= exchange)) {
      errors.push(`${at}: endsAt must be at or before exchangeEndsAt`);
      ok = false;
    }
    if (ok && starts !== undefined && ends !== undefined && exchange !== undefined) {
      rows.push({
        eventId: id,
        startsAt: new Date(starts),
        endsAt: new Date(ends),
        exchangeEndsAt: new Date(exchange),
        enabled: entry.enabled !== false,
      });
    }
  });
  if (errors.length > 0) throw new EventScheduleValidationError(id, errors);

  await activeStore.replaceSchedule(id, rows);
  await reloadEventRegistry();
  return { schedule: scheduleFor(scheduleRows, id), warnings: [] as string[] };
}

/** Clear all in-process state (and the store), for tests. */
export function resetEventRegistryForTests(): void {
  store = undefined;
  loaded = false;
  compiled = new Map();
  scheduleRows = [];
  // `revision` is deliberately monotonic: cached projections keyed on it must
  // never be mistaken for a fresh state after a reset in the same process.
  reloadChain = Promise.resolve();
}
