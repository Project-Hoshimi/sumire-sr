/**
 * Marathon event catalog: one checked-in JSON file per authored event.
 *
 * The served event comes from the DB-backed event registry (`registry.ts`)
 * once it is loaded; before that (DB-free tests and tools) this file catalog is
 * the fallback. `SUMIRE_MARATHON_ID` remains a development override: that event
 * is advertised first and always open. Catalogues are server-owned data (like
 * the MoshiKoi catalogs) rather than master data because the event window and
 * the Home/Enter advertisement are not part of the master tables. The override
 * derives times from the current time by `marathonWindow`, never authored.
 *
 * Files are parsed, validated and compiled through `marathonPlugin`, so an
 * invalid file is skipped with a warning and the rest of the catalog still
 * loads.
 */
import { readdirSync, readFileSync } from 'node:fs';
import {
  isSafeMarathonId,
  marathonPlugin,
  type MarathonConfig,
  type MarathonDraft,
} from './plugin.ts';
import type { EventScheduleInput } from '../events/plugin.ts';
import {
  compiledEvent,
  eventWindowAt,
  openEvents,
  registryLoaded,
} from '../events/registry.ts';

export type { MarathonConfig } from './plugin.ts';
export { parseNpcRosters } from './plugin.ts';

export interface MarathonWindow {
  startTime: number;
  endTime: number;
  exchangeEndTime: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT_DAYS = 15;
const EXCHANGE_DAYS = 7;

const CATALOG_DIR = new URL('./catalog/', import.meta.url);
let catalogIndex: Map<string, MarathonConfig> | undefined;
let catalogDraftList: MarathonDraft[] = [];
let catalogWindowIndex: Map<string, MarathonWindow> = new Map();
let testCatalogRaw: unknown[] | undefined;

/** Authored ISO schedule → epoch-ms window, or `undefined` when it is absent/invalid. */
function scheduleWindow(input: EventScheduleInput | undefined): MarathonWindow | undefined {
  if (!input) return undefined;
  const startTime = Date.parse(input.startsAt);
  const endTime = Date.parse(input.endsAt);
  const exchangeEndTime = Date.parse(input.exchangeEndsAt);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || !Number.isFinite(exchangeEndTime)) {
    return undefined;
  }
  return { startTime, endTime, exchangeEndTime };
}

/** Parse every checked-in catalogue once; file names need not match the event id. */
function catalog(): Map<string, MarathonConfig> {
  if (catalogIndex) return catalogIndex;

  const entries = new Map<string, MarathonConfig>();
  const drafts: MarathonDraft[] = [];
  const windows = new Map<string, MarathonWindow>();

  /** Parse, validate and compile one raw draft; `label` identifies it in warnings. */
  const accept = (label: string, raw: unknown): void => {
    let draft: MarathonDraft;
    try {
      draft = marathonPlugin.parseDraft(raw);
    } catch {
      // Not even shaped like a draft: same skip as a file that fails to parse.
      return;
    }

    const errors = marathonPlugin.validate(draft).filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      for (const issue of errors) {
        console.warn(`marathon catalog ${label}: ${issue.path}: ${issue.message}`);
      }
      return;
    }

    const config = marathonPlugin.compile(draft);
    entries.set(config.id, config);
    drafts.push(draft);
    const window = scheduleWindow(marathonPlugin.draftSchedule(draft));
    if (window) windows.set(config.id, window);
  };

  if (testCatalogRaw !== undefined) {
    testCatalogRaw.forEach((raw, index) => accept(`test-catalog[${index}]`, raw));
  } else {
    let files: string[] = [];
    try {
      files = readdirSync(CATALOG_DIR);
    } catch {
      files = [];
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(new URL(file, CATALOG_DIR), 'utf8'));
      } catch {
        continue;
      }
      accept(file, raw);
    }
  }

  catalogIndex = entries;
  catalogDraftList = drafts;
  catalogWindowIndex = windows;
  return entries;
}

/**
 * Load one authored event. Once the event registry is loaded the definition
 * compiled from the database wins; before that (DB-free tests and tools) the
 * checked-in catalog files are used. Returns `undefined` when the id is not
 * served, so callers can treat it as "not served".
 */
