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

export interface StateImpact {
  kind: string;
  message: string;
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

export interface EventPlugin<Draft = unknown, Runtime = unknown> {
  kind: string;
  schema: EditorSchema;
  /** Parse untyped JSON (catalog file or DB jsonb) into a Draft; throw Error with a clear message when it is not even shaped like a draft. */
  parseDraft(raw: unknown): Draft;
  draftId(draft: Draft): string;
  draftTitle(draft: Draft): string;
  draftSchedule(draft: Draft): EventScheduleInput | undefined;
  importFromMaster(eventId: string): Promise<Draft>;
  validate(draft: Draft): ValidationIssue[];
  compile(draft: Draft): Runtime;
  stateImpact(prev: Draft, next: Draft): StateImpact[];
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
