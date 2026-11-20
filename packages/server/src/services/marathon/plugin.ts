/**
 * Marathon event plugin.
 *
 * Owns the checked-in catalogue JSON format: it parses a draft, validates the
 * authored values, and compiles the runtime `MarathonConfig` that the marathon
 * services read. Event windows are still derived by `marathonWindow` in
 * `catalog.ts`; a draft may additionally carry an authored `schedule`, which is
 * import/export data for the phase-2 builder.
 */
import { rosterById } from '../rosters/cache.ts';
import { boxRateBudget } from './box.ts';
import type { BoxItemDef, CompiledBoxDef, CompiledBoxItemDef } from './box.ts';
import {
  registerEventPlugin,
  type EditorSchema,
  type EventPlugin,
  type EventScheduleInput,
  type StateImpact,
  type ValidationIssue,
} from '../events/plugin.ts';

export type NpcLevelRule = { fixedLevel: number } | { levelOffset: number };

export interface MarathonConfig {
  id: string;
  name: string;
  /** `Solis.Common.Proto.MarathonType`: 0 Unknown, 1 Normal, 2 Raid. */
  type: number;
  assetId: string;
  bannerAssetId: string;
  boxGachaGroupId: string;
  initialStamina: number;
  staminaRecoveryMinutes: number;
  staminaRecoveryItemId: string;
  questUnlockItemId: string;
  eventMissionId: string;
  order: number;
  /** Catalogue-authored box contents keyed by box gacha id. Miss = empty box. */
  boxGachas?: Record<string, CompiledBoxDef>;
  /**
   * Optional map from a marathon quest id to an existing `npcRosters` key. A
   * versus stage (difficulty `ClearScore` 0) has no roster id of its own, so this
   * lets the event reuse a configured opponent. Absent means current behaviour.
   */
  npcRosters?: Record<string, string>;
  /**
   * Per-quest NPC level overrides, only for quests that author one. `fixedLevel`
   * pins the opponent level; `levelOffset` shifts the difficulty level (clamped
   * to at least 1). Absent entries use the difficulty level unchanged.
   */
  npcLevelRules?: Record<string, NpcLevelRule>;
  /** Safety bound on draws per request for a box; callers default this to 100. */
  boxDrawMax?: number;
  // Chance that one box draw yields an infinite item while finite stock remains.
  boxInfiniteRate?: number;
}

/**
 * The authored marathon catalogue shape. Scalars are normalised by
 * `parseDraft`; the nested tables stay raw until `validate`/`compile` parse
 * them, so invalid entries can be reported as issues instead of aborting the
 * parse. A draft may also carry an optional authored `schedule`.
 */
export interface MarathonDraft {
  id: string;
  name: string;
  type: number;
  assetId: string;
  bannerAssetId: string;
  boxGachaGroupId: string;
  initialStamina: number;
  staminaRecoveryMinutes: number;
  staminaRecoveryItemId: string;
  questUnlockItemId: string;
  eventMissionId: string;
  order: number;
  /** Raw authored box table; `parseDraft` seeds missing itemKeys, `parseBoxGachas` validates it. */
  boxGachas?: unknown;
  /** Raw authored quest→roster table; parsed by `parseNpcRosters`. */
  npcRosters?: unknown;
  boxDrawMax?: number;
  /** Raw authored value; parsed by `parseBoxInfiniteRate`. */
  boxInfiniteRate?: unknown;
  schedule?: EventScheduleInput;
}

