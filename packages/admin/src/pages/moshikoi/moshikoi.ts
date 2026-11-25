/**
 * Typed helpers for the moshikoi (もし恋) love-event draft editor.
 *
 * A moshikoi draft is two verbatim JSON documents taken from
 * `fastify-api/src/services/moshikoi/{catalog,routes}/`; the plugin keeps both
 * exactly as authored. The editor therefore reads them as plain records and
 * every mutator here returns a copy that touches only the field being edited:
 * omitted fields stay omitted, so a save never adds empty defaults the author
 * did not write.
 *
 * The page keeps one shared draft state for every event kind so its dirty
 * tracking, Save draft and Validate actions work unchanged. A moshikoi document
 * is held in that state as-is; `asMoshikoiDraft` / `asEditorDraft` are the two
 * documented casts between the two views, and are only used once the event kind
 * is known to be `moshikoi`.
 */
import type { MarathonDraftShape } from '../../draft.ts';

/** The two documents a moshikoi draft carries, plus its identity. */
export interface MoshikoiDraftShape {
  id: string;
  title: string;
  catalog: Record<string, unknown>;
  routes: Record<string, unknown>;
  /** Any other top-level key the stored draft carried is preserved. */
  [key: string]: unknown;
}

/** One condition inside an outcome or a group's `requires` list. */
export interface MoshikoiCondition {
  /** Empty/absent means "the episode currently being resolved". */
  episode?: string;
  group: number;
  choice: number;
  [key: string]: unknown;
}

/** One choice group of an episode. */
export interface MoshikoiChoiceGroup {
  index: number;
  count: number;
  /** 1-based best choice; 0/absent means unknown. */
  best?: number;
  scores: number[];
  points?: number[];
  requires?: MoshikoiCondition[];
  [key: string]: unknown;
}

/** One routing outcome of an episode. */
export interface MoshikoiOutcome {
  all?: MoshikoiCondition[];
  next?: string;
  ending?: string;
  minPoints?: number;
  maxPoints?: number;
  [key: string]: unknown;
}

/** One story branch of an episode. */
export interface MoshikoiBranch {
  group: number;
  match: number;
  otherwise: number;
  all?: MoshikoiCondition[];
  [key: string]: unknown;
}

/** One episode of the route map. */
export interface MoshikoiEpisode {
  groups?: MoshikoiChoiceGroup[];
  next?: string;
  outcomes?: MoshikoiOutcome[];
  branches?: MoshikoiBranch[];
  [key: string]: unknown;
}

/** One ending. */
export interface MoshikoiEnding {
  id: string;
  name: string;
  favorability: number;
  endRollAssetId?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** True when the value looks like a moshikoi document (both JSON parts). */
export function isMoshikoiDraft(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isRecord(value.catalog) && isRecord(value.routes);
}

/** Read a stored draft into the moshikoi view without inventing fields. */
export function moshikoiDraftFromUnknown(raw: unknown): MoshikoiDraftShape {
  const source = isRecord(raw) ? raw : {};
  const catalog = isRecord(source.catalog) ? source.catalog : {};
  const routes = isRecord(source.routes) ? source.routes : {};
  return {
    ...source,
    id: stringOf(source.id) || stringOf(catalog.loveId) || stringOf(routes.loveId),
    title: stringOf(source.title) || stringOf(catalog.name),
    catalog,
    routes,
  };
}

/** The shared draft state seen as the moshikoi document it holds. */
export function asMoshikoiDraft(draft: MarathonDraftShape): MoshikoiDraftShape {
  return draft as unknown as MoshikoiDraftShape;
}

/** A moshikoi document marshalled back into the page's shared draft state. */
export function asEditorDraft(draft: MoshikoiDraftShape): MarathonDraftShape {
  return draft as unknown as MarathonDraftShape;
}

/** An epoch-ms timestamp as a `datetime-local` value, always in UTC. */
export function msToUtcDatetimeLocal(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 19);
}