export function marathonConfig(id: string): MarathonConfig | undefined {
  if (!isSafeMarathonId(id)) return undefined;
  if (registryLoaded()) return compiledEvent<MarathonConfig>('marathon', id);
  return catalog().get(id);
}

/**
 * Window of `id` at `now` from the catalog file's authored `schedule`, used
 * while the registry is not loaded: open when `startsAt <= now < exchangeEndsAt`.
 */
function catalogWindowAt(id: string, now: number): MarathonWindow | undefined {
  catalog();
  const window = catalogWindowIndex.get(id);
  if (!window) return undefined;
  if (!(window.startTime <= now && now < window.exchangeEndTime)) return undefined;
  return window;
}

/** Every catalog event with an authored schedule open at `now`, ordered by start then id. */
function openCatalogEvents(now: number): { id: string; config: MarathonConfig; window: MarathonWindow }[] {
  const result: { id: string; config: MarathonConfig; window: MarathonWindow }[] = [];
  for (const [id, config] of catalog()) {
    const window = catalogWindowAt(id, now);
    if (window) result.push({ id, config, window });
  }
  result.sort(
    (a, b) => a.window.startTime - b.window.startTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return result;
}

/**
 * Events open at `now`, advertised on Home:Enter and served by Marathon:Top.
 * The `SUMIRE_MARATHON_ID` development override comes first and is always open
 * (its window is derived, not authored); then every open event, sorted by
 * window start. While the registry is not loaded, the catalog files' authored
 * `schedule` blocks stand in for the database schedule rows. The variable is
 * read per call so tests can switch it in-process.
 */
export function openMarathons(now: number): { config: MarathonConfig; window: MarathonWindow }[] {
  const events: { config: MarathonConfig; window: MarathonWindow }[] = [];
  const overrideId = process.env.SUMIRE_MARATHON_ID?.trim() ?? '';
  if (overrideId !== '') {
    const config = marathonConfig(overrideId);
    if (config) events.push({ config, window: marathonWindow(now) });
  }
  const scheduled = registryLoaded()
    ? openEvents<MarathonConfig>('marathon', now).map((event) => ({
        id: event.id,
        config: event.runtime,
        window: event.window,
      }))
    : openCatalogEvents(now);
  for (const event of scheduled) {
    if (overrideId !== '' && event.id === overrideId) continue;
    events.push({ config: event.config, window: event.window });
  }
  return events;
}

/**
 * Playable window of event `id` at `now`: the development override is always
 * open with its derived window; everything else comes from the registry
 * schedule, or from the catalog file's authored `schedule` while the registry
 * is not loaded. `undefined` means the event is not open.
 */
export function marathonWindowFor(id: string, now: number): MarathonWindow | undefined {
  const overrideId = process.env.SUMIRE_MARATHON_ID?.trim() ?? '';
  if (overrideId !== '' && id === overrideId) {
    return marathonConfig(id) ? marathonWindow(now) : undefined;
  }
  if (!registryLoaded()) return catalogWindowAt(id, now);
  return eventWindowAt('marathon', id, now);
}

/**
 * The first open event advertised by Home:Enter and served by Marathon:Top.
 * @deprecated Use an event id: `marathonConfig(id)`, `marathonWindowFor(id, now)`
 * or `openMarathons(now)`.
 */
export function activeMarathon(): MarathonConfig | undefined {
  return openMarathons(Date.now())[0]?.config;
}

/**
 * The parsed, valid catalog drafts. Exposed for the phase-2 startup import that
 * seeds event definitions from the checked-in JSON files.
 */
export function catalogDrafts(): MarathonDraft[] {
  catalog();
  return catalogDraftList;
}

/** Tests only: replace the checked-in catalog files with these parsed JSON drafts; `undefined` restores the files. */
export function setCatalogForTests(raw: unknown[] | undefined): void {
  testCatalogRaw = raw;
  catalogIndex = undefined;
  catalogDraftList = [];
  catalogWindowIndex = new Map();
}

/**
 * Derived event window: start of the current UTC day minus one day, 15 event
 * days, then a 7-day exchange window. All values are epoch milliseconds.
 */
export function marathonWindow(now: number): MarathonWindow {
  const startTime = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
  const endTime = startTime + EVENT_DAYS * DAY_MS;
  const exchangeEndTime = endTime + EXCHANGE_DAYS * DAY_MS;
  return { startTime, endTime, exchangeEndTime };
}