/** Catalog ids are event ids, matched against the `id` in each JSON file. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** The same id guard `marathonConfig` uses for catalogue lookups. */
export function isSafeMarathonId(id: string): boolean {
  return SAFE_ID.test(id) && id !== '.' && id !== '..';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate one authored box item. Catalogue mistakes must fail loudly: an
 * itemType 1 item needs a `rewardId`, an itemType 2 item needs a
 * `liveBonusGroupId`, and any other itemType is not understood.
 */
function validateBoxItem(marathonId: string, boxId: string, item: BoxItemDef): void {
  const rate = item.rate as unknown;
  if (rate !== undefined) {
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      throw new Error(
        `marathon catalog ${marathonId}: box ${boxId} item ${item.order} rate must be a finite number`,
      );
    }
    if (rate <= 0 || rate > 1) {
      throw new Error(
        `marathon catalog ${marathonId}: box ${boxId} item ${item.order} rate must be in (0, 1]`,
      );
    }
    if (item.isLimited !== true) {
      throw new Error(
        `marathon catalog ${marathonId}: box ${boxId} item ${item.order} rate is only allowed on a limited item`,
      );
    }
  }
  if (item.itemType === 1) {
    if (item.rewardId === undefined || item.rewardId === '') {
      throw new Error(
        `marathon catalog ${marathonId}: box ${boxId} item ${item.order} needs a rewardId`,
      );
    }
    return;
  }
  if (item.itemType === 2) {
    if (item.liveBonusGroupId === undefined || item.liveBonusGroupId === '') {
      throw new Error(
        `marathon catalog ${marathonId}: box ${boxId} item ${item.order} needs a liveBonusGroupId`,
      );
    }
    return;
  }
  throw new Error(
    `marathon catalog ${marathonId}: box ${boxId} item ${item.order} has unknown itemType ${item.itemType}`,
  );
}

/** Parse the optional box infinite rate; present values must be numbers in [0, 1]. */
function parseBoxInfiniteRate(marathonId: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`marathon catalog ${marathonId}: boxInfiniteRate must be a number in [0, 1]`);
  }
  return value;
}

/**
 * Parse one authored `itemKey`. Absent means the item keeps the default stable
 * identity `String(order)`; a present key must be a non-empty string.
 */
function parseItemKey(marathonId: string, boxId: string, order: number, value: unknown): string {
  if (value === undefined) return String(order);
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `marathon catalog ${marathonId}: box ${boxId} item ${order} itemKey must be a non-empty string`,
    );
  }
  return value;
}

/**
 * Fill an absent `itemKey` on every item of a raw authored `boxGachas` table
 * with `String(order)`. Purely structural: nothing else is validated here, so
 * `validate` still reports malformed entries (an explicit empty or non-string
 * key reaches `parseItemKey` and fails loudly). Returns the input by reference
 * when every item already carries a key, which is what makes the startup
 * upgrade idempotent.
 */
function fillBoxItemKeys(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  let changed = false;
  const boxes: Record<string, unknown> = {};
  for (const [boxId, rawBox] of Object.entries(value)) {
    if (!isPlainObject(rawBox) || !Array.isArray(rawBox.items)) {
      boxes[boxId] = rawBox;
      continue;
    }
    const items = rawBox.items.map((rawItem: unknown) => {
      if (!isPlainObject(rawItem)) return rawItem;
      if (rawItem.itemKey !== undefined) return rawItem;
      changed = true;
      return { ...rawItem, itemKey: String(numberValue(rawItem.order)) };
    });
    boxes[boxId] = { ...rawBox, items };
  }
  return changed ? boxes : value;
}

/**
 * Plugin upgrade hook: persist the default `itemKey` on every box item of a
 * stored draft so player draw records never depend on the display order.
 * Returns null when the draft already carries every key.
 */
function upgradeDraft(raw: unknown): unknown | null {
  if (!isPlainObject(raw)) return null;
  const boxGachas = fillBoxItemKeys(raw.boxGachas);
  if (boxGachas === raw.boxGachas) return null;
  return { ...raw, boxGachas };
}

/** Parse the optional catalogue box table; malformed entries are skipped. */
function parseBoxGachas(
  marathonId: string,
  value: unknown,
): Record<string, CompiledBoxDef> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const boxes: Record<string, CompiledBoxDef> = {};
  for (const [boxId, rawBox] of Object.entries(value as Record<string, unknown>)) {
    if (boxId === '' || rawBox === null || typeof rawBox !== 'object' || Array.isArray(rawBox)) continue;
    const rawItems = (rawBox as Record<string, unknown>).items;
    const items: CompiledBoxItemDef[] = [];
    if (Array.isArray(rawItems)) {
      for (const rawItem of rawItems) {
        if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
        const item = rawItem as Record<string, unknown>;
        const order = numberValue(item.order);
        const rate = item.rate as unknown;
        const def: CompiledBoxItemDef = {
          order,
          itemKey: parseItemKey(marathonId, boxId, order, item.itemKey),
          itemType: numberValue(item.itemType),
          rewardId: optionalString(item.rewardId),
          liveBonusGroupId: optionalString(item.liveBonusGroupId),
          initialStock: numberValue(item.initialStock),
          isLimited: item.isLimited === true,
          isPickup: item.isPickup === true,
          ...(rate === undefined ? {} : { rate: rate as number }),
          assetId: optionalString(item.assetId),
          description: optionalString(item.description),
        };
        validateBoxItem(marathonId, boxId, def);
        items.push(def);
      }
    }
    const keys = new Set<string>();
    for (const def of items) {
      if (keys.has(def.itemKey)) {
        throw new Error(
          `marathon catalog ${marathonId}: box ${boxId} has duplicate itemKey "${def.itemKey}"`,
        );
      }
      keys.add(def.itemKey);
    }
    boxes[boxId] = { items };
  }
  return boxes;
}

