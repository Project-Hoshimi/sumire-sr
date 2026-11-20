/**
 * In-process NPC roster cache.
 *
 * The cache owns the DB-backed roster table: on startup it seeds every roster
 * from the checked-in `live/data/npcRosters.ts` constant (existing rows are
 * never modified), then loads all rows into a module-level map. Runtime lookups
 * are synchronous and fall back to the constant, so they keep working when the
 * DB is down or the cache was never loaded.
 *
 * Like the event registry, the Drizzle store is only imported by callers, so
 * importing this module never opens a DB connection.
 */
import { npcRosters, type NpcRoster, type NpcRosterCard } from '../../live/data/npcRosters.ts';
import { compiledEvents } from '../events/registry.ts';
import { isValidAdminId } from '../ids.ts';
import type { RosterStore, StoredRoster } from './store.ts';

let store: RosterStore | undefined;
let loaded = false;
let cache = new Map<string, StoredRoster>();
/** Tail of the serialized reload queue; resolved once nothing is pending. */
let reloadChain: Promise<void> = Promise.resolve();

function requireStore(): RosterStore {
  if (!store) throw new Error('roster cache: store is not initialized');
  return store;
}

/** Read every row from the store and swap the in-process map. */
async function doReloadRosterCache(): Promise<void> {
  const rows = await requireStore().listRosters();
  const next = new Map<string, StoredRoster>();
  for (const row of rows) next.set(row.id, row);
  cache = next;
}

/**
 * Reload the cache, serialized with any reload already in flight so overlapping
 * saves can never leave an older snapshot installed last.
 */
