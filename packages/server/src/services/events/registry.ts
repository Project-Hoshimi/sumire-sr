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
import { eventPlugin, type ValidationIssue } from './plugin.ts';
import type {
  EventScheduleRow,
  EventStore,
  NewEventSchedule,
} from './store.ts';
// Side-effect import: registers the marathon plugin with the event plugin registry.
import '../marathon/plugin.ts';

/** A compiled event plus its authored kind. */
interface CompiledEvent {
  kind: string;
  runtime: unknown;
}

/** Event window in epoch milliseconds; same meaning as `MarathonWindow`. */
export interface EventWindow {
  startTime: number;
  endTime: number;
  exchangeEndTime: number;
}

let store: EventStore | undefined;
let loaded = false;
let compiled = new Map<string, CompiledEvent>();
let scheduleRows: EventScheduleRow[] = [];
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

  await reloadEventRegistry();
  return { imported };
}

/** Warn once for each pair of enabled marathon playable windows that overlap. */
function warnOverlappingMarathons(): void {
  const rows = scheduleRows.filter((row) => {
    if (!row.enabled) return false;
    return compiled.get(row.eventId)?.kind === 'marathon';
  });
  const warned = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i] as EventScheduleRow;
      const b = rows[j] as EventScheduleRow;
      if (a.eventId === b.eventId) continue;
      const pair = [a.eventId, b.eventId].sort().join('\u0000');
      if (warned.has(pair)) continue;
      const start = Math.max(a.startsAt.getTime(), b.startsAt.getTime());
      const end = Math.min(a.endsAt.getTime(), b.endsAt.getTime());
      if (start < end) {
        warned.add(pair);
        console.warn(
          `[events] marathon ${a.eventId} and ${b.eventId} have overlapping playable windows; the client may only show one`,
        );
      }
    }
  }
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
      next.set(definition.id, { kind: definition.kind, runtime });
    } catch (error) {
      console.warn(`[events] ${definition.id}: ${(error as Error).message}`);
    }
  }

  compiled = next;
  scheduleRows = schedule;
  loaded = true;
  warnOverlappingMarathons();
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
 * Publish a definition: validate and compile the draft, bump the version
 * through the store, then reload the registry so the change applies live.
 */
export async function publishEventDefinition(
  id: string,
  opts: { by?: string | null; draft?: unknown } = {},
): Promise<{ version: number; warnings: ValidationIssue[] }> {
  const activeStore = requireStore();
  const definition = await activeStore.getDefinition(id);
  if (!definition) throw new Error(`event definition not found: ${id}`);
  const plugin = eventPlugin(definition.kind);
  if (!plugin) throw new Error(`event ${id}: unknown event kind ${definition.kind}`);

  const draft = plugin.parseDraft(opts.draft ?? definition.draft);
  const issues = plugin.validate(draft);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    const detail = errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new Error(`event ${id} has validation errors: ${detail}`);
  }
  plugin.compile(draft);

  const version = definition.publishedVersion + 1;
  const schedule = plugin.draftSchedule(draft);
  await activeStore.publish(id, {
    draft: opts.draft,
    published: draft,
    publishedVersion: version,
    updatedBy: opts.by ?? null,
    // A draft without a schedule leaves any existing schedule rows untouched.
    ...(schedule ? { schedule: scheduleFromDraft(id, schedule) } : {}),
  });
  await reloadEventRegistry();
  return { version, warnings: issues.filter((issue) => issue.severity === 'warning') };
}

/** Clear all in-process state (and the store), for tests. */
export function resetEventRegistryForTests(): void {
  store = undefined;
  loaded = false;
  compiled = new Map();
  scheduleRows = [];
  reloadChain = Promise.resolve();
}