/**
 * Parse the optional quest→roster table.  Each value is either a roster key or
 * an object `{ rosterId, fixedLevel?, levelOffset? }`; `fixedLevel` and
 * `levelOffset` are mutually exclusive. Every roster must exist; the catalog
 * carries no marathon quest ids, so keys are not checked here.
 */
function parseNpcRosterTable(
  marathonId: string,
  value: unknown,
): { rosters: Record<string, string>; levelRules: Record<string, NpcLevelRule> } | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`marathon catalog ${marathonId}: npcRosters must be an object`);
  }
  const rosters: Record<string, string> = {};
  const levelRules: Record<string, NpcLevelRule> = {};
  for (const [questId, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (questId === '') {
      throw new Error(`marathon catalog ${marathonId}: npcRosters has an empty quest id`);
    }

    let rosterId: string;
    let rule: NpcLevelRule | undefined;
    if (typeof rawValue === 'string') {
      rosterId = rawValue;
    } else if (isPlainObject(rawValue)) {
      const rawRosterId = rawValue.rosterId;
      if (typeof rawRosterId !== 'string' || rawRosterId === '') {
        throw new Error(
          `marathon catalog ${marathonId}: npcRosters["${questId}"].rosterId must be a roster key`,
        );
      }
      rosterId = rawRosterId;
      const { fixedLevel, levelOffset } = rawValue;
      if (fixedLevel !== undefined && levelOffset !== undefined) {
        throw new Error(
          `marathon catalog ${marathonId}: npcRosters["${questId}"] cannot have both fixedLevel and levelOffset`,
        );
      }
      if (fixedLevel !== undefined) {
        if (typeof fixedLevel !== 'number' || !Number.isInteger(fixedLevel) || fixedLevel < 1) {
          throw new Error(
            `marathon catalog ${marathonId}: npcRosters["${questId}"].fixedLevel must be an integer >= 1`,
          );
        }
        rule = { fixedLevel };
      } else if (levelOffset !== undefined) {
        if (typeof levelOffset !== 'number' || !Number.isInteger(levelOffset)) {
          throw new Error(
            `marathon catalog ${marathonId}: npcRosters["${questId}"].levelOffset must be an integer`,
          );
        }
        rule = { levelOffset };
      }
    } else {
      throw new Error(
        `marathon catalog ${marathonId}: npcRosters["${questId}"] must be a roster key or an object with a rosterId`,
      );
    }

    if (rosterId === '') {
      throw new Error(`marathon catalog ${marathonId}: npcRosters["${questId}"] must be a roster key`);
    }
    if (rosterById(rosterId) === undefined) {
      throw new Error(
        `marathon catalog ${marathonId}: npcRosters["${questId}"] names unknown roster "${rosterId}"`,
      );
    }
    rosters[questId] = rosterId;
    if (rule !== undefined) levelRules[questId] = rule;
  }
  return { rosters, levelRules };
}

/** Parse the authored `npcRosters` table into its quest→roster map. */
export function parseNpcRosters(marathonId: string, value: unknown): Record<string, string> | undefined {
  return parseNpcRosterTable(marathonId, value)?.rosters;
}

/** Parse the authored per-quest NPC level rules; only quests with a rule are returned. */
export function parseNpcLevelRules(
  marathonId: string,
  value: unknown,
): Record<string, NpcLevelRule> | undefined {
  return parseNpcRosterTable(marathonId, value)?.levelRules;
}

/**
 * The opponent level for one quest: a `fixedLevel` rule wins, a `levelOffset`
 * rule shifts the difficulty level and clamps it to at least 1, and a quest
 * without a rule keeps the difficulty level.
 */
