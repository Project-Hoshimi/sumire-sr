/**
 * もし恋 (MoshiKoi) event plugin.
 *
 * A moshikoi event is a pair of JSON documents: the event catalog
 * (`catalog/<loveId>.json`) and its route map (`routes/<loveId>.json`). The
 * plugin keeps both verbatim in the draft so the builder can edit them, and
 * reuses the catalog module's pure parsers so a draft validates exactly like a
 * checked-in file.
 *
 * These are permanent events: they carry no authored window, `draftSchedule`
 * returns undefined and publishing them writes no `event_schedule` rows.
 */
import {
  loveCatalogJson,
  loveRoutesJson,
  moshikoiDraftTitle,
  MoshikoiError,
  parseEventConfig,
  parseEventRoutes,
  type EventConfig,
  type Routes,
} from './catalog.ts';
import {
  registerEventPlugin,
  type EditorSchema,
  type EventPlugin,
  type StateImpact,
  type ValidationIssue,
} from '../events/plugin.ts';

/** The love event cloned by `defaultDraft`. */
const DEFAULT_LOVE_ID = 'love-24-1114';

export interface MoshikoiDraft {
  /** Love event id; always equal to `catalog.loveId`. */
  id: string;
  title: string;
  /** Verbatim `catalog/<loveId>.json` content. */
  catalog: Record<string, unknown>;
  /** Verbatim `routes/<loveId>.json` content. */
  routes: Record<string, unknown>;
}

export interface MoshikoiRuntime {
  config: EventConfig;
  routes: Routes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseDraft(raw: unknown): MoshikoiDraft {
  if (!isRecord(raw)) {
    throw new Error('moshikoi draft must be an object');
  }
  if (!isRecord(raw.catalog)) {
    throw new Error('moshikoi draft catalog must be an object');
  }
  if (!isRecord(raw.routes)) {
    throw new Error('moshikoi draft routes must be an object');
  }
  const catalog = raw.catalog;
  const id = stringValue(raw.id) || stringValue(catalog.loveId);
  if (id === '') {
    throw new Error('moshikoi draft must have an id');
  }
  return {
    id,
    title: stringValue(raw.title) || moshikoiDraftTitle(catalog),
    catalog,
    routes: raw.routes,
  };
}

/**
 * Build a draft from the checked-in JSON files. Moshikoi data is not present in
 * the game master tables, so "import from master" is really "import from the
 * repository's catalog files".
 */
async function importFromMaster(eventId: string): Promise<MoshikoiDraft> {
  const catalog = loveCatalogJson(eventId);
  return {
    id: eventId,
    title: moshikoiDraftTitle(catalog),
    catalog,
    routes: loveRoutesJson(eventId),
  };
}

/** Starting draft for a new definition: the love-24-1114 pair with ids replaced. */
export function defaultDraftFor(id: string, title: string): MoshikoiDraft {
  const catalog = structuredClone(loveCatalogJson(DEFAULT_LOVE_ID));
  const routes = structuredClone(loveRoutesJson(DEFAULT_LOVE_ID));
  catalog.loveId = id;
  routes.loveId = id;
  return {
    id,
    title: title || moshikoiDraftTitle(catalog),
    catalog,
    routes,
  };
}

/** Turn a thrown MoshikoiError into an issue, keeping its field as the path tail. */
function issueFromError(prefix: string, error: unknown): ValidationIssue {
  if (error instanceof MoshikoiError) {
    return {
      path: error.field === undefined || error.field === '' ? prefix : `${prefix}.${error.field}`,
      message: error.message,
      severity: 'error',
    };
  }
  return {
    path: prefix,
    message: error instanceof Error ? error.message : String(error),
    severity: 'error',
  };
}

function validateDraft(draft: MoshikoiDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (draft.id === '') {
    issues.push({ path: 'id', message: 'draft id is required', severity: 'error' });
  }
  try {
    parseEventConfig(draft.catalog, draft.id);
  } catch (error) {
    issues.push(issueFromError('catalog', error));
  }
  try {
    parseEventRoutes(draft.routes, draft.id);
  } catch (error) {
    issues.push(issueFromError('routes', error));
  }
  // TODO: warn when master has no LoveStoryEpisode rows for the id. Master
  // access is async (`listLoveStoryEpisodes`) and `validate` is synchronous, so
  // this check has to move to an async caller (builder preview) later.
  return issues;
}

function compileDraft(draft: MoshikoiDraft): MoshikoiRuntime {
  const errors = validateDraft(draft).filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    const detail = errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new Error(`moshikoi draft ${draft.id || '(no id)'}: ${detail}`);
  }
  return {
    config: parseEventConfig(draft.catalog, draft.id),
    routes: parseEventRoutes(draft.routes, draft.id),
  };
}

function rawEpisodeIds(draft: MoshikoiDraft): string[] {
  if (!isRecord(draft.routes.episodes)) return [];
  return Object.keys(draft.routes.episodes);
}

function rawEndingIds(draft: MoshikoiDraft): string[] {
  if (!Array.isArray(draft.routes.endings)) return [];
  const ids: string[] = [];
  for (const raw of draft.routes.endings) {
    if (isRecord(raw) && stringValue(raw.id) !== '') ids.push(stringValue(raw.id));
  }
  return ids;
}

function stateImpactOf(
  published: MoshikoiDraft | undefined,
  draft: MoshikoiDraft,
): StateImpact[] {
  if (published === undefined) return [];
  const impacts: StateImpact[] = [];
  const draftEpisodes = new Set(rawEpisodeIds(draft));
  for (const id of rawEpisodeIds(published)) {
    if (!draftEpisodes.has(id)) {
      impacts.push({
        code: 'moshikoi-episode-removed',
        severity: 'warn',
        message: `episode ${id} is published but missing from the draft`,
        requiresPlayerCheck: false,
      });
    }
  }
  const draftEndings = new Set(rawEndingIds(draft));
  for (const id of rawEndingIds(published)) {
    if (!draftEndings.has(id)) {
      impacts.push({
        code: 'moshikoi-ending-removed',
        severity: 'warn',
        message: `ending ${id} is published but missing from the draft`,
        requiresPlayerCheck: false,
      });
    }
  }
  return impacts;
}

const schema: EditorSchema = {
  fields: [
    { path: 'id', type: 'string', label: 'Love event id', readOnly: true },
    { path: 'title', type: 'string', label: 'Title' },
    { path: 'catalog', type: 'object', label: 'Catalog' },
    { path: 'routes', type: 'object', label: 'Route map' },
  ],
};

export const moshikoiPlugin: EventPlugin<MoshikoiDraft, MoshikoiRuntime> = {
  kind: 'moshikoi',
  lifecycle: 'permanent',
  schema,
  parseDraft,
  draftId: (draft) => draft.id,
  draftTitle: (draft) => draft.title,
  draftSchedule: () => undefined,
  importFromMaster,
  defaultDraft: defaultDraftFor,
  validate: validateDraft,
  compile: compileDraft,
  stateImpact: stateImpactOf,
};

registerEventPlugin(moshikoiPlugin);
