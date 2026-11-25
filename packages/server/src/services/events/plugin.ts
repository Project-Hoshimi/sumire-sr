/**
 * Event-type plugin registry.
 *
 * Each event kind (marathon first) registers a plugin that knows how to parse
 * its authored draft, validate it, compile it to the runtime config the
 * services read, and describe its editable fields for the builder GUI.
 */

export interface ValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * One player-state consequence of publishing a draft. A `block` impact that
 * affects at least one player refuses the publish; a `warn` impact never does.
 * `requiresPlayerCheck` impacts are counted per player by `previewPublish`.
 */
export interface StateImpact {
  code: string;
  severity: 'block' | 'warn';
  message: string;
  boxId?: string;
  itemKey?: string;
  questId?: string;
  newStock?: number;
  requiresPlayerCheck: boolean;
}

export interface EditorField {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  label?: string;
  readOnly?: boolean;
}

export interface EditorSchema {
  fields: EditorField[];
}

/** Authored event window; all timestamps are ISO-8601 UTC strings. */
export interface EventScheduleInput {
  startsAt: string;
  endsAt: string;
  exchangeEndsAt: string;
}

/**
 * How an event kind relates to its authored schedule.
 *
 * - `scheduled`: the draft carries an authored `schedule`, imported as one
 *   event_schedule row; "published" and "live" are different things.
 * - `permanent`: the draft has no schedule (`draftSchedule` returns undefined),
 *   so no event_schedule rows are written and "published = live".
 *
 * Defaults to `scheduled` when a plugin does not set it.
 */
export type EventLifecycle = 'scheduled' | 'permanent';

export interface EventPlugin<Draft = unknown, Runtime = unknown> {
  kind: string;
  /** Schedule semantics of this kind; omitted means `scheduled`. */
  lifecycle?: EventLifecycle;
  schema: EditorSchema;
  /** Parse untyped JSON (catalog file or DB jsonb) into a Draft; throw Error with a clear message when it is not even shaped like a draft. */
  parseDraft(raw: unknown): Draft;
  draftId(draft: Draft): string;
  draftTitle(draft: Draft): string;
  draftSchedule(draft: Draft): EventScheduleInput | undefined;
  importFromMaster(eventId: string): Promise<Draft>;
  /**
   * Optional starting draft for a brand-new definition. The admin API uses it
   * when a create request omits `draft`; `id` and `title` come from the
   * request so the new draft already carries the author's choices.
   */
  defaultDraft?(id: string, title: string): Draft;
  validate(draft: Draft): ValidationIssue[];
  compile(draft: Draft): Runtime;
  /** Player-state consequences of replacing the published draft; `published` is undefined before the first publish. `rawDraft` is the unparsed candidate (before any key/default normalisation) when the caller has it. */
  stateImpact(published: Draft | undefined, draft: Draft, rawDraft?: unknown): StateImpact[];
  /**
   * Optional startup migration: return an upgraded copy of a stored draft (or
   * its published JSON), or null when it needs no change. Must be idempotent —
   * `initEventRegistry` re-runs it on every boot.
   */
  upgradeDraft?(draft: unknown): unknown | null;
}

const plugins = new Map<string, EventPlugin>();

/** Register (or replace) the plugin for `p.kind`. Called at module load by each plugin. */
export function registerEventPlugin(p: EventPlugin<any, any>): void {
  plugins.set(p.kind, p);
}

export function eventPlugin(kind: string): EventPlugin | undefined {
  return plugins.get(kind);
}

export function eventPlugins(): EventPlugin[] {
  return [...plugins.values()];
}

/** Lifecycle of `kind`; unknown kinds read as `scheduled` so stored rows stay renderable. */
export function pluginLifecycle(kind: string): EventLifecycle {
  return plugins.get(kind)?.lifecycle ?? 'scheduled';
}