export function npcLevelFor(
  config: { npcLevelRules?: Record<string, NpcLevelRule> },
  questId: string,
  difficultyLevel: number,
): number {
  const rule = config.npcLevelRules?.[questId];
  if (rule === undefined) return difficultyLevel;
  if ('fixedLevel' in rule) return rule.fixedLevel;
  return Math.max(1, difficultyLevel + rule.levelOffset);
}

function parseSchedule(value: unknown): EventScheduleInput | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error('marathon draft: schedule must be an object');
  }
  return {
    startsAt: stringValue(value.startsAt),
    endsAt: stringValue(value.endsAt),
    exchangeEndsAt: stringValue(value.exchangeEndsAt),
  };
}

/** ISO-8601 UTC timestamp to epoch milliseconds, or undefined when invalid. */
function scheduleMs(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Parse untyped catalog/DB JSON into a marathon draft. */
function parseDraft(raw: unknown): MarathonDraft {
  if (!isPlainObject(raw)) {
    throw new Error('marathon draft: expected a JSON object');
  }
  return {
    id: stringValue(raw.id),
    name: stringValue(raw.name),
    type: numberValue(raw.type),
    assetId: stringValue(raw.assetId),
    bannerAssetId: stringValue(raw.bannerAssetId),
    boxGachaGroupId: stringValue(raw.boxGachaGroupId),
    initialStamina: numberValue(raw.initialStamina),
    staminaRecoveryMinutes: numberValue(raw.staminaRecoveryMinutes),
    staminaRecoveryItemId: stringValue(raw.staminaRecoveryItemId),
    questUnlockItemId: stringValue(raw.questUnlockItemId),
    eventMissionId: stringValue(raw.eventMissionId),
    order: numberValue(raw.order),
    boxGachas: fillBoxItemKeys(raw.boxGachas),
    npcRosters: raw.npcRosters,
    boxDrawMax: numberValue(raw.boxDrawMax) > 0 ? numberValue(raw.boxDrawMax) : undefined,
    boxInfiniteRate: raw.boxInfiniteRate,
    schedule: parseSchedule(raw.schedule),
  };
}

function draftId(draft: MarathonDraft): string {
  return draft.id;
}

function draftTitle(draft: MarathonDraft): string {
  return draft.name;
}

function draftSchedule(draft: MarathonDraft): EventScheduleInput | undefined {
  return draft.schedule;
}

/** A rate as shown to authors: at most four decimals, trailing zeros trimmed. */
function displayRate(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

/**
 * Report every authoring mistake as an issue. The semantic checks are the ones
 * the catalog loader used to throw on, so a valid file compiles identically.
 */
function validate(draft: MarathonDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isSafeMarathonId(draft.id)) {
    issues.push({
      path: 'id',
      message: `marathon draft id "${draft.id}" must match ${SAFE_ID}`,
      severity: 'error',
    });
  }

  let parsedBoxes: Record<string, CompiledBoxDef> | undefined;
  try {
    parsedBoxes = parseBoxGachas(draft.id, draft.boxGachas);
  } catch (error) {
    issues.push({ path: 'boxGachas', message: (error as Error).message, severity: 'error' });
  }

  try {
    parseNpcRosters(draft.id, draft.npcRosters);
  } catch (error) {
    issues.push({ path: 'npcRosters', message: (error as Error).message, severity: 'error' });
  }

  let infiniteRate: number | undefined;
  let infiniteRateValid = true;
  try {
    infiniteRate = parseBoxInfiniteRate(draft.id, draft.boxInfiniteRate);
  } catch (error) {
    infiniteRateValid = false;
    issues.push({ path: 'boxInfiniteRate', message: (error as Error).message, severity: 'error' });
  }

  // Without a valid infinite rate the budget would be computed from a
  // fallback, so skip the rate-sum check rather than report a misleading
  // second error.
  if (parsedBoxes !== undefined && infiniteRateValid) {
    for (const [boxId, box] of Object.entries(parsedBoxes)) {
      const budget = boxRateBudget(box.items, infiniteRate);
      if (budget.assigned > budget.finiteBudget + 1e-9) {
        issues.push({
          path: `boxGachas.${boxId}`,
          message: `rates assigned ${displayRate(budget.assigned)} exceed the ${displayRate(
            budget.finiteBudget,
          )} available after box infinite rate ${displayRate(budget.pInf)}`,
          severity: 'error',
        });
      }
    }
  }

  if (draft.schedule) {
    const { startsAt, endsAt, exchangeEndsAt } = draft.schedule;
    const start = scheduleMs(startsAt);
    const end = scheduleMs(endsAt);
    const exchange = scheduleMs(exchangeEndsAt);
    if (start === undefined) {
      issues.push({
        path: 'schedule.startsAt',
        message: 'schedule.startsAt must be an ISO-8601 UTC timestamp',
        severity: 'error',
      });
    }
    if (end === undefined) {
      issues.push({
        path: 'schedule.endsAt',
        message: 'schedule.endsAt must be an ISO-8601 UTC timestamp',
        severity: 'error',
      });
    }
    if (exchange === undefined) {
      issues.push({
        path: 'schedule.exchangeEndsAt',
        message: 'schedule.exchangeEndsAt must be an ISO-8601 UTC timestamp',
        severity: 'error',
      });
    }
    if (start !== undefined && end !== undefined && exchange !== undefined) {
      if (!(start < end)) {
        issues.push({
          path: 'schedule',
          message: 'schedule.startsAt must be before schedule.endsAt',
          severity: 'error',
        });
      }
      if (!(end <= exchange)) {
        issues.push({
          path: 'schedule',
          message: 'schedule.endsAt must be on or before schedule.exchangeEndsAt',
          severity: 'error',
        });
      }
    }
  }

  return issues;
}

/** Compile a valid draft into the runtime config; same fields/defaults as the old loader. */
function compile(draft: MarathonDraft): MarathonConfig {
  const errors = validate(draft).filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    const detail = errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new Error(`marathon draft ${draft.id || '(no id)'}: ${detail}`);
  }
  return {
    id: draft.id,
    name: draft.name,
    type: draft.type,
    assetId: draft.assetId,
    bannerAssetId: draft.bannerAssetId,
    boxGachaGroupId: draft.boxGachaGroupId,
    initialStamina: draft.initialStamina,
    staminaRecoveryMinutes: draft.staminaRecoveryMinutes,
    staminaRecoveryItemId: draft.staminaRecoveryItemId,
    questUnlockItemId: draft.questUnlockItemId,
    eventMissionId: draft.eventMissionId,
    order: draft.order,
    boxGachas: parseBoxGachas(draft.id, draft.boxGachas),
    npcRosters: parseNpcRosters(draft.id, draft.npcRosters),
    npcLevelRules: parseNpcLevelRules(draft.id, draft.npcRosters),
    boxDrawMax: draft.boxDrawMax,
    boxInfiniteRate: parseBoxInfiniteRate(draft.id, draft.boxInfiniteRate),
  };
}

