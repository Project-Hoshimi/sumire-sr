import {
  getCard as getMasterCard,
  listCardEvolutionLevelReleases,
  listCardLevelReleases,
} from '../master/index.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Card level / evolution release model.
 *
 * A master `Card` does not carry its skills and abilities unconditionally: the
 * game unlocks them by card state, driven by `CardLevelRelease` (keyed on card
 * `Level`) and `CardEvolutionLevelRelease` (keyed on card `EvolutionLevel`).
 * Each row lists `Targets[] = { Type: CardLevelReleaseType, Number }`:
 *
 *   Type 1 Skill              Number = 1-based skill slot (1..4)
 *   Type 2 LiveAbility        Number = 1 (unlocks the card's LiveAbilityId)
 *   Type 3 ActivityAbility    Number = 1 (unlocks the card's ActivityAbilityId)
 *   Type 4 Story              Number = 1-based index into Card.Stories
 *   Type 7 Photo              Number = photo-equip slots added at that level
 *
 * The shared `card_level_release_1` group encodes the canonical schedule:
 *   Lv1  Skill#1 (+ Story#1, +2 photo slots)
 *   Lv20 Skill#2
 *   Lv30 LiveAbility + ActivityAbility
 *   Lv35 Story#2, Lv45 Story#3
 *   Lv65 +1 photo slot, Lv80 Skill#3, Lv105 +1 photo slot
 * The bond group `card_evolution_level_release_bond` unlocks Skill#4 at
 * EvolutionLevel 1 (used by the special `*-link-00` cards).
 *
 * The official server reflects this in `UserCard` by emitting only the
 * `SkillIdN` / `LiveAbilityId` / `ActivityAbilityId` of *unlocked* entries (a
 * skill below its unlock level is absent, i.e. shown greyed/locked by the
 * client), while the enhancement `SkillLevelN` / `*AbilityLevel` fields are
 * always present and default to 1. Verified against the captured official
 * `User:Get` (2026-09-14_a12r): a Lv1 card carries only `SkillId1`; a Lv41 card
 * carries `SkillId1`/`SkillId2` + `LiveAbilityId`; `SkillId3` is absent for all
 * (none reach Lv80).
 */

const CARD_RELEASE_TYPE_SKILL = 1;
const CARD_RELEASE_TYPE_LIVE_ABILITY = 2;
const CARD_RELEASE_TYPE_ACTIVITY_ABILITY = 3;
const CARD_RELEASE_TYPE_PHOTO = 7;

const SKILL_SLOTS = [1, 2, 3, 4] as const;

export type CardRelease = {
  /** Unlocked skill slots (1-based), including slot 4 from card evolution. */
  skillSlots: number[];
  liveAbility: boolean;
  activityAbility: boolean;
  /** Total photo-equip slots unlocked at this level. */
  photoEquipableCount: number;
};

/** A `CardLevelRelease` / `CardEvolutionLevelRelease` row. */
export type CardReleaseRow = {
  Level?: unknown;
  Targets?: unknown;
};

const EMPTY_RELEASE: CardRelease = {
  skillSlots: [],
  liveAbility: false,
  activityAbility: false,
  photoEquipableCount: 0,
};

/**
 * Pure release derivation from prefetched `CardLevelRelease` /
 * `CardEvolutionLevelRelease` rows. Exported so bulk callers (the sandbox
 * seeder) can prefetch the whole tables once instead of querying per card.
 */
export function cardReleaseFromRows(
  masterCard: Decoded | null | undefined,
  level: number,
  evolutionLevel: number,
  levelReleases: readonly CardReleaseRow[],
  evolutionReleases: readonly CardReleaseRow[],
): CardRelease {
  if (!masterCard) return EMPTY_RELEASE;

  const slots = new Set<number>();
  let liveAbility = false;
  let activityAbility = false;
  let photoEquipableCount = 0;

  for (const row of levelReleases) {
    if (Number(row.Level) > level) continue;
    for (const t of ((row.Targets as Decoded[] | null) ?? [])) {
      const type = Number(t.Type);
      if (type === CARD_RELEASE_TYPE_SKILL) slots.add(Number(t.Number));
      else if (type === CARD_RELEASE_TYPE_LIVE_ABILITY) liveAbility = true;
      else if (type === CARD_RELEASE_TYPE_ACTIVITY_ABILITY) activityAbility = true;
      else if (type === CARD_RELEASE_TYPE_PHOTO) photoEquipableCount += Number(t.Number);
    }
  }

  for (const row of evolutionReleases) {
    if (Number(row.Level) > evolutionLevel) continue;
    for (const t of ((row.Targets as Decoded[] | null) ?? [])) {
      if (Number(t.Type) === CARD_RELEASE_TYPE_SKILL) slots.add(Number(t.Number));
    }
  }

  return {
    skillSlots: [...slots].filter((n) => n >= 1 && n <= 4).sort((a, b) => a - b),
    liveAbility,
    activityAbility,
    photoEquipableCount,
  };
}

/**
 * Derive the unlock state for a card at a given level + evolution level. Pass
 * the already-fetched master card to avoid a second lookup.
 */
export async function cardReleaseForCard(
  masterCard: Decoded | null | undefined,
  level: number,
  evolutionLevel = 0,
): Promise<CardRelease> {
  if (!masterCard) return EMPTY_RELEASE;

  const levelReleaseId = String(masterCard.CardLevelReleaseId ?? '');
  const levelReleases = levelReleaseId ? await listCardLevelReleases(levelReleaseId) : [];

  const bondGroupId = String(masterCard.CardEvolutionLevelReleaseGroupId ?? '');
  const evolutionReleases = bondGroupId ? await listCardEvolutionLevelReleases(bondGroupId) : [];

  return cardReleaseFromRows(masterCard, level, evolutionLevel, levelReleases, evolutionReleases);
}

/** Highest enhancement level reachable at `cardLevel` (1 when the table is empty). */
export function maxEnhancementLevel(
  levels: readonly Record<string, unknown>[] | null | undefined,
  cardLevel: number,
): number {
  let max = 0;
  for (const row of levels ?? []) {
    const level = Number(row.Level ?? 0);
    if (level <= 0) continue;
    if (cardLevel < Number(row.RequiredCardLevel ?? 0)) continue;
    if (level > max) max = level;
  }
  return max || 1;
}

/** The `Levels[]` row for an exact enhancement level, if it exists. */
export function enhancementLevelRow(
  levels: readonly Record<string, unknown>[] | null | undefined,
  level: number,
): Record<string, unknown> | null {
  for (const row of levels ?? []) {
    if (Number(row.Level ?? 0) === level) return row;
  }
  return null;
}

function setIdFields(card: Decoded, idKey: string, baseKey: string, value: string, unlocked: boolean): void {
  if (unlocked && value) {
    card[idKey] = value;
    card[baseKey] = value;
  } else {
    delete card[idKey];
    delete card[baseKey];
  }
}

/**
 * Write the master-driven release fields onto a `UserCard` blob in place:
 * gated `SkillIdN`/`LiveAbilityId`/`ActivityAbilityId` (+ `Base*` mirrors) and
 * `PhotoEquipableCount`. Enhancement level fields default to 1 and are never
 * lowered. Locked entries have their id fields removed so the client shows them
 * unavailable.
 */
export function applyCardRelease(
  card: Decoded,
  masterCard: Decoded | null | undefined,
  release: CardRelease,
): void {
  const unlocked = new Set(release.skillSlots);
  for (const n of SKILL_SLOTS) {
    const masterSkill = String(masterCard?.[`SkillId${n}`] ?? '');
    setIdFields(card, `SkillId${n}`, `BaseSkillId${n}`, masterSkill, unlocked.has(n));
    card[`SkillLevel${n}`] = Number(card[`SkillLevel${n}`] ?? 0) || 1;
    card[`BaseSkillLevel${n}`] = Number(card[`BaseSkillLevel${n}`] ?? 0) || 1;
  }

  setIdFields(
    card,
    'LiveAbilityId',
    'BaseLiveAbilityId',
    String(masterCard?.LiveAbilityId ?? ''),
    release.liveAbility,
  );
  setIdFields(
    card,
    'ActivityAbilityId',
    'BaseActivityAbilityId',
    String(masterCard?.ActivityAbilityId ?? ''),
    release.activityAbility,
  );
  card.LiveAbilityLevel = Number(card.LiveAbilityLevel ?? 0) || 1;
  card.BaseLiveAbilityLevel = Number(card.BaseLiveAbilityLevel ?? 0) || 1;
  card.ActivityAbilityLevel = Number(card.ActivityAbilityLevel ?? 0) || 1;
  card.BaseActivityAbilityLevel = Number(card.BaseActivityAbilityLevel ?? 0) || 1;

  card.PhotoEquipableCount = release.photoEquipableCount;
  card.BasePhotoEquipableCount = release.photoEquipableCount;

  // Backfill the base mirrors the client reads for the level badge (BaseLevel)
  // and un-enhanced stats. Legacy cards built before these existed would show a
  // Lv0 badge; only fill when absent so correct values are never clobbered.
  card.BaseLevel ??= Number(card.Level ?? 1);
  card.BaseVocal ??= Number(card.Vocal ?? 0);
  card.BaseDance ??= Number(card.Dance ?? 0);
  card.BaseVisual ??= Number(card.Visual ?? 0);
  card.BaseStamina ??= Number(card.Stamina ?? 0);
  card.Mental ??= 100;
  card.Technique ??= 100;
  card.ObtainedTime ??= Date.now();
}

/** The release-relevant keys, in a fixed order, for cheap change detection. */
const RELEASE_KEYS: string[] = (() => {
  const keys: string[] = [];
  for (const n of SKILL_SLOTS) {
    keys.push(`SkillId${n}`, `BaseSkillId${n}`, `SkillLevel${n}`, `BaseSkillLevel${n}`);
  }
  keys.push(
    'LiveAbilityId',
    'BaseLiveAbilityId',
    'LiveAbilityLevel',
    'BaseLiveAbilityLevel',
    'ActivityAbilityId',
    'BaseActivityAbilityId',
    'ActivityAbilityLevel',
    'BaseActivityAbilityLevel',
    'PhotoEquipableCount',
    'BasePhotoEquipableCount',
    'BaseLevel',
    'BaseVocal',
    'BaseDance',
    'BaseVisual',
    'BaseStamina',
    'Mental',
    'Technique',
    'ObtainedTime',
  );
  return keys;
})();

function releaseSnapshot(card: Decoded): string {
  return JSON.stringify(RELEASE_KEYS.map((k) => card[k] ?? null));
}

/**
 * Fetch the master card, derive the release for the card's current level +
 * evolution level, and write the release fields in place. Returns `true` when
 * anything changed (so callers can persist an existing stored card).
 */
export async function syncCardRelease(card: Decoded): Promise<boolean> {
  const cardId = String(card.CardId ?? '');
  const masterCard = cardId ? await getMasterCard(cardId) : null;
  const before = releaseSnapshot(card);
  const release = await cardReleaseForCard(masterCard, Number(card.Level ?? 1), Number(card.EvolutionLevel ?? 0));
  applyCardRelease(card, masterCard, release);
  return releaseSnapshot(card) !== before;
}
