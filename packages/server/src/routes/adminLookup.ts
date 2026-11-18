/**
 * Read-only lookup lists for the admin editors (cards, items, marathon quests,
 * rewards and live-bonus groups).
 *
 * Every endpoint is viewer-gated and cached in memory for five minutes: these
 * are master-data lists that only change when a new master build is seeded.
 * Loaders are injectable so tests run without Postgres.
 */
import type { FastifyPluginAsync } from 'fastify';
import { enumValues } from '@sumire-sr/protocol/gen/enums.ts';
import {
  listAllMarathonLiveBonusGroupRows,
  listAllRewards,
  listCards,
  listItems,
  listLiveAbilities,
  listMarathonLiveBonusGroupRows,
  listMasterMarathons,
  listMarathonLiveBonuses,
  listMarathonQuests,
  listResourcesByType,
  listResourceNames,
  listRewardsByIds,
  listSkills,
} from '../master/index.ts';
import {
  parseInlineRewardRef,
  resourceTypeSnakeName,
  SUPPORTED_GRANT_TYPES,
} from '../master/reward.ts';
import { isValidAdminId } from '../services/ids.ts';
import { listEventDefinitionIds } from '../services/events/registry.ts';
import {
  ensureTranslationsLoaded,
  masterName,
  textName,
} from '../services/translations.ts';
import { requireAdmin, type AdminRouteDeps } from './admin.ts';

export const LOOKUP_TTL_MS = 5 * 60 * 1000;
/** Hard cap on per-event quest lists kept in memory. */
export const LOOKUP_QUEST_CACHE_MAX = 200;
/** Maximum number of ids accepted by the reward / live-bonus batch lookups. */
export const LOOKUP_IDS_MAX = 200;
export const LOOKUP_SEARCH_LIMIT = 50;
/** Default and maximum page size of the browse (`offset`/`limit`) modes. */
export const LOOKUP_BROWSE_LIMIT = 50;
export const LOOKUP_BROWSE_LIMIT_MAX = 100;
/** Maximum accepted length of a free-text `q` search string. */
export const LOOKUP_QUERY_MAX = 100;

/** A raw master row, before English names are attached. */
export interface LookupCardSource {
  id: string;
  name: string | null;
  rarity: number | null;
  characterId: string | null;
}

export interface LookupItemSource {
  id: string;
  name: string | null;
}

export interface LookupQuestSource {
  id: string;
  name: string | null;
  order: number | null;
}

/** API shapes: the master row plus its optional English translation. */
export interface LookupCard extends LookupCardSource {
  nameEn: string | null;
  characterNameEn: string | null;
}

export interface LookupItem extends LookupItemSource {
  nameEn: string | null;
}

export interface LookupQuest extends LookupQuestSource {
  nameEn: string | null;
}

/** Prefix-derived marathon variant; `other` for ids outside the known schemes. */
export type LookupMarathonVariant =
  | 'marathon'
  | 'marathon-raid'
  | 'mini-marathon'
  | 'mini-marathon-raid'
  | 'other';

/** One master marathon id before the variant / event-definition checks. */
export interface LookupMarathonSource {
  id: string;
  questCount: number;
  boxGachaCount: number;
}

export interface LookupMarathon extends LookupMarathonSource {
  variant: LookupMarathonVariant;
  /** An event definition with exactly this id exists. Computed per request. */
  eventDefined: boolean;
}

/** Variant of a marathon id, derived from its id prefix. */
export function marathonVariant(id: string): LookupMarathonVariant {
  if (id.startsWith('mini-marathon-raid-')) return 'mini-marathon-raid';
  if (id.startsWith('mini-marathon-')) return 'mini-marathon';
  if (id.startsWith('marathon-raid-')) return 'marathon-raid';
  if (id.startsWith('marathon-')) return 'marathon';
  return 'other';
}

/** One concrete grant of a reward, as stored in `master_Reward.Resources`. */
export interface RewardResourceSource {
  resourceType: number;
  resourceId: string;
  amount: number;
}

/** A `master_Reward` row (or an inline `rd_auto;...` reference) before naming. */
export interface LookupRewardRow {
  id: string;
  resources: RewardResourceSource[];
}

export interface LookupRewardResource extends RewardResourceSource {
  typeLabel: string;
  name: string | null;
  nameEn: string | null;
}

export interface LookupReward {
  id: string;
  resources: LookupRewardResource[];
  found: boolean;
}

/** A `master_MarathonLiveBonusGroup` row before the bonus chain is resolved. */
export interface LiveBonusGroupRowSource {
  groupId: string;
  liveBonusId: string | null;
}

/** A `master_MarathonLiveBonus` row. */
export interface LiveBonusRowSource {
  id: string;
  liveAbilityId: string | null;
  level: number | null;
}

export interface LiveAbilityLevelSource {
  Level?: number | null;
  Description?: string | null;
  SkillId?: string | null;
}

/** A `master_Skill` row; `Levels` holds one entry per skill level. */
export interface SkillLevelSource {
  Level?: number | null;
  Description?: string | null;
}

