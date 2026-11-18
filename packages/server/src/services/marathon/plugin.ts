/**
 * Marathon event plugin.
 *
 * Owns the checked-in catalogue JSON format: it parses a draft, validates the
 * authored values, and compiles the runtime `MarathonConfig` that the marathon
 * services read. Event windows are still derived by `marathonWindow` in
 * `catalog.ts`; a draft may additionally carry an authored `schedule`, which is
 * import/export data for the phase-2 builder.
 */
import { npcRosters } from '../../live/data/npcRosters.ts';
import type { BoxDef, BoxItemDef } from './box.ts';
import {
  registerEventPlugin,
  type EditorSchema,
  type EventPlugin,
  type EventScheduleInput,
  type StateImpact,
  type ValidationIssue,
} from '../events/plugin.ts';

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
  boxGachas?: Record<string, BoxDef>;
  /**
   * Optional map from a marathon quest id to an existing `npcRosters` key. A
   * versus stage (difficulty `ClearScore` 0) has no roster id of its own, so this
   * lets the event reuse a configured opponent. Absent means current behaviour.
   */
  npcRosters?: Record<string, string>;
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
  /** Raw authored box table; parsed by `parseBoxGachas`. */
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

/** Parse the optional catalogue box table; malformed entries are skipped. */
function parseBoxGachas(marathonId: string, value: unknown): Record<string, BoxDef> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const boxes: Record<string, BoxDef> = {};
  for (const [boxId, rawBox] of Object.entries(value as Record<string, unknown>)) {
    if (boxId === '' || rawBox === null || typeof rawBox !== 'object' || Array.isArray(rawBox)) continue;
    const rawItems = (rawBox as Record<string, unknown>).items;
    const items: BoxItemDef[] = [];
    if (Array.isArray(rawItems)) {
      for (const rawItem of rawItems) {
        if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
        const item = rawItem as Record<string, unknown>;
        const def: BoxItemDef = {
          order: numberValue(item.order),
          itemType: numberValue(item.itemType),
          rewardId: optionalString(item.rewardId),
          liveBonusGroupId: optionalString(item.liveBonusGroupId),
          initialStock: numberValue(item.initialStock),
          isLimited: item.isLimited === true,
          isPickup: item.isPickup === true,
          assetId: optionalString(item.assetId),
          description: optionalString(item.description),
        };
        validateBoxItem(marathonId, boxId, def);
        items.push(def);
      }
    }
    boxes[boxId] = { items };
  }
  return boxes;
}

/**
 * Parse the optional quest→roster table. Values must name a configured roster;
 * the catalog carries no marathon quest ids, so keys are not checked here.
 */
export function parseNpcRosters(marathonId: string, value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`marathon catalog ${marathonId}: npcRosters must be an object`);
  }
  const rosters: Record<string, string> = {};
  for (const [questId, rosterId] of Object.entries(value as Record<string, unknown>)) {
    if (questId === '') {
      throw new Error(`marathon catalog ${marathonId}: npcRosters has an empty quest id`);
    }
    if (typeof rosterId !== 'string' || rosterId === '') {
      throw new Error(`marathon catalog ${marathonId}: npcRosters["${questId}"] must be a roster key`);
    }
    if (npcRosters[rosterId] === undefined) {
      throw new Error(
        `marathon catalog ${marathonId}: npcRosters["${questId}"] names unknown roster "${rosterId}"`,
      );
    }
    rosters[questId] = rosterId;
  }
  return rosters;
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
    boxGachas: raw.boxGachas,
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

  try {
    parseBoxGachas(draft.id, draft.boxGachas);
  } catch (error) {
    issues.push({ path: 'boxGachas', message: (error as Error).message, severity: 'error' });
  }

  try {
    parseNpcRosters(draft.id, draft.npcRosters);
  } catch (error) {
    issues.push({ path: 'npcRosters', message: (error as Error).message, severity: 'error' });
  }

  try {
    parseBoxInfiniteRate(draft.id, draft.boxInfiniteRate);
  } catch (error) {
    issues.push({ path: 'boxInfiniteRate', message: (error as Error).message, severity: 'error' });
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

function stateImpact(_prev: MarathonDraft, _next: MarathonDraft): StateImpact[] {
  // phase 2: report box/stage edits that change saved player progress.
  return [];
}

const schema: EditorSchema = {
  fields: [
    { path: 'id', type: 'string', label: 'Event id' },
    { path: 'name', type: 'string', label: 'Name' },
    { path: 'type', type: 'number', label: 'Type (0 Unknown, 1 Normal, 2 Raid)' },
    { path: 'assetId', type: 'string', label: 'Asset id' },
    { path: 'bannerAssetId', type: 'string', label: 'Banner asset id' },
    { path: 'boxGachaGroupId', type: 'string', label: 'Box gacha group id' },
    { path: 'initialStamina', type: 'number', label: 'Initial stamina' },
    { path: 'staminaRecoveryMinutes', type: 'number', label: 'Stamina recovery minutes' },
    { path: 'staminaRecoveryItemId', type: 'string', label: 'Stamina recovery item id' },
    { path: 'questUnlockItemId', type: 'string', label: 'Quest unlock item id' },
    { path: 'eventMissionId', type: 'string', label: 'Event mission id' },
    { path: 'order', type: 'number', label: 'Order' },
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
  validate,
  compile,
  stateImpact,
};

registerEventPlugin(marathonPlugin);