/** A UTC `datetime-local` value as epoch ms; null for a partial value. */
export function datetimeLocalToMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const ms = Date.parse(`${withSeconds}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The short episode suffix the left-hand list shows ("001", "007-bad"), using
 * the same `love-event-story-<loveId>-` prefix the server builds.
 */
export function episodeShortId(episodeId: string, loveId: string): string {
  const prefix = `love-event-story-${loveId.replace(/^love-extra-/, '')}-`;
  if (loveId !== '' && episodeId.startsWith(prefix)) return episodeId.slice(prefix.length);
  const marker = 'love-event-story-';
  if (episodeId.startsWith(marker)) {
    const match = /^love-(?:extra-)?\d{2}-\d{4}-(.+)$/.exec(episodeId.slice(marker.length));
    if (match !== null) return match[1] as string;
  }
  return episodeId;
}

/* -------------------------------------------------------------------------- */
/* Draft-level writers                                                         */
/* -------------------------------------------------------------------------- */

/** Copy the draft with a replaced catalog document. */
export function withCatalog(
  draft: MoshikoiDraftShape,
  catalog: Record<string, unknown>,
): MoshikoiDraftShape {
  return { ...draft, catalog };
}

/** Copy the draft with a replaced route map. */
export function withRoutes(
  draft: MoshikoiDraftShape,
  routes: Record<string, unknown>,
): MoshikoiDraftShape {
  return { ...draft, routes };
}

/* -------------------------------------------------------------------------- */
/* Route-map readers                                                           */
/* -------------------------------------------------------------------------- */

export function episodesOf(routes: Record<string, unknown>): Record<string, MoshikoiEpisode> {
  return isRecord(routes.episodes) ? (routes.episodes as Record<string, MoshikoiEpisode>) : {};
}

export function episodeIdsOf(routes: Record<string, unknown>): string[] {
  return Object.keys(episodesOf(routes));
}

export function endingListOf(routes: Record<string, unknown>): MoshikoiEnding[] {
  return Array.isArray(routes.endings) ? (routes.endings as MoshikoiEnding[]) : [];
}

/** Ending ids usable in a select; a row without an id offers no target. */
export function endingIdsOf(routes: Record<string, unknown>): string[] {
  return endingListOf(routes)
    .map((ending) => stringOf(ending.id))
    .filter((id) => id !== '');
}

export function endingConditionsOf(routes: Record<string, unknown>): Record<string, string> {
  return isRecord(routes.endingConditions) ? (routes.endingConditions as Record<string, string>) : {};
}

export function groupsOf(episode: MoshikoiEpisode): MoshikoiChoiceGroup[] {
  return Array.isArray(episode.groups) ? (episode.groups as MoshikoiChoiceGroup[]) : [];
}

export function outcomesOf(episode: MoshikoiEpisode): MoshikoiOutcome[] {
  return Array.isArray(episode.outcomes) ? (episode.outcomes as MoshikoiOutcome[]) : [];
}

export function conditionsOf(outcome: MoshikoiOutcome): MoshikoiCondition[] {
  return Array.isArray(outcome.all) ? (outcome.all as MoshikoiCondition[]) : [];
}

export function countOf(group: MoshikoiChoiceGroup): number {
  return typeof group.count === 'number' && Number.isFinite(group.count)
    ? Math.max(0, Math.trunc(group.count))
    : 0;
}

export function scoresOf(group: MoshikoiChoiceGroup): number[] {
  return Array.isArray(group.scores) ? group.scores : [];
}

/** The group's route points, or null when the group omits them. */
export function pointsOf(group: MoshikoiChoiceGroup): number[] | null {
  return Array.isArray(group.points) ? group.points : null;
}

/* -------------------------------------------------------------------------- */
/* Episode writers                                                             */
/* -------------------------------------------------------------------------- */

/** Copy the route map with one episode changed. */
export function updateEpisode(
  routes: Record<string, unknown>,
  episodeId: string,
  change: (episode: MoshikoiEpisode) => MoshikoiEpisode,
): Record<string, unknown> {
  const episodes = episodesOf(routes);
  const episode = episodes[episodeId];
  if (episode === undefined) return routes;
  return { ...routes, episodes: { ...episodes, [episodeId]: change(episode) } };
}

/** Set an episode's `next`; an empty value removes the field. */
export function setEpisodeNext(
  routes: Record<string, unknown>,
  episodeId: string,
  next: string,
): Record<string, unknown> {
  return updateEpisode(routes, episodeId, (episode) => {
    const copy: MoshikoiEpisode = { ...episode };
    if (next === '') delete copy.next;
    else copy.next = next;
    return copy;
  });
}

/** Replace an episode's `branches` list. */
export function setEpisodeBranches(
  routes: Record<string, unknown>,
  episodeId: string,
  branches: MoshikoiBranch[],
): Record<string, unknown> {
  return updateEpisode(routes, episodeId, (episode) => ({ ...episode, branches }));
}

/** Copy the route map with one choice group (by array position) changed. */
export function updateGroup(
  routes: Record<string, unknown>,
  episodeId: string,
  position: number,
  change: (group: MoshikoiChoiceGroup) => MoshikoiChoiceGroup,
): Record<string, unknown> {
  return updateEpisode(routes, episodeId, (episode) => {
    const groups = groupsOf(episode);
    if (groups[position] === undefined) return episode;
    return { ...episode, groups: groups.map((group, at) => (at === position ? change(group) : group)) };
  });
}

/** Replace a group's `requires` list. */
export function setGroupRequires(
  routes: Record<string, unknown>,
  episodeId: string,
  position: number,
  requires: MoshikoiCondition[],
): Record<string, unknown> {
  return updateGroup(routes, episodeId, position, (group) => ({ ...group, requires }));
}

/** Resize a group to `count` choices, padding scores and points with 0. */
export function setGroupCount(group: MoshikoiChoiceGroup, count: number): MoshikoiChoiceGroup {
  const next = Math.max(0, Math.trunc(count));
  const previousScores = scoresOf(group);
  const previousPoints = pointsOf(group);
  const resize = (values: number[]): number[] =>
    Array.from({ length: next }, (_, index) =>
      typeof values[index] === 'number' ? (values[index] as number) : 0,
    );
  const resized: MoshikoiChoiceGroup = { ...group, count: next, scores: resize(previousScores) };
  if (previousPoints !== null) resized.points = resize(previousPoints);
  return resized;
}

/** Set one choice's score, padding the array if the draft is short. */
export function setGroupScore(
  group: MoshikoiChoiceGroup,
  choice: number,
  score: number,
): MoshikoiChoiceGroup {
  const scores = [...scoresOf(group)];
  while (scores.length <= choice) scores.push(0);
  scores[choice] = score;
  return { ...group, scores };
}

/** Set one choice's route points, padding the array if the draft is short. */
export function setGroupPoints(
  group: MoshikoiChoiceGroup,
  choice: number,
  points: number,
): MoshikoiChoiceGroup {
  const values = [...(pointsOf(group) ?? [])];
  while (values.length <= choice) values.push(0);
  values[choice] = points;
  return { ...group, points: values };
}

/** Set the best choice; 0 (none) removes the field. */
export function setGroupBest(group: MoshikoiChoiceGroup, best: number): MoshikoiChoiceGroup {
  const copy: MoshikoiChoiceGroup = { ...group };
  if (best <= 0) delete copy.best;
  else copy.best = best;
  return copy;
}

/* -------------------------------------------------------------------------- */
/* Outcome writers                                                             */
/* -------------------------------------------------------------------------- */

/** Copy the route map with one outcome (by array position) changed. */
export function updateOutcome(
  routes: Record<string, unknown>,
  episodeId: string,
  position: number,
  change: (outcome: MoshikoiOutcome) => MoshikoiOutcome,
): Record<string, unknown> {
  return updateEpisode(routes, episodeId, (episode) => {
    const outcomes = outcomesOf(episode);
    if (outcomes[position] === undefined) return episode;
    return {
      ...episode,
      outcomes: outcomes.map((outcome, at) => (at === position ? change(outcome) : outcome)),
    };
  });
}

/** Append an outcome with no conditions yet. */
export function addOutcome(
  routes: Record<string, unknown>,
  episodeId: string,
): Record<string, unknown> {
  return updateEpisode(routes, episodeId, (episode) => ({
    ...episode,
    outcomes: [...outcomesOf(episode), { all: [] }],
  }));
}

/** Remove one outcome. */
export function removeOutcome(
  routes: Record<string, unknown>,
  episodeId: string,
  position: number,
): Record<string, unknown> {
  return updateEpisode(routes, episodeId, (episode) => ({
    ...episode,
    outcomes: outcomesOf(episode).filter((_, at) => at !== position),
  }));
}

/** Set an outcome's `next`; an empty value removes the field. */
export function setOutcomeNext(outcome: MoshikoiOutcome, next: string): MoshikoiOutcome {
  const copy: MoshikoiOutcome = { ...outcome };
  if (next === '') delete copy.next;
  else copy.next = next;
  return copy;
}

/** Set an outcome's `ending`; an empty value removes the field. */
export function setOutcomeEnding(outcome: MoshikoiOutcome, ending: string): MoshikoiOutcome {
  const copy: MoshikoiOutcome = { ...outcome };
  if (ending === '') delete copy.ending;
  else copy.ending = ending;
  return copy;
}

/** Set or clear an outcome's point bound; null removes the field. */
export function setOutcomeBound(
  outcome: MoshikoiOutcome,
  field: 'minPoints' | 'maxPoints',
  value: number | null,
): MoshikoiOutcome {
  const copy: MoshikoiOutcome = { ...outcome };
  if (value === null) delete copy[field];
  else copy[field] = value;
  return copy;
}

/* -------------------------------------------------------------------------- */
/* Condition writers                                                           */
/* -------------------------------------------------------------------------- */

/** Copy an outcome with one condition (by array position) changed. */
export function updateCondition(
  outcome: MoshikoiOutcome,
  position: number,
  change: (condition: MoshikoiCondition) => MoshikoiCondition,
): MoshikoiOutcome {
  const conditions = conditionsOf(outcome);
  if (conditions[position] === undefined) return outcome;
  return {
    ...outcome,
    all: conditions.map((condition, at) => (at === position ? change(condition) : condition)),
  };
}

/** Append an unconditioned row that points at choice 1 of the current episode. */
export function addCondition(outcome: MoshikoiOutcome): MoshikoiOutcome {
  const condition: MoshikoiCondition = { group: 1, choice: 1 };
  return { ...outcome, all: [...conditionsOf(outcome), condition] };
}

/** Remove one condition. */
export function removeCondition(outcome: MoshikoiOutcome, position: number): MoshikoiOutcome {
  return { ...outcome, all: conditionsOf(outcome).filter((_, at) => at !== position) };
}

/** Point a condition at an episode; an empty value means "(current)". */
export function setConditionEpisode(
  condition: MoshikoiCondition,
  episode: string,
): MoshikoiCondition {
  const copy: MoshikoiCondition = { ...condition };
  if (episode === '') delete copy.episode;
  else copy.episode = episode;
  return copy;
}

/** Set a condition's group or choice number. */
export function setConditionNumber(
  condition: MoshikoiCondition,
  field: 'group' | 'choice',
  value: number,
): MoshikoiCondition {
  return { ...condition, [field]: value };
}

/* -------------------------------------------------------------------------- */
/* Ending writers                                                              */
/* -------------------------------------------------------------------------- */

/** Append an ending row. */
export function addEnding(
  routes: Record<string, unknown>,
  ending: MoshikoiEnding,
): Record<string, unknown> {
  return { ...routes, endings: [...endingListOf(routes), ending] };
}

/** Copy the route map with one ending (by array position) changed. */
export function updateEndingAt(
  routes: Record<string, unknown>,
  position: number,
  change: (ending: MoshikoiEnding) => MoshikoiEnding,
): Record<string, unknown> {
  const endings = endingListOf(routes);
  if (endings[position] === undefined) return routes;
  return {
    ...routes,
    endings: endings.map((ending, at) => (at === position ? change(ending) : ending)),
  };
}

/** Remove one ending. */
export function removeEndingAt(
  routes: Record<string, unknown>,
  position: number,
): Record<string, unknown> {
  return { ...routes, endings: endingListOf(routes).filter((_, at) => at !== position) };
}

/** Set (or blank) the ending a condition id unlocks. */
export function setEndingCondition(
  routes: Record<string, unknown>,
  conditionId: string,
  endingId: string,
): Record<string, unknown> {
  return {
    ...routes,
    endingConditions: { ...endingConditionsOf(routes), [conditionId]: endingId },
  };
}

/** Rename one ending-condition id, keeping its row position. */
export function renameEndingCondition(
  routes: Record<string, unknown>,
  oldId: string,
  newId: string,
): Record<string, unknown> {
  const entries = Object.entries(endingConditionsOf(routes));
  if (newId === '' || entries.some(([id]) => id === newId)) return routes;
  return {
    ...routes,
    endingConditions: Object.fromEntries(
      entries.map(([id, target]) => [id === oldId ? newId : id, target]),
    ),
  };
}

/** Remove one ending-condition row. */
export function removeEndingCondition(
  routes: Record<string, unknown>,
  conditionId: string,
): Record<string, unknown> {
  const conditions = { ...endingConditionsOf(routes) };
  delete conditions[conditionId];
  return { ...routes, endingConditions: conditions };
}