export interface SkillRowSource {
  id: string;
  name: string | null;
  levels: SkillLevelSource[] | null;
}

/** A `master_LiveAbility` row; `Levels` holds one entry per ability level. */
export interface LiveAbilityRowSource {
  id: string;
  levels: LiveAbilityLevelSource[] | null;
}

/** One skill behind a live bonus level, resolved through `SkillId`. */
export interface LookupLiveBonusSkill {
  skillId: string;
  name: string | null;
  nameEn: string | null;
  level: number | null;
  description: string | null;
  descriptionEn: string | null;
}

export interface LookupLiveBonus {
  liveBonusId: string;
  liveAbilityId: string;
  level: number | null;
  description: string | null;
  descriptionEn: string | null;
  /** Skills linked by the live ability level; empty when it has none. */
  skills: LookupLiveBonusSkill[];
}

export interface LookupLiveBonusGroup {
  groupId: string;
  bonuses: LookupLiveBonus[];
  found: boolean;
}

/** One resource type that appears in some reward. */
export interface LookupRewardType {
  resourceType: number;
  typeLabel: string;
  /** Snake-case name used by inline `rd_auto;...` references. */
  snakeName: string | null;
  /** Number of reward rows containing at least one grant of this type. */
  count: number;
  /** True when `applyGrants` can deliver this type (SUPPORTED_GRANT_TYPES). */
  grantable: boolean;
}

/** A name-table row, used by the custom-reward browser. */
export interface LookupResourceSource {
  id: string;
  name: string | null;
}

export interface LookupResource {
  resourceType: number;
  typeLabel: string;
  resourceId: string;
  name: string | null;
  nameEn: string | null;
}

/** Paged browse response (rewards, live-bonus groups, resources). */
export interface LookupBrowsePage<T> {
  items: T[];
  total: number;
}

export interface AdminLookupOptions {
  admin: Partial<AdminRouteDeps>;
  loadCards?: () => Promise<LookupCardSource[]>;
  loadItems?: () => Promise<LookupItemSource[]>;
  loadQuests?: (eventId: string) => Promise<LookupQuestSource[]>;
  /** Distinct marathon ids from the quest and box-gacha tables. */
  loadMarathons?: () => Promise<LookupMarathonSource[]>;
  /** Ids of every stored event definition (not cached; checked per request). */
  loadEventIds?: () => Promise<string[]>;
  /** Reward rows for an explicit id batch (missing ids are simply absent). */
  loadRewardRows?: (ids: string[]) => Promise<LookupRewardRow[]>;
  /** Every reward row, used by the reward id / resource-name search. */
  loadAllRewards?: () => Promise<LookupRewardRow[]>;
  /** Live-bonus group rows for an explicit group-id batch. */
  loadLiveBonusGroupRows?: (groupIds: string[]) => Promise<LiveBonusGroupRowSource[]>;
  /** Every live-bonus group row, used by the group search. */
  loadAllLiveBonusGroupRows?: () => Promise<LiveBonusGroupRowSource[]>;
  loadLiveBonusRows?: (ids: string[]) => Promise<LiveBonusRowSource[]>;
  loadLiveAbilityRows?: (ids: string[]) => Promise<LiveAbilityRowSource[]>;
  /** `master_Skill` rows referenced by live-ability levels. */
  loadSkillRows?: (ids: string[]) => Promise<SkillRowSource[]>;
  /** Every name-table row of one resource type (custom-reward browser). */
  loadResources?: (type: number) => Promise<LookupResourceSource[]>;
  /** Japanese display names of one resource type, keyed by resource id. */
  loadResourceNames?: (type: number, ids: string[]) => Promise<Map<string, string>>;
  /** Injectable clock (ms) and TTL for the cache. */
  now?: () => number;
  ttlMs?: number;
}

/** English name table per `ResourceType`; types absent here have no name. */
const RESOURCE_NAME_TABLES: Record<number, string> = {
  1: 'Item',
  2: 'Card',
  3: 'Accessory',
  4: 'Character',
  5: 'Costume',
  7: 'PhotoAllInOne',
  10: 'Story',
  12: 'Message',
  13: 'Telephone',
  17: 'Emblem',
  24: 'Card', // CardRarityExp: the resource id is a card id
  25: 'Card', // CardRarityExpLimitChange: the resource id is a card id
  27: 'PhotoRecipe',
  28: 'Hair',
  32: 'ShowcaseToy',
  33: 'Music',
  34: 'PhotoPose',
};

const RESOURCE_TYPE_NAMES: Record<number, string> =
  enumValues['Solis.Common.Proto.ResourceType'] ?? {};

/** Human-readable label for a resource type (`Item`, `Gold`, ...). */
export function resourceTypeLabel(type: number): string {
  return RESOURCE_TYPE_NAMES[type] ?? (type === 0 ? 'Unknown' : `Type ${type}`);
}