/** Minimal event-level draft with defaults that `compile` accepts. */
function defaultDraft(eventId: string): MarathonDraft {
  return {
    id: eventId,
    name: eventId,
    type: 1,
    assetId: '',
    bannerAssetId: '',
    boxGachaGroupId: '',
    initialStamina: 0,
    staminaRecoveryMinutes: 0,
    staminaRecoveryItemId: '',
    questUnlockItemId: '',
    eventMissionId: '',
    order: 0,
  };
}

async function importFromMaster(eventId: string): Promise<MarathonDraft> {
  // TODO(phase 2): import stages, box contents and NPC rosters from the master
  // rows. `listMarathonQuests(eventId)` exists in `src/master/index.ts`, but the
  // catalog draft has no stage-level field to store its rows in yet, so this
  // returns the event-level skeleton that compiles today.
  return defaultDraft(eventId);
}

/** Starting draft for a new admin-created definition: request id and title. */
function defaultDraftFor(id: string, title: string): MarathonDraft {
  return { ...defaultDraft(id), name: title };
}

interface AuthoredBoxItem {
  itemKey: string;
  itemType: number;
  rewardId?: string;
  liveBonusGroupId?: string;
  initialStock: number;
  /** true: finite stock; false: infinite, so its stock can never be lowered. */
  isLimited: boolean;
}

