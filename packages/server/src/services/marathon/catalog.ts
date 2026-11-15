/**
 * Marathon event catalog: one checked-in JSON file per authored event.
 *
 * The event is opt-in through `SUMIRE_MARATHON_ID`. Catalogues are server-owned
 * data (like the MoshiKoi catalogs) rather than master data because the event
 * window and the Home/Enter advertisement are not part of the master tables.
 * Times are derived from the current time by `marathonWindow`, never authored.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { npcRosters } from '../../live/data/npcRosters.ts';
import type { BoxDef, BoxItemDef } from './box.ts';

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

export interface MarathonWindow {
  startTime: number;
  endTime: number;
  exchangeEndTime: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT_DAYS = 15;
const EXCHANGE_DAYS = 7;

/** Catalog ids are event ids, matched against the `id` in each JSON file. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

const CATALOG_DIR = new URL('./catalog/', import.meta.url);
let catalogIndex: Map<string, MarathonConfig> | undefined;

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

/** Parse every checked-in catalogue once; file names need not match the event id. */
function catalog(): Map<string, MarathonConfig> {
  if (catalogIndex) return catalogIndex;

  const entries = new Map<string, MarathonConfig>();
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
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const config: MarathonConfig = {
      id: stringValue(record.id),
      name: stringValue(record.name),
      type: numberValue(record.type),
      assetId: stringValue(record.assetId),
      bannerAssetId: stringValue(record.bannerAssetId),
      boxGachaGroupId: stringValue(record.boxGachaGroupId),
      initialStamina: numberValue(record.initialStamina),
      staminaRecoveryMinutes: numberValue(record.staminaRecoveryMinutes),
      staminaRecoveryItemId: stringValue(record.staminaRecoveryItemId),
      questUnlockItemId: stringValue(record.questUnlockItemId),
      eventMissionId: stringValue(record.eventMissionId),
      order: numberValue(record.order),
      boxGachas: parseBoxGachas(stringValue(record.id), record.boxGachas),
      npcRosters: parseNpcRosters(stringValue(record.id), record.npcRosters),
      boxDrawMax: numberValue(record.boxDrawMax) > 0 ? numberValue(record.boxDrawMax) : undefined,
      boxInfiniteRate: parseBoxInfiniteRate(stringValue(record.id), record.boxInfiniteRate),
    };
    if (config.id === '') continue;
    entries.set(config.id, config);
  }

  catalogIndex = entries;
  return entries;
}

/**
 * Load one authored event. Returns `undefined` when the id has no catalog entry
 * (or the file is unreadable/invalid), so callers can treat it as "not served".
 */
export function marathonConfig(id: string): MarathonConfig | undefined {
  if (!SAFE_ID.test(id) || id === '.' || id === '..') return undefined;
  return catalog().get(id);
}

/**
 * The event advertised by Home:Enter and served by Marathon:Top. The variable is
 * read per call (like `registrationMode()`) so tests can switch it in-process.
 */
export function activeMarathon(): MarathonConfig | undefined {
  const id = process.env.SUMIRE_MARATHON_ID?.trim();
  if (!id) return undefined;
  return marathonConfig(id);
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
