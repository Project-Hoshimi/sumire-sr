/**
 * もし恋 (MoshiKoi) catalog: server-owned Love event configuration and the
 * per-event route maps.
 *
 * Data was ported from solis-server's `internal/makino/moshikoi/{catalogdata,
 * routedata}` YAML files and converted to JSON at port time, so no YAML parser
 * is needed at runtime. The loaders reproduce the validation solis performs in
 * `catalog.go` / `routes.go` and throw `MoshikoiError` when a file is invalid.
 *
 * Master-data-derived values (lesson step seconds, present favorability, promote
 * minutes/hours) are *not* loaded here: they require the game master database
 * and belong to a later stage.
 */
import { readFileSync } from 'node:fs';

/** `penum.LoveBaseType`, stored as a number in the JSON data. */
export const LOVE_BASE_TYPE = {
  UNKNOWN: 0,
  STANDARD: 1,
  EXTRA: 2,
} as const;
export type LoveBaseType = number;

export interface MainCharacterConfig {
  characterId: string;
  costumeId: string;
  assetId: string;
  color: string;
}

export interface EventConfig {
  loveId: string;
  name: string;
  description: string;
  startTime: number;
  unlockConditionId: string;
  bannerAssetId: string;
  characterId: string;
  costumeId: string;
  characterAssetId: string;
  color: string;
  storyReadItemId: string;
  presentItemId: string;
  promoteItemId: string;
  lessonMaxHours: number;
  eventMissionIds: string[];
  limitedEventMissionIds: string[];
  /** JSON keys are decimal strings; values are 1-based episode unlock levels. */
  episodeUnlockLevels: Record<number, number>;
  hintUnlockLevels: Record<number, number>;
  assetId: string;
  titleAssetId: string;
  expAssetId: string;
  simpleName: string;
  baseType: LoveBaseType;
  hideManagerVoiceSwitch: boolean;
  mainCharacters: MainCharacterConfig[];
  // TODO(stage 2): master-derived fields from solis catalog.go:
  //   presentFavorability (LoveItemInfo value)
  //   lessonStepSeconds   (game setting SecondsPerLoveLessonStep)
  //   promoteMinutes/promoteHours (LoveItemInfo lesson-promote value)
}

export interface Ending {
  id: string;
  name: string;
  endRollAssetId: string;
  favorability: number;
}

/**
 * Route choices are one-based, matching the wire protocol (the handwritten
 * route maps number alternatives from zero).
 */
export interface RouteCondition {
  /** Empty means "the episode currently being resolved". */
  episode: string;
  group: number;
  choice: number;
}

export interface RouteChoiceGroup {
  index: number;
  count: number;
  /** 1-based index of the best-favorability choice; 0 means unknown/none. */
  best: number;
  scores: number[];
  /** Route threshold points, independent of persistent favorability. */
  points: number[];
  requires: RouteCondition[];
}

export interface RouteOutcome {
  all: RouteCondition[];
  next: string;
  ending: string;
  minPoints?: number;
  maxPoints?: number;
}

export interface RouteBranch {
  group: number;
  match: number;
  otherwise: number;
  all: RouteCondition[];
}

export interface EpisodeRoute {
  groups: RouteChoiceGroup[];
  outcomes: RouteOutcome[];
  next: string;
  branches: RouteBranch[];
}

export interface Routes {
  loveId: string;
  episodes: Record<string, EpisodeRoute>;
  endings: Ending[];
  endingConditions: Record<string, string>;
}

export type MoshikoiErrorCode =
  | 'love-event-not-available'
  | 'unknown-catalog-field'
  | 'invalid-catalog'
  | 'invalid-heroine-catalog'
  | 'unsupported-love-route'
  | 'invalid-route-catalog'
  | 'invalid-ending'
  | 'invalid-route-episode'
  | 'invalid-choice-group'
  | 'invalid-route-point-choices'
  | 'invalid-or-overflowing-route-points'
  | 'love-route-score-overflows'
  | 'invalid-next-episode'
  | 'invalid-route-point-interval'
  | 'invalid-outcome'
  | 'invalid-story-branch'
  | 'unknown-ending-condition-target'
  | 'unknown-condition-episode'
  | 'invalid-condition-choice'
  | 'unknown-love-story-episode'
  | 'missing-story-choice'
  | 'invalid-story-choice'
  | 'multiple-active-choices-for-one-group'
  | 'missing-or-unreachable-story-choice'
  | 'love-route-has-no-matching-outcome';