/** Read authored box items keyed by box id then itemKey; malformed entries are ignored. */
function authoredBoxes(value: unknown): Map<string, Map<string, AuthoredBoxItem>> {
  const boxes = new Map<string, Map<string, AuthoredBoxItem>>();
  if (!isPlainObject(value)) return boxes;
  for (const [boxId, rawBox] of Object.entries(value)) {
    const items = new Map<string, AuthoredBoxItem>();
    if (isPlainObject(rawBox) && Array.isArray(rawBox.items)) {
      for (const rawItem of rawBox.items) {
        if (!isPlainObject(rawItem)) continue;
        const order = numberValue(rawItem.order);
        const itemKey =
          typeof rawItem.itemKey === 'string' && rawItem.itemKey !== ''
            ? rawItem.itemKey
            : String(order);
        items.set(itemKey, {
          itemKey,
          itemType: numberValue(rawItem.itemType),
          rewardId: optionalString(rawItem.rewardId) || undefined,
          liveBonusGroupId: optionalString(rawItem.liveBonusGroupId) || undefined,
          initialStock: numberValue(rawItem.initialStock),
          isLimited: rawItem.isLimited === true,
        });
      }
    }
    boxes.set(boxId, items);
  }
  return boxes;
}

/**
 * One `block` impact for every raw authored box item that carries no explicit
 * non-empty `itemKey`. This must read the *unparsed* draft: `parseDraft` fills
 * an absent key with `String(order)` so saved draw counts stay stable, which
 * would otherwise hide the authoring mistake. Each impact blocks regardless of
 * the player count, so `requiresPlayerCheck` is false.
 */
function missingItemKeyImpacts(rawDraft: unknown): StateImpact[] {
  const impacts: StateImpact[] = [];
  if (!isPlainObject(rawDraft)) return impacts;
  const boxGachas = rawDraft.boxGachas;
  if (!isPlainObject(boxGachas)) return impacts;
  for (const [boxId, rawBox] of Object.entries(boxGachas)) {
    if (!isPlainObject(rawBox) || !Array.isArray(rawBox.items)) continue;
    for (const rawItem of rawBox.items) {
      if (!isPlainObject(rawItem)) continue;
      if (typeof rawItem.itemKey === 'string' && rawItem.itemKey !== '') continue;
      impacts.push({
        code: 'item-key-missing',
        severity: 'block',
        message: `box "${boxId}" item ${numberValue(rawItem.order)} has no explicit itemKey; set an explicit itemKey on every box item`,
        boxId,
        requiresPlayerCheck: false,
      });
    }
  }
  return impacts;
}

interface AuthoredRoster {
  rosterId: string;
  /** Canonical form of the optional level rule; '' when the quest authors none. */
  rule: string;
}

/** Read authored quest→roster entries; malformed entries are ignored. */
function authoredRosters(value: unknown): Map<string, AuthoredRoster> {
  const rosters = new Map<string, AuthoredRoster>();
  if (!isPlainObject(value)) return rosters;
  for (const [questId, rawValue] of Object.entries(value)) {
    if (typeof rawValue === 'string') {
      rosters.set(questId, { rosterId: rawValue, rule: '' });
      continue;
    }
    if (!isPlainObject(rawValue) || typeof rawValue.rosterId !== 'string') continue;
    const rule =
      typeof rawValue.fixedLevel === 'number'
        ? `fixedLevel:${rawValue.fixedLevel}`
        : typeof rawValue.levelOffset === 'number'
          ? `levelOffset:${rawValue.levelOffset}`
          : '';
    rosters.set(questId, { rosterId: rawValue.rosterId, rule });
  }
  return rosters;
}