function reloadRosterCache(): Promise<void> {
  const run = reloadChain.then(() => doReloadRosterCache());
  reloadChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Seed the store with every checked-in roster (insert-only), then load all rows
 * into the cache and mark it loaded.
 */
export async function initRosterCache(opts: { store: RosterStore }): Promise<void> {
  store = opts.store;
  await store.insertMissing(npcRosters, 'seed');
  await reloadRosterCache();
  loaded = true;
}

/** True once `initRosterCache` has completed at least once. */
export function rosterCacheLoaded(): boolean {
  return loaded;
}

/**
 * The roster `id` from the cache, or from the checked-in constant when the
 * cache has no row (not loaded yet, DB down, or a roster never seeded). The
 * result is a clone, so callers can mutate it without touching the cache.
 */
export function rosterById(id: string): NpcRoster | undefined {
  const row = cache.get(id);
  if (row) return structuredClone(row.roster);
  const constant = npcRosters[id];
  return constant === undefined ? undefined : structuredClone(constant);
}

/** Every known roster id (cache ∪ checked-in constant), sorted. */
export function listRosterIds(): string[] {
  return [...new Set([...cache.keys(), ...Object.keys(npcRosters)])].sort();
}

/**
 * One stored roster with its metadata. Cache rows win; a roster that only
 * exists in the checked-in constant reports no editor and epoch time.
 */
export function rosterRecord(id: string): StoredRoster | undefined {
  const row = cache.get(id);
  if (row) return { ...row, roster: structuredClone(row.roster) };
  const constant = npcRosters[id];
  if (constant === undefined) return undefined;
  return { id, roster: structuredClone(constant), updatedBy: null, updatedAt: new Date(0) };
}

/** Every known roster with metadata, ordered by id. */
export function listRosterRecords(): StoredRoster[] {
  return listRosterIds().map((id) => rosterRecord(id) as StoredRoster);
}

/**
 * Ids are admin-authored and end up as DB text keys and export filenames, so
 * keep them short and limited to characters that are safe in both.
 */
export function isValidRosterId(id: string): boolean {
  return isValidAdminId(id);
}

/** A roster failed validation; routes map `errors` to a 400 body. */
export class NpcRosterValidationError extends Error {
  readonly rosterId: string;
  readonly errors: string[];

  constructor(rosterId: string, errors: string[]) {
    super(`NPC roster "${rosterId}" is invalid: ${errors.join('; ')}`);
    this.name = 'NpcRosterValidationError';
    this.rosterId = rosterId;
    this.errors = errors;
  }
}

/** Rarity range every authored roster uses; the master's rarities reach 10. */
const RARITY_MIN = 1;
const RARITY_MAX = 10;

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validate one roster; returns a list of human-readable problems (empty when
 * valid). `cardExists` (optional) additionally checks each card id against
 * whatever card master the caller has available.
 */
export function validateNpcRoster(
  roster: NpcRoster,
  opts: { cardExists?: (cardId: string) => boolean } = {},
): string[] {
  const errors: string[] = [];
  if (typeof roster.Name !== 'string' || roster.Name.trim() === '') {
    errors.push('Name must not be empty');
  }
  if (!isInteger(roster.ManagerLevel) || roster.ManagerLevel < 1) {
    errors.push('ManagerLevel must be an integer >= 1');
  }
  if (!Array.isArray(roster.Cards) || roster.Cards.length < 1 || roster.Cards.length > 5) {
    errors.push('Cards must contain 1 to 5 cards');
    return errors;
  }

  const positions = new Set<number>();
  roster.Cards.forEach((card: NpcRosterCard, index: number) => {
    const at = `Cards[${index}]`;
    if (typeof card !== 'object' || card === null) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (!isInteger(card.Position) || card.Position < 1 || card.Position > 5) {
      errors.push(`${at}.Position must be an integer 1 to 5`);
    } else if (positions.has(card.Position)) {
      errors.push(`${at}.Position ${card.Position} is used more than once`);
    } else {
      positions.add(card.Position);
    }
    if (!isInteger(card.Level) || card.Level < 1) {
      errors.push(`${at}.Level must be an integer >= 1`);
    }
    if (!isInteger(card.Rarity) || card.Rarity < RARITY_MIN || card.Rarity > RARITY_MAX) {
      errors.push(`${at}.Rarity must be an integer ${RARITY_MIN} to ${RARITY_MAX}`);
    }
    if (!isInteger(card.EvolutionLevel) || card.EvolutionLevel < 0) {
      errors.push(`${at}.EvolutionLevel must be an integer >= 0`);
    }
    if (!isFiniteNonNegative(card.LightFanAmount)) {
      errors.push(`${at}.LightFanAmount must be a finite number >= 0`);
    }
    if (!isFiniteNonNegative(card.MiddleFanAmount)) {
      errors.push(`${at}.MiddleFanAmount must be a finite number >= 0`);
    }
    if (!isFiniteNonNegative(card.HeavyFanAmount)) {
      errors.push(`${at}.HeavyFanAmount must be a finite number >= 0`);
    }
    if (typeof card.CardId !== 'string' || card.CardId === '') {
      errors.push(`${at}.CardId must not be empty`);
    } else if (opts.cardExists && !opts.cardExists(card.CardId)) {
      errors.push(`${at}.CardId "${card.CardId}" does not exist`);
    }
  });
  return errors;
}

/**
 * Validate and persist a roster, then reload the cache. Throws an Error listing
 * every validation problem when the roster is invalid.
 */
export async function saveNpcRoster(
  id: string,
  roster: NpcRoster,
  updatedBy: string | null,
): Promise<void> {
  const activeStore = requireStore();
  const errors = validateNpcRoster(roster);
  if (errors.length > 0) {
    throw new NpcRosterValidationError(id, errors);
  }
  await activeStore.upsertRoster(id, roster, updatedBy);
  await reloadRosterCache();
}

/**
 * Validate and insert a new roster, then reload the cache. Refuses an id that
 * already exists; a concurrent create is left to the store's unique violation
 * (the route maps that to 409).
 */
export async function createNpcRoster(
  id: string,
  roster: NpcRoster,
  updatedBy: string | null,
): Promise<void> {
  const activeStore = requireStore();
  const errors = validateNpcRoster(roster);
  if (errors.length > 0) {
    throw new NpcRosterValidationError(id, errors);
  }
  if (rosterRecord(id) !== undefined) {
    throw new Error(`NPC roster "${id}" already exists`);
  }
  await activeStore.insertRoster(id, structuredClone(roster), updatedBy);
  await reloadRosterCache();
}

/** Copy roster `fromId` to a new id `newId`; both ids must satisfy the usual rules. */
export async function duplicateNpcRoster(
  fromId: string,
  newId: string,
  updatedBy: string | null,
): Promise<void> {
  const source = rosterById(fromId);
  if (source === undefined) throw new Error(`NPC roster "${fromId}" not found`);
  if (rosterById(newId) !== undefined) throw new Error(`NPC roster "${newId}" already exists`);
  await saveNpcRoster(newId, structuredClone(source), updatedBy);
}

/**
 * Where roster `id` is used. A main-story quest picks its roster key by its own
 * quest id (`npcRosterQuestId(questId)` returns the quest id when the caller
 * gives no override), so a roster id that is also a main quest id is used by
 * that quest. Only ids authored in the checked-in constant are known main-quest
 * rosters; `questExists` lets a caller with master data confirm the quest.
 * Marathon usage is read from the compiled marathon configs in the event
 * registry (`npcRosters[questId] === id`).
 */
export function rosterUsage(
  id: string,
  opts: { questExists?: (questId: string) => boolean } = {},
): { quests: string[]; events: { eventId: string; questId: string }[] } {
  const quests: string[] = [];
  if (npcRosters[id] !== undefined) {
    const exists = opts.questExists ?? (() => true);
    if (exists(id)) quests.push(id);
  }

  const events: { eventId: string; questId: string }[] = [];
  for (const event of compiledEvents()) {
    if (event.kind !== 'marathon') continue;
    const rosters = (event.runtime as { npcRosters?: Record<string, string> }).npcRosters;
    if (!rosters) continue;
    for (const [questId, rosterId] of Object.entries(rosters)) {
      if (rosterId === id) events.push({ eventId: event.id, questId });
    }
  }
  events.sort((a, b) =>
    a.eventId === b.eventId
      ? a.questId < b.questId
        ? -1
        : a.questId > b.questId
          ? 1
          : 0
      : a.eventId < b.eventId
        ? -1
        : 1,
  );
  return { quests, events };
}

/** Clear all in-process state (and the store), for tests. */
export function resetRosterCacheForTests(): void {
  store = undefined;
  loaded = false;
  cache = new Map();
  reloadChain = Promise.resolve();
}