export class MoshikoiError extends Error {
  readonly code: MoshikoiErrorCode;

  constructor(code: MoshikoiErrorCode, message: string) {
    super(message);
    this.name = 'MoshikoiError';
    this.code = code;
  }
}

/** Same list and order as solis's `SupportedLoveIDs`. */
const SUPPORTED_LOVE_IDS = [
  'love-23-0514',
  'love-23-1114',
  'love-24-0517',
  'love-24-1114',
  'love-extra-25-0426',
  'love-26-0313',
] as const;

/** solis `lifecycle.go` `EpisodeIDPrefix`. */
export function episodeIdPrefix(loveId: string): string {
  return 'love-event-story-' + loveId.replace(/^love-extra-/, '') + '-';
}

/** solis `routes.go` `FirstEpisodeID`. */
export function firstEpisodeId(loveId: string): string {
  return episodeIdPrefix(loveId) + '001';
}

export function supportedLoveIds(): string[] {
  return [...SUPPORTED_LOVE_IDS];
}

const configCache = new Map<string, EventConfig>();
const routesCache = new Map<string, Routes>();

function readJson(kind: 'catalog' | 'routes', loveId: string): unknown {
  const url = new URL(`./${kind}/${loveId}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(numberValue) : [];
}

function numberMap(value: unknown, loveId: string): Record<number, number> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new MoshikoiError('invalid-catalog', `invalid catalog for love event ${loveId}`);
  }
  const out: Record<number, number> = {};
  for (const [key, item] of Object.entries(value)) {
    const numericKey = Number(key);
    if (!Number.isInteger(numericKey) || typeof item !== 'number' || !Number.isFinite(item)) {
      throw new MoshikoiError('invalid-catalog', `invalid catalog for love event ${loveId}`);
    }
    out[numericKey] = item;
  }
  return out;
}

const EVENT_CONFIG_KEYS = [
  'loveId',
  'name',
  'description',
  'startTime',
  'unlockConditionId',
  'bannerAssetId',
  'characterId',
  'costumeId',
  'characterAssetId',
  'color',
  'storyReadItemId',
  'presentItemId',
  'promoteItemId',
  'presentFavorability',
  'lessonStepSeconds',
  'lessonMaxHours',
  'promoteHours',
  'eventMissionIds',
  'limitedEventMissionIds',
  'episodeUnlockLevels',
  'hintUnlockLevels',
  'assetId',
  'titleAssetId',
  'expAssetId',
  'simpleName',
  'baseType',
  'hideManagerVoiceSwitch',
  'mainCharacters',
] as const;

const MAIN_CHARACTER_KEYS = ['characterId', 'costumeId', 'assetId', 'color'] as const;

/**
 * The YAML loader uses `KnownFields(true)`, so unknown keys are load errors.
 * `promoteMinutes` is deliberately absent: solis tags it `yaml:"-"`.
 */
function assertKnownConfigFields(raw: Record<string, unknown>, loveId: string): void {
  for (const key of Object.keys(raw)) {
    if (!(EVENT_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new MoshikoiError(
        'unknown-catalog-field',
        `unknown catalog field ${key} for love event ${loveId}`,
      );
    }
  }
  const characters = raw.mainCharacters;
  if (characters === undefined) return;
  if (!Array.isArray(characters)) {
    throw new MoshikoiError('invalid-catalog', `invalid catalog for love event ${loveId}`);
  }
  for (const character of characters) {
    if (!isRecord(character)) {
      throw new MoshikoiError('invalid-heroine-catalog', `invalid heroine catalog for love event ${loveId}`);
    }
    for (const key of Object.keys(character)) {
      if (!(MAIN_CHARACTER_KEYS as readonly string[]).includes(key)) {
        throw new MoshikoiError(
          'unknown-catalog-field',
          `unknown catalog field ${key} for love event ${loveId}`,
        );
      }
    }
  }
}

function normalizeConfig(raw: Record<string, unknown>, loveId: string): EventConfig {
  const baseType = numberValue(raw.baseType);
  const characters = Array.isArray(raw.mainCharacters) ? raw.mainCharacters : [];
  return {
    loveId: stringValue(raw.loveId),
    name: stringValue(raw.name),
    description: stringValue(raw.description),
    startTime: numberValue(raw.startTime),
    unlockConditionId: stringValue(raw.unlockConditionId),
    bannerAssetId: stringValue(raw.bannerAssetId),
    characterId: stringValue(raw.characterId),
    costumeId: stringValue(raw.costumeId),
    characterAssetId: stringValue(raw.characterAssetId),
    color: stringValue(raw.color),
    storyReadItemId: stringValue(raw.storyReadItemId),
    presentItemId: stringValue(raw.presentItemId),
    promoteItemId: stringValue(raw.promoteItemId),
    lessonMaxHours: numberValue(raw.lessonMaxHours),
    eventMissionIds: stringArray(raw.eventMissionIds),
    limitedEventMissionIds: stringArray(raw.limitedEventMissionIds),
    episodeUnlockLevels: numberMap(raw.episodeUnlockLevels, loveId),
    hintUnlockLevels: numberMap(raw.hintUnlockLevels, loveId),
    assetId: stringValue(raw.assetId) || loveId,
    titleAssetId: stringValue(raw.titleAssetId),
    expAssetId: stringValue(raw.expAssetId) || `exp-${loveId}`,
    simpleName: stringValue(raw.simpleName) || 'もし恋',
    baseType: baseType === LOVE_BASE_TYPE.UNKNOWN ? LOVE_BASE_TYPE.STANDARD : baseType,
    hideManagerVoiceSwitch: booleanValue(raw.hideManagerVoiceSwitch),
    mainCharacters: characters.map((character) => {
      const item = isRecord(character) ? character : {};
      return {
        characterId: stringValue(item.characterId),
        costumeId: stringValue(item.costumeId),
        assetId: stringValue(item.assetId),
        color: stringValue(item.color),
      };
    }),
  };
}

/** Load and validate one event's server-owned configuration. */
export function loveConfig(loveId: string): EventConfig {
  const cached = configCache.get(loveId);
  if (cached) return cached;
  if (!(SUPPORTED_LOVE_IDS as readonly string[]).includes(loveId)) {
    // solis returns gRPC NotFound with this message.
    throw new MoshikoiError('love-event-not-available', 'love event is not available');
  }
  const raw = readJson('catalog', loveId);
  if (!isRecord(raw)) {
    throw new MoshikoiError('invalid-catalog', `invalid catalog for love event ${loveId}`);
  }
  assertKnownConfigFields(raw, loveId);
  const config = normalizeConfig(raw, loveId);

  if (
    config.loveId !== loveId ||
    config.name === '' ||
    (config.characterId === '' && config.mainCharacters.length === 0) ||
    config.storyReadItemId === '' ||
    (config.presentItemId === '' && config.baseType !== LOVE_BASE_TYPE.EXTRA) ||
    config.promoteItemId === '' ||
    config.startTime <= 0 ||
    config.lessonMaxHours <= 0 ||
    config.lessonMaxHours > 24 ||
    (config.baseType !== LOVE_BASE_TYPE.STANDARD && config.baseType !== LOVE_BASE_TYPE.EXTRA)
  ) {
    throw new MoshikoiError('invalid-catalog', `invalid catalog for love event ${loveId}`);
  }

  const seenCharacters = new Set<string>();
  for (const heroine of config.mainCharacters) {
    if (
      heroine.characterId === '' ||
      heroine.costumeId === '' ||
      heroine.assetId === '' ||
      heroine.color === '' ||
      seenCharacters.has(heroine.characterId)
    ) {
      throw new MoshikoiError('invalid-heroine-catalog', `invalid heroine catalog for love event ${loveId}`);
    }
    seenCharacters.add(heroine.characterId);
  }

  configCache.set(loveId, config);
  return config;
}

function normalizeCondition(raw: unknown): RouteCondition {
  const item = isRecord(raw) ? raw : {};
  return {
    episode: stringValue(item.episode),
    group: numberValue(item.group),
    choice: numberValue(item.choice),
  };
}

function normalizeConditions(raw: unknown): RouteCondition[] {
  return Array.isArray(raw) ? raw.map(normalizeCondition) : [];
}

function normalizeGroup(raw: unknown): RouteChoiceGroup {
  const item = isRecord(raw) ? raw : {};
  return {
    index: numberValue(item.index),
    count: numberValue(item.count),
    best: numberValue(item.best),
    scores: numberArray(item.scores),
    points: numberArray(item.points),
    requires: normalizeConditions(item.requires),
  };
}

function normalizeOutcome(raw: unknown): RouteOutcome {
  const item = isRecord(raw) ? raw : {};
  const outcome: RouteOutcome = {
    all: normalizeConditions(item.all),
    next: stringValue(item.next),
    ending: stringValue(item.ending),
  };
  if (typeof item.minPoints === 'number' && Number.isFinite(item.minPoints)) {
    outcome.minPoints = item.minPoints;
  }
  if (typeof item.maxPoints === 'number' && Number.isFinite(item.maxPoints)) {
    outcome.maxPoints = item.maxPoints;
  }
  return outcome;
}

function normalizeBranch(raw: unknown): RouteBranch {
  const item = isRecord(raw) ? raw : {};
  return {
    group: numberValue(item.group),
    match: numberValue(item.match),
    otherwise: numberValue(item.otherwise),
    all: normalizeConditions(item.all),
  };
}

function normalizeEpisode(raw: Record<string, unknown>): EpisodeRoute {
  return {
    groups: Array.isArray(raw.groups) ? raw.groups.map(normalizeGroup) : [],
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes.map(normalizeOutcome) : [],
    next: stringValue(raw.next),
    branches: Array.isArray(raw.branches) ? raw.branches.map(normalizeBranch) : [],
  };
}

function hasEpisode(routes: Routes, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(routes.episodes, id);
}

function validateConditions(
  routes: Routes,
  currentEpisode: string,
  conditions: RouteCondition[],
): void {
  for (const condition of conditions) {
    const id = condition.episode === '' ? currentEpisode : condition.episode;
    const episode = routes.episodes[id];
    if (episode === undefined) {
      throw new MoshikoiError('unknown-condition-episode', `unknown love condition episode ${id}`);
    }
    const group = episode.groups.find((candidate) => candidate.index === condition.group);
    if (group === undefined || condition.choice < 1 || condition.choice > group.count) {
      throw new MoshikoiError('invalid-condition-choice', `invalid love condition choice in ${id}`);
    }
  }
}

// JavaScript integers are exact only up to 2^53-1. Solis uses MaxInt64; the
// safe-integer bound is the faithful analogue for these overflow guards.
const MAX_INT = Number.MAX_SAFE_INTEGER;
const MIN_INT = Number.MIN_SAFE_INTEGER;

function validateRoutes(routes: Routes, loveId: string): void {
  if (
    routes.loveId !== loveId ||
    routes.episodes[firstEpisodeId(loveId)] === undefined ||
    routes.endings.length === 0
  ) {
    throw new MoshikoiError('invalid-route-catalog', `invalid route catalog for ${loveId}`);
  }

  const endings = new Set<string>();
  for (const ending of routes.endings) {
    if (ending.id === '' || ending.name === '' || ending.favorability < 0 || endings.has(ending.id)) {
      throw new MoshikoiError('invalid-ending', `invalid love ending ${ending.id}`);
    }
    endings.add(ending.id);
  }

  let scoreBound = 0;
  let pointBound = 0;
  const prefix = episodeIdPrefix(loveId);
  for (const [id, episode] of Object.entries(routes.episodes)) {
    if (!id.startsWith(prefix)) {
      throw new MoshikoiError('invalid-route-episode', `invalid love route episode ${id}`);
    }

    const groupIndexes = new Set<number>();
    for (const group of episode.groups) {
      if (
        group.index < 1 ||
        groupIndexes.has(group.index) ||
        group.count < 1 ||
        group.count > 100 ||
        group.count !== group.scores.length ||
        group.best < 0 ||
        group.best > group.count
      ) {
        throw new MoshikoiError('invalid-choice-group', `invalid choice group in ${id}`);
      }
      groupIndexes.add(group.index);
      if (group.points.length !== 0 && group.points.length !== group.count) {
        throw new MoshikoiError('invalid-route-point-choices', `invalid route point choices in ${id}`);
      }
      for (const points of group.points) {
        if (points < 0 || points > MAX_INT - pointBound) {
          throw new MoshikoiError(
            'invalid-or-overflowing-route-points',
            'invalid or overflowing love route points',
          );
        }
        pointBound += points;
      }
      for (let score of group.scores) {
        if (score === MIN_INT) {
          throw new MoshikoiError('love-route-score-overflows', 'love route score overflows');
        }
        if (score < 0) score = -score;
        if (score > Math.floor(MAX_INT / 4) - scoreBound) {
          throw new MoshikoiError('love-route-score-overflows', 'love route score overflows');
        }
        scoreBound += score;
      }
      validateConditions(routes, id, group.requires);
    }

    if (
      (episode.next !== '' && !hasEpisode(routes, episode.next)) ||
      (episode.next === '' && episode.outcomes.length === 0)
    ) {
      throw new MoshikoiError('invalid-next-episode', `invalid next love episode ${id}`);
    }

    for (const outcome of episode.outcomes) {
      if (
        (outcome.minPoints !== undefined && outcome.minPoints < 0) ||
        (outcome.maxPoints !== undefined && outcome.maxPoints < 0) ||
        (outcome.minPoints !== undefined &&
          outcome.maxPoints !== undefined &&
          outcome.minPoints > outcome.maxPoints)
      ) {
        throw new MoshikoiError('invalid-route-point-interval', `invalid route point interval in ${id}`);
      }
      if (
        (outcome.next === '') === (outcome.ending === '') ||
        (outcome.next !== '' && !hasEpisode(routes, outcome.next)) ||
        (outcome.ending !== '' && !endings.has(outcome.ending))
      ) {
        throw new MoshikoiError('invalid-outcome', `invalid outcome in ${id}`);
      }
      validateConditions(routes, id, outcome.all);
    }

    for (const branch of episode.branches) {
      if (branch.group < 1 || branch.match < 1 || branch.otherwise < 1) {
        throw new MoshikoiError('invalid-story-branch', `invalid story branch in ${id}`);
      }
      validateConditions(routes, id, branch.all);
    }
  }

  for (const target of Object.values(routes.endingConditions)) {
    if (!endings.has(target)) {
      throw new MoshikoiError(
        'unknown-ending-condition-target',
        `unknown ending condition target ${target}`,
      );
    }
  }
}

/** Load and validate one event's route map. */
export function loveRoutes(loveId: string): Routes {
  const cached = routesCache.get(loveId);
  if (cached) return cached;
  if (!(SUPPORTED_LOVE_IDS as readonly string[]).includes(loveId)) {
    throw new MoshikoiError('unsupported-love-route', `unsupported love route ${loveId}`);
  }

  const raw = readJson('routes', loveId);
  if (!isRecord(raw)) {
    throw new MoshikoiError('invalid-route-catalog', `invalid route catalog for ${loveId}`);
  }

  const episodes: Record<string, EpisodeRoute> = {};
  if (isRecord(raw.episodes)) {
    for (const [id, episode] of Object.entries(raw.episodes)) {
      if (!isRecord(episode)) {
        throw new MoshikoiError('invalid-route-episode', `invalid love route episode ${id}`);
      }
      episodes[id] = normalizeEpisode(episode);
    }
  }

  const endings = Array.isArray(raw.endings)
    ? raw.endings.map((rawEnding): Ending => {
        const ending = isRecord(rawEnding) ? rawEnding : {};
        return {
          id: stringValue(ending.id),
          name: stringValue(ending.name),
          endRollAssetId: stringValue(ending.endRollAssetId),
          favorability: numberValue(ending.favorability),
        };
      })
    : [];

  const endingConditions: Record<string, string> = {};
  if (isRecord(raw.endingConditions)) {
    for (const [id, target] of Object.entries(raw.endingConditions)) {
      endingConditions[id] = stringValue(target);
    }
  }

  const routes: Routes = {
    loveId: stringValue(raw.loveId),
    episodes,
    endings,
    endingConditions,
  };
  validateRoutes(routes, loveId);
  routesCache.set(loveId, routes);
  return routes;
}