function resourceRows(value: unknown): RewardResourceSource[] {
  const list = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  return list.map((row) => ({
    resourceType: Number(row.ResourceType ?? 0),
    resourceId: row.ResourceId == null ? '' : String(row.ResourceId),
    amount: Number(row.Amount ?? 0),
  }));
}

async function loadCardsFromMaster(): Promise<LookupCardSource[]> {
  const rows = await listCards();
  return rows.map((row) => ({
    id: row.Id,
    name: row.Name ?? null,
    rarity: row.InitialRarity ?? null,
    characterId: row.CharacterId ?? null,
  }));
}

async function loadItemsFromMaster(): Promise<LookupItemSource[]> {
  const rows = await listItems();
  return rows.map((row) => ({ id: row.Id, name: row.Name ?? null }));
}

async function loadQuestsFromMaster(eventId: string): Promise<LookupQuestSource[]> {
  const rows = await listMarathonQuests(eventId);
  return rows.map((row) => ({ id: row.Id, name: row.Name ?? null, order: row.Order ?? null }));
}

async function loadMarathonsFromMaster(): Promise<LookupMarathonSource[]> {
  return listMasterMarathons();
}

async function loadRewardRowsFromMaster(ids: string[]): Promise<LookupRewardRow[]> {
  const rows = await listRewardsByIds(ids);
  return rows.map((row) => ({ id: row.Id, resources: resourceRows(row.Resources) }));
}

async function loadAllRewardRowsFromMaster(): Promise<LookupRewardRow[]> {
  const rows = await listAllRewards();
  return rows.map((row) => ({ id: row.Id, resources: resourceRows(row.Resources) }));
}

async function loadLiveBonusGroupRowsFromMaster(
  groupIds: string[],
): Promise<LiveBonusGroupRowSource[]> {
  const rows = await listMarathonLiveBonusGroupRows(groupIds);
  return rows.map((row) => ({ groupId: row.GroupId, liveBonusId: row.LiveBonusId ?? null }));
}

async function loadAllLiveBonusGroupRowsFromMaster(): Promise<LiveBonusGroupRowSource[]> {
  const rows = await listAllMarathonLiveBonusGroupRows();
  return rows.map((row) => ({ groupId: row.GroupId, liveBonusId: row.LiveBonusId ?? null }));
}

async function loadLiveBonusRowsFromMaster(ids: string[]): Promise<LiveBonusRowSource[]> {
  const rows = await listMarathonLiveBonuses(ids);
  return rows.map((row) => ({
    id: row.Id,
    liveAbilityId: row.LiveAbilityId ?? null,
    level: row.LiveAbilityLevel == null ? null : Number(row.LiveAbilityLevel),
  }));
}

async function loadLiveAbilityRowsFromMaster(ids: string[]): Promise<LiveAbilityRowSource[]> {
  const rows = await listLiveAbilities(ids);
  return rows.map((row) => ({
    id: row.Id,
    levels: Array.isArray(row.Levels) ? (row.Levels as LiveAbilityLevelSource[]) : null,
  }));
}

async function loadSkillRowsFromMaster(ids: string[]): Promise<SkillRowSource[]> {
  const rows = await listSkills(ids);
  return rows.map((row) => ({
    id: row.Id,
    name: row.Name ?? null,
    levels: Array.isArray(row.Levels) ? (row.Levels as SkillLevelSource[]) : null,
  }));
}

async function loadResourcesFromMaster(type: number): Promise<LookupResourceSource[]> {
  const rows = await listResourcesByType(type);
  return rows.map((row) => ({ id: row.Id, name: row.Name ?? null }));
}

/** Attach English names; a missing translation stays null (Japanese-only UI). */
function withCardNames(row: LookupCardSource): LookupCard {
  return {
    ...row,
    nameEn: masterName('Card', row.id) ?? null,
    characterNameEn:
      row.characterId === null
        ? null
        : (masterName('Character', row.characterId) ?? null),
  };
}

function withItemNames(row: LookupItemSource): LookupItem {
  return { ...row, nameEn: masterName('Item', row.id) ?? null };
}