function stateImpact(
  published: MarathonDraft | undefined,
  draft: MarathonDraft,
  rawDraft?: unknown,
): StateImpact[] {
  if (published === undefined) return [];
  const impacts: StateImpact[] = missingItemKeyImpacts(rawDraft);

  const publishedBoxes = authoredBoxes(published.boxGachas);
  const draftBoxes = authoredBoxes(draft.boxGachas);
  for (const [boxId, publishedItems] of publishedBoxes) {
    const draftItems = draftBoxes.get(boxId);
    if (draftItems === undefined) {
      impacts.push({
        code: 'box-removed',
        severity: 'block',
        message: `box "${boxId}" was removed but players may have drawn from it`,
        boxId,
        requiresPlayerCheck: true,
      });
      continue;
    }
    for (const [itemKey, item] of publishedItems) {
      const next = draftItems.get(itemKey);
      if (next === undefined) {
        impacts.push({
          code: 'item-removed',
          severity: item.isLimited ? 'block' : 'warn',
          message: item.isLimited
            ? `box "${boxId}" item "${itemKey}" was removed but players may have drawn it`
            : `box "${boxId}" item "${itemKey}" was removed (unlimited item)`,
          boxId,
          itemKey,
          requiresPlayerCheck: true,
        });
        continue;
      }
      if (next.isLimited !== item.isLimited) {
        impacts.push({
          code: 'limit-changed',
          severity: 'block',
          message: `box "${boxId}" item "${itemKey}" changed between limited and unlimited`,
          boxId,
          itemKey,
          requiresPlayerCheck: true,
        });
      }
      // Infinite items always report their authored stock, so lowering it has no effect.
      if (item.isLimited && next.isLimited && next.initialStock < item.initialStock) {
        impacts.push({
          code: 'stock-lowered',
          severity: 'block',
          message: `box "${boxId}" item "${itemKey}" stock dropped from ${item.initialStock} to ${next.initialStock}`,
          boxId,
          itemKey,
          newStock: next.initialStock,
          requiresPlayerCheck: true,
        });
      }
      if (
        next.itemType !== item.itemType ||
        next.rewardId !== item.rewardId ||
        next.liveBonusGroupId !== item.liveBonusGroupId
      ) {
        impacts.push({
          code: 'item-changed',
          severity: 'warn',
          message: `box "${boxId}" item "${itemKey}" changed its type or reward`,
          boxId,
          itemKey,
          requiresPlayerCheck: true,
        });
      }
    }
  }

  const publishedRosters = authoredRosters(published.npcRosters);
  const draftRosters = authoredRosters(draft.npcRosters);
  for (const [questId, current] of publishedRosters) {
    const next = draftRosters.get(questId);
    if (next === undefined) {
      impacts.push({
        code: 'stage-removed',
        severity: 'warn',
        message: `stage "${questId}" was removed`,
        questId,
        requiresPlayerCheck: false,
      });
      continue;
    }
    if (current.rosterId !== next.rosterId || current.rule !== next.rule) {
      impacts.push({
        code: 'roster-changed',
        severity: 'warn',
        message: `stage "${questId}" roster or level rule changed`,
        questId,
        requiresPlayerCheck: false,
      });
    }
  }

  return impacts;
}

const schema: EditorSchema = {
  fields: [
    { path: 'id', type: 'string', label: 'Event id', readOnly: true },
    { path: 'name', type: 'string', label: 'Name', readOnly: true },
    { path: 'type', type: 'number', label: 'Type (0 Unknown, 1 Normal, 2 Raid)', readOnly: true },
    { path: 'assetId', type: 'string', label: 'Asset id', readOnly: true },
    { path: 'bannerAssetId', type: 'string', label: 'Banner asset id', readOnly: true },
    { path: 'boxGachaGroupId', type: 'string', label: 'Box gacha group id', readOnly: true },
    { path: 'initialStamina', type: 'number', label: 'Initial stamina' },
    { path: 'staminaRecoveryMinutes', type: 'number', label: 'Stamina recovery minutes' },
    { path: 'staminaRecoveryItemId', type: 'string', label: 'Stamina recovery item id' },
    { path: 'questUnlockItemId', type: 'string', label: 'Quest unlock item id' },
    { path: 'eventMissionId', type: 'string', label: 'Event mission id', readOnly: true },
    { path: 'order', type: 'number', label: 'Order', readOnly: true },
    { path: 'boxGachas', type: 'object', label: 'Box gachas' },
    { path: 'npcRosters', type: 'object', label: 'NPC rosters (quest id → roster key)' },
    { path: 'boxDrawMax', type: 'number', label: 'Box draw max' },
    { path: 'boxInfiniteRate', type: 'number', label: 'Box infinite rate' },
    { path: 'schedule', type: 'object', label: 'Schedule (startsAt, endsAt, exchangeEndsAt)' },
  ],
};

export const marathonPlugin: EventPlugin<MarathonDraft, MarathonConfig> = {
  kind: 'marathon',
  schema,
  parseDraft,
  draftId,
  draftTitle,
  draftSchedule,
  importFromMaster,
  defaultDraft: defaultDraftFor,
  validate,
  compile,
  stateImpact,
  upgradeDraft,
};

registerEventPlugin(marathonPlugin);