function withQuestNames(row: LookupQuestSource): LookupQuest {
  return {
    ...row,
    nameEn:
      masterName('MarathonQuest', row.id) ??
      (row.name === null ? null : (textName(row.name) ?? null)),
  };
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/**
 * Wrap a whole-list loader in a TTL cache with single-flight loading: concurrent
 * cold callers share one in-flight promise, and a rejected load is never cached.
 */
function cached<T>(load: () => Promise<T>, now: () => number, ttlMs: number): () => Promise<T> {
  let entry: CacheEntry<T> | null = null;
  let inFlight: Promise<T> | null = null;
  return async () => {
    const current = now();
    if (entry !== null && entry.expiresAt > current) return entry.value;
    if (inFlight !== null) return inFlight;
    const pending = (async () => {
      const value = await load();
      entry = { expiresAt: current + ttlMs, value };
      return value;
    })();
    inFlight = pending;
    try {
      return await pending;
    } finally {
      inFlight = null;
    }
  };
}

function parseIdList(raw: string): string[] {
  const ids: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Browse-mode page size: defaults to 50 and is capped at 100. */
function parseBrowseLimit(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim() === '') return LOOKUP_BROWSE_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return LOOKUP_BROWSE_LIMIT;
  return Math.min(Math.floor(value), LOOKUP_BROWSE_LIMIT_MAX);
}

/** Browse-mode offset: a non-negative integer, defaulting to 0. */
function parseOffset(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Optional `type` filter; `undefined` keeps all types, bad input fails. */
function parseResourceType(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

type ResolvedReward = { id: string; found: boolean; grants: RewardResourceSource[] };

/**
 * Expand reward references the same way `parseRewardRef` does: inline
 * `rd_auto;...` references are parsed directly, master rows contribute their
 * `Resources`, and `Set` (999) entries are flattened one level with a loop
 * guard. `known` lets the caller pre-seed rows (the whole-list search path
 * needs no further DB reads).
 */
async function resolveRewards(
  ids: string[],
  loadRows: (ids: string[]) => Promise<LookupRewardRow[]>,
  known?: Map<string, LookupRewardRow | null>,
): Promise<ResolvedReward[]> {
  const rows = known ?? new Map<string, LookupRewardRow | null>();
  const fetched = new Set<string>(rows.keys());
  const results = new Map<string, ResolvedReward>();

  const prefetch = ids.filter((id) => parseInlineRewardRef(id) === null && !fetched.has(id));
  if (prefetch.length > 0) {
    for (const row of await loadRows(prefetch)) {
      rows.set(row.id, row);
      fetched.add(row.id);
    }
    for (const id of prefetch) fetched.add(id);
  }

  const resolve = async (id: string, depth: number): Promise<ResolvedReward> => {
    const cachedResult = results.get(id);
    if (cachedResult !== undefined) return cachedResult;

    const inline = parseInlineRewardRef(id);
    let resolved: ResolvedReward;
    if (inline !== null) {
      resolved = { id, found: inline.length > 0, grants: inline };
    } else {
      if (!fetched.has(id)) {
        for (const row of await loadRows([id])) rows.set(row.id, row);
        fetched.add(id);
      }
      const row = rows.get(id) ?? null;
      if (row === null) {
        resolved = { id, found: false, grants: [] };
      } else {
        const grants: RewardResourceSource[] = [];
        for (const resource of row.resources) {
          if (resource.resourceType === 999) {
            if (
              resource.resourceId !== '' &&
              resource.resourceId !== id &&
              depth < 4
            ) {
              const nested = await resolve(resource.resourceId, depth + 1);
              grants.push(...nested.grants);
            }
            continue;
          }
          if (resource.resourceType) grants.push(resource);
        }
        resolved = { id, found: true, grants };
      }
    }
    results.set(id, resolved);
    return resolved;
  };

  const out: ResolvedReward[] = [];
  for (const id of ids) out.push(await resolve(id, 0));
  return out;
}

/**
 * Expand one reward row's resources without async lookups, using a full row
 * map for `Set` references (search path).
 */
function expandRow(
  row: LookupRewardRow,
  allRows: Map<string, LookupRewardRow>,
): RewardResourceSource[] {
  const grants: RewardResourceSource[] = [];
  const walk = (current: LookupRewardRow, depth: number, seen: Set<string>): void => {
    for (const resource of current.resources) {
      if (resource.resourceType === 999) {
        if (resource.resourceId !== '' && !seen.has(resource.resourceId) && depth < 4) {
          const nested = allRows.get(resource.resourceId);
          if (nested !== undefined) {
            seen.add(resource.resourceId);
            walk(nested, depth + 1, seen);
          }
        }
        continue;
      }
      if (resource.resourceType) grants.push(resource);
    }
  };
  walk(row, 0, new Set([row.id]));
  return grants;
}

async function describeRewards(
  resolved: ResolvedReward[],
  loadNames: (type: number, ids: string[]) => Promise<Map<string, string>>,
): Promise<LookupReward[]> {
  const idsByType = new Map<number, Set<string>>();
  for (const reward of resolved) {
    for (const grant of reward.grants) {
      if (grant.resourceId === '') continue;
      const set = idsByType.get(grant.resourceType) ?? new Set<string>();
      set.add(grant.resourceId);
      idsByType.set(grant.resourceType, set);
    }
  }

  const names = new Map<string, string>();
  for (const [type, ids] of idsByType) {
    const found = await loadNames(type, [...ids]);
    for (const [id, name] of found) names.set(`${type}|${id}`, name);
  }

  return resolved.map((reward) => ({
    id: reward.id,
    found: reward.found,
    resources: reward.grants.map((grant) => {
      const table = RESOURCE_NAME_TABLES[grant.resourceType];
      return {
        resourceType: grant.resourceType,
        typeLabel: resourceTypeLabel(grant.resourceType),
        resourceId: grant.resourceId,
        amount: grant.amount,
        name: names.get(`${grant.resourceType}|${grant.resourceId}`) ?? null,
        nameEn:
          table !== undefined && grant.resourceId !== ''
            ? (masterName(table, grant.resourceId) ?? null)
            : null,
      };
    }),
  }));
}

interface ResolvedLiveBonusGroup {
  groupId: string;
  found: boolean;
  liveBonusIds: string[];
}

/**
 * Index of `level` inside a contiguous `Levels` array. English translation
 * keys are `levels[i]....` with i = array index, and master data stores
 * `Levels[i].Level === i + 1`, so the index is `level - 1` when the array is
 * not ordered or the level is absent.
 */
function levelIndexFor(
  level: number | null,
  levels: { Level?: number | null }[],
): number | null {
  if (level === null) return null;
  const found = levels.findIndex((entry) => Number(entry.Level ?? 0) === level);
  return found >= 0 ? found : level - 1;
}

async function describeLiveBonusGroups(
  groups: ResolvedLiveBonusGroup[],
  loadLiveBonusRows: (ids: string[]) => Promise<LiveBonusRowSource[]>,
  loadLiveAbilityRows: (ids: string[]) => Promise<LiveAbilityRowSource[]>,
  loadSkillRows: (ids: string[]) => Promise<SkillRowSource[]>,
): Promise<LookupLiveBonusGroup[]> {
  const bonusIds = [
    ...new Set(groups.flatMap((group) => group.liveBonusIds).filter((id) => id !== '')),
  ];
  const bonusRows = bonusIds.length > 0 ? await loadLiveBonusRows(bonusIds) : [];
  const bonusById = new Map(bonusRows.map((row) => [row.id, row]));

  const abilityIds = [
    ...new Set(bonusRows.map((row) => row.liveAbilityId ?? '').filter((id) => id !== '')),
  ];
  const abilityRows = abilityIds.length > 0 ? await loadLiveAbilityRows(abilityIds) : [];
  const abilityById = new Map(abilityRows.map((row) => [row.id, row]));

  // Live ability levels hold `SkillId`; collect the referenced master_Skill
  // rows in one batch. A level without SkillId simply has no linked skill.
  const skillIdByBonus = new Map<string, string>();
  for (const row of bonusRows) {
    const ability =
      row.liveAbilityId === null ? undefined : abilityById.get(row.liveAbilityId);
    const levels = ability?.levels ?? [];
    const index = levelIndexFor(row.level, levels);
    const skillId =
      index !== null && index >= 0 && index < levels.length
        ? (levels[index]?.SkillId ?? null)
        : null;
    if (skillId !== null && skillId !== '') skillIdByBonus.set(row.id, skillId);
  }
  const skillIds = [...new Set(skillIdByBonus.values())];
  const skillRows = skillIds.length > 0 ? await loadSkillRows(skillIds) : [];
  const skillById = new Map(skillRows.map((row) => [row.id, row]));

  return groups.map((group) => ({
    groupId: group.groupId,
    found: group.found,
    bonuses: group.liveBonusIds.map((liveBonusId) => {
      const row = bonusById.get(liveBonusId);
      if (row === undefined) {
        return {
          liveBonusId,
          liveAbilityId: '',
          level: null,
          description: null,
          descriptionEn: null,
          skills: [],
        };
      }
      const ability =
        row.liveAbilityId === null ? undefined : abilityById.get(row.liveAbilityId);
      const levels = ability?.levels ?? [];
      const index = levelIndexFor(row.level, levels);
      const description =
        index !== null && index >= 0 && index < levels.length
          ? (levels[index]?.Description ?? null)
          : null;
      const descriptionEn =
        index !== null && index >= 0 && row.liveAbilityId !== null
          ? (masterName('LiveAbility', row.liveAbilityId, `levels[${index}].description`) ??
            null)
          : null;

      const skillId = skillIdByBonus.get(liveBonusId);
      const skill = skillId === undefined ? undefined : skillById.get(skillId);
      let skills: LookupLiveBonusSkill[] = [];
      if (skillId !== undefined && skill !== undefined) {
        const skillLevels = skill.levels ?? [];
        const skillIndex = levelIndexFor(row.level, skillLevels);
        const skillLevel =
          skillIndex !== null && skillIndex >= 0 && skillIndex < skillLevels.length
            ? skillLevels[skillIndex]
            : null;
        skills = [
          {
            skillId,
            name: skill.name,
            nameEn: masterName('Skill', skillId) ?? null,
            level: skillLevel?.Level ?? row.level,
            description: skillLevel?.Description ?? null,
            descriptionEn:
              skillIndex !== null && skillIndex >= 0
                ? (masterName('Skill', skillId, `levels[${skillIndex}].description`) ??
                  null)
                : null,
          },
        ];
      }

      return {
        liveBonusId,
        liveAbilityId: row.liveAbilityId ?? '',
        level: row.level,
        description,
        descriptionEn,
        skills,
      };
    }),
  }));
}

export const adminLookupRoutes: FastifyPluginAsync<AdminLookupOptions> = async (app, opts) => {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? LOOKUP_TTL_MS;

  const loadCards = cached(opts.loadCards ?? loadCardsFromMaster, now, ttlMs);
  const loadItems = cached(opts.loadItems ?? loadItemsFromMaster, now, ttlMs);
  // Master marathon ids are static per build, so they share the lookup TTL;
  // event-defined checks stay per request because definitions change at runtime.
  const loadMarathons = cached(opts.loadMarathons ?? loadMarathonsFromMaster, now, ttlMs);
  const loadEventIds = opts.loadEventIds ?? listEventDefinitionIds;

  // Quest ids are per marathon event, so the cache is keyed by event id.
  const questLoader = opts.loadQuests ?? loadQuestsFromMaster;
  const questCache = new Map<string, CacheEntry<LookupQuestSource[]>>();
  const loadQuests = async (eventId: string): Promise<LookupQuestSource[]> => {
    const current = now();
    const entry = questCache.get(eventId);
    if (entry !== undefined) {
      if (entry.expiresAt > current) return entry.value;
      // Drop the stale row before reloading so the map cannot keep dead keys.
      questCache.delete(eventId);
    }
    const value = await questLoader(eventId);
    if (questCache.size >= LOOKUP_QUEST_CACHE_MAX) {
      const oldest = questCache.keys().next().value;
      if (oldest !== undefined) questCache.delete(oldest);
    }
    questCache.set(eventId, { expiresAt: current + ttlMs, value });
    return value;
  };

  const loadRewardRows = opts.loadRewardRows ?? loadRewardRowsFromMaster;
  const loadAllRewardRows = cached(
    opts.loadAllRewards ?? loadAllRewardRowsFromMaster,
    now,
    ttlMs,
  );
  const loadNames = opts.loadResourceNames ?? listResourceNames;

  const loadAllLiveBonusGroupRows = cached(
    opts.loadAllLiveBonusGroupRows ?? loadAllLiveBonusGroupRowsFromMaster,
    now,
    ttlMs,
  );
  const loadGroupRows = opts.loadLiveBonusGroupRows ?? loadLiveBonusGroupRowsFromMaster;
  const loadLiveBonusRows = opts.loadLiveBonusRows ?? loadLiveBonusRowsFromMaster;
  const loadLiveAbilityRows = opts.loadLiveAbilityRows ?? loadLiveAbilityRowsFromMaster;

  const loadSkillRows = opts.loadSkillRows ?? loadSkillRowsFromMaster;
  const loadResourceRows = opts.loadResources ?? loadResourcesFromMaster;

  // Per-type cache of name-table rows for the custom-reward browser. Each
  // type keeps its own `cached()` loader, so concurrent cold callers share one
  // in-flight load and a rejected load is never cached.
  const resourceCache = new Map<number, () => Promise<LookupResourceSource[]>>();
  const loadResources = (type: number): Promise<LookupResourceSource[]> => {
    let loader = resourceCache.get(type);
    if (loader === undefined) {
      loader = cached(() => loadResourceRows(type), now, ttlMs);
      resourceCache.set(type, loader);
    }
    return loader();
  };

  // Search/browse index: reward ids plus their resolved JP/EN resource names,
  // the set of types they contain, and a primary type + name for sorting.
  const loadRewardSearchIndex = cached(async () => {
    const rows = await loadAllRewardRows();
    const allRows = new Map(rows.map((row) => [row.id, row]));
    const entries = rows.map((row) => ({ id: row.id, grants: expandRow(row, allRows) }));

    const idsByType = new Map<number, Set<string>>();
    for (const entry of entries) {
      for (const grant of entry.grants) {
        if (grant.resourceId === '') continue;
        const set = idsByType.get(grant.resourceType) ?? new Set<string>();
        set.add(grant.resourceId);
        idsByType.set(grant.resourceType, set);
      }
    }
    const names = new Map<string, string>();
    for (const [type, ids] of idsByType) {
      const found = await loadNames(type, [...ids]);
      for (const [id, name] of found) names.set(`${type}|${id}`, name);
    }

    const indexed = entries.map((entry) => {
      const parts = [entry.id];
      const types = new Set<number>();
      let primaryType: number | null = null;
      let primaryName = '';
      for (const grant of entry.grants) {
        if (grant.resourceType !== 999) types.add(grant.resourceType);
        const name = names.get(`${grant.resourceType}|${grant.resourceId}`);
        if (name !== undefined) parts.push(name);
        const table = RESOURCE_NAME_TABLES[grant.resourceType];
        let nameEn: string | null = null;
        if (table !== undefined && grant.resourceId !== '') {
          nameEn = masterName(table, grant.resourceId) ?? null;
          if (nameEn !== null) parts.push(nameEn);
        }
        if (grant.resourceType === 999) continue;
        if (
          primaryType === null ||
          grant.resourceType < primaryType ||
          (grant.resourceType === primaryType &&
            (nameEn ?? name ?? '') < primaryName)
        ) {
          primaryType = grant.resourceType;
          primaryName = (nameEn ?? name ?? '').toLowerCase();
        }
      }
      return {
        ...entry,
        types: [...types].sort((a, b) => a - b),
        primaryType,
        primaryName,
        haystack: parts.join(' ').toLowerCase(),
      };
    });

    // Browse order: type, then English name, then id.
    return indexed.sort((a, b) => {
      const typeA = a.primaryType ?? Number.MAX_SAFE_INTEGER;
      const typeB = b.primaryType ?? Number.MAX_SAFE_INTEGER;
      if (typeA !== typeB) return typeA - typeB;
      if (a.primaryName !== b.primaryName) return a.primaryName < b.primaryName ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, now, ttlMs);

  const loadAllLiveBonusGroups = cached(async () => {
    const rows = await loadAllLiveBonusGroupRows();
    const byGroup = new Map<string, string[]>();
    const foundGroups = new Set<string>();
    for (const row of rows) {
      foundGroups.add(row.groupId);
      if (row.liveBonusId === null) continue;
      const list = byGroup.get(row.groupId) ?? [];
      list.push(row.liveBonusId);
      byGroup.set(row.groupId, list);
    }
    const groups: ResolvedLiveBonusGroup[] = [...foundGroups].map((groupId) => ({
      groupId,
      found: true,
      liveBonusIds: byGroup.get(groupId) ?? [],
    }));
    return describeLiveBonusGroups(
      groups,
      loadLiveBonusRows,
      loadLiveAbilityRows,
      loadSkillRows,
    );
  }, now, ttlMs);

  const viewer = requireAdmin('viewer', opts.admin);

  app.get('/sumire/admin/lookup/cards', { preHandler: viewer }, async () => {
    const rows = await loadCards();
    await ensureTranslationsLoaded();
    return rows.map(withCardNames);
  });
  app.get('/sumire/admin/lookup/items', { preHandler: viewer }, async () => {
    const rows = await loadItems();
    await ensureTranslationsLoaded();
    return rows.map(withItemNames);
  });
  app.get('/sumire/admin/lookup/quests', { preHandler: viewer }, async (req, reply) => {
    const { eventId } = req.query as { eventId?: unknown };
    if (typeof eventId !== 'string' || eventId === '') {
      return reply.code(400).send({ error: 'eventId is required' });
    }
    if (!isValidAdminId(eventId)) {
      return reply.code(400).send({ error: 'invalid eventId' });
    }
    const rows = await loadQuests(eventId);
    await ensureTranslationsLoaded();
    return rows.map(withQuestNames);
  });

  app.get('/sumire/admin/lookup/marathons', { preHandler: viewer }, async () => {
    const [rows, eventIds] = await Promise.all([loadMarathons(), loadEventIds()]);
    const defined = new Set(eventIds);
    return rows
      .map((row) => ({
        id: row.id,
        variant: marathonVariant(row.id),
        questCount: row.questCount,
        boxGachaCount: row.boxGachaCount,
        eventDefined: defined.has(row.id),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  });

  app.get('/sumire/admin/lookup/rewards', { preHandler: viewer }, async (req, reply) => {
    const { ids, q, type, offset, limit } = req.query as {
      ids?: unknown;
      q?: unknown;
      type?: unknown;
      offset?: unknown;
      limit?: unknown;
    };

    if (typeof ids === 'string') {
      const idList = parseIdList(ids);
      if (idList.length === 0) return reply.code(400).send({ error: 'ids is required' });
      if (idList.length > LOOKUP_IDS_MAX) {
        return reply.code(400).send({ error: `at most ${LOOKUP_IDS_MAX} ids` });
      }
      await ensureTranslationsLoaded();
      const resolved = await resolveRewards(idList, loadRewardRows);
      return describeRewards(resolved, loadNames);
    }

    if (typeof q === 'string' && q.length > LOOKUP_QUERY_MAX) {
      return reply.code(400).send({ error: 'q too long' });
    }
    const resourceType = parseResourceType(type);
    if (resourceType === null) return reply.code(400).send({ error: 'invalid type' });

    await ensureTranslationsLoaded();
    const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
    const entries = await loadRewardSearchIndex();
    const filtered = entries.filter(
      (entry) =>
        (resourceType === undefined || entry.types.includes(resourceType)) &&
        (needle === '' || entry.haystack.includes(needle)),
    );
    const start = parseOffset(offset);
    const page = filtered.slice(start, start + parseBrowseLimit(limit));
    const resolved: ResolvedReward[] = page.map((entry) => ({
      id: entry.id,
      found: true,
      grants: entry.grants,
    }));
    return {
      items: await describeRewards(resolved, loadNames),
      total: filtered.length,
    } satisfies LookupBrowsePage<LookupReward>;
  });

  app.get('/sumire/admin/lookup/resource-types', { preHandler: viewer }, async () => {
    await ensureTranslationsLoaded();
    const entries = await loadRewardSearchIndex();
    const counts = new Map<number, number>();
    for (const entry of entries) {
      for (const resourceType of entry.types) {
        counts.set(resourceType, (counts.get(resourceType) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([resourceType, count]) => ({
        resourceType,
        typeLabel: resourceTypeLabel(resourceType),
        snakeName: resourceTypeSnakeName(resourceType),
        count,
        grantable: SUPPORTED_GRANT_TYPES.has(resourceType),
      })) satisfies LookupRewardType[];
  });

  app.get('/sumire/admin/lookup/resources', { preHandler: viewer }, async (req, reply) => {
    const { type, q, offset, limit } = req.query as {
      type?: unknown;
      q?: unknown;
      offset?: unknown;
      limit?: unknown;
    };
    const resourceType = parseResourceType(type);
    if (resourceType === undefined) {
      return reply.code(400).send({ error: 'type is required' });
    }
    if (resourceType === null) return reply.code(400).send({ error: 'invalid type' });
    if (typeof q === 'string' && q.length > LOOKUP_QUERY_MAX) {
      return reply.code(400).send({ error: 'q too long' });
    }

    await ensureTranslationsLoaded();
    const table = RESOURCE_NAME_TABLES[resourceType];
    const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
    const rows = await loadResources(resourceType);
    const described = rows
      .map((row) => ({
        resourceType,
        typeLabel: resourceTypeLabel(resourceType),
        resourceId: row.id,
        name: row.name,
        nameEn: table === undefined ? null : (masterName(table, row.id) ?? null),
      }))
      .filter(
        (row) =>
          needle === '' ||
          row.resourceId.toLowerCase().includes(needle) ||
          (row.name ?? '').toLowerCase().includes(needle) ||
          (row.nameEn ?? '').toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        const nameA = (a.nameEn ?? a.name ?? '').toLowerCase();
        const nameB = (b.nameEn ?? b.name ?? '').toLowerCase();
        if (nameA !== nameB) return nameA < nameB ? -1 : 1;
        return a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0;
      });

    const start = parseOffset(offset);
    return {
      items: described.slice(start, start + parseBrowseLimit(limit)),
      total: described.length,
    } satisfies LookupBrowsePage<LookupResource>;
  });

  app.get(
    '/sumire/admin/lookup/live-bonus-groups',
    { preHandler: viewer },
    async (req, reply) => {
      const { ids, q, offset, limit } = req.query as {
        ids?: unknown;
        q?: unknown;
        offset?: unknown;
        limit?: unknown;
      };

      if (typeof ids === 'string') {
        const idList = parseIdList(ids);
        if (idList.length === 0) return reply.code(400).send({ error: 'ids is required' });
        if (idList.length > LOOKUP_IDS_MAX) {
          return reply.code(400).send({ error: `at most ${LOOKUP_IDS_MAX} ids` });
        }
        const rows = await loadGroupRows(idList);
        const requested = new Set(idList);
        const bonusesByGroup = new Map<string, string[]>();
        const foundGroups = new Set<string>();
        for (const row of rows) {
          if (!requested.has(row.groupId)) continue;
          foundGroups.add(row.groupId);
          if (row.liveBonusId === null) continue;
          const list = bonusesByGroup.get(row.groupId) ?? [];
          list.push(row.liveBonusId);
          bonusesByGroup.set(row.groupId, list);
        }
        await ensureTranslationsLoaded();
        const groups: ResolvedLiveBonusGroup[] = idList.map((groupId) => ({
          groupId,
          found: foundGroups.has(groupId),
          liveBonusIds: bonusesByGroup.get(groupId) ?? [],
        }));
        return describeLiveBonusGroups(
          groups,
          loadLiveBonusRows,
          loadLiveAbilityRows,
          loadSkillRows,
        );
      }

      // Browse mode: `q` is optional, so opening the panel and paging through
      // every group needs no query at all.
      if (typeof q === 'string' && q.length > LOOKUP_QUERY_MAX) {
        return reply.code(400).send({ error: 'q too long' });
      }
      const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
      await ensureTranslationsLoaded();
      const groups = await loadAllLiveBonusGroups();
      const matches =
        needle === ''
          ? groups
          : groups.filter(
              (group) =>
                group.groupId.toLowerCase().includes(needle) ||
                group.bonuses.some(
                  (bonus) =>
                    bonus.liveBonusId.toLowerCase().includes(needle) ||
                    bonus.liveAbilityId.toLowerCase().includes(needle) ||
                    (bonus.description ?? '').toLowerCase().includes(needle) ||
                    (bonus.descriptionEn ?? '').toLowerCase().includes(needle) ||
                    bonus.skills.some(
                      (skill) =>
                        skill.skillId.toLowerCase().includes(needle) ||
                        (skill.name ?? '').toLowerCase().includes(needle) ||
                        (skill.nameEn ?? '').toLowerCase().includes(needle) ||
                        (skill.description ?? '').toLowerCase().includes(needle) ||
                        (skill.descriptionEn ?? '').toLowerCase().includes(needle),
                    ),
                ),
            );
      const start = parseOffset(offset);
      return {
        items: matches.slice(start, start + parseBrowseLimit(limit)),
        total: matches.length,
      } satisfies LookupBrowsePage<LookupLiveBonusGroup>;
    },
  );
};
