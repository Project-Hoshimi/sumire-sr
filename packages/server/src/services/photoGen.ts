import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import * as master from '../db/masterSchema.ts';
import { getItem, getPhotoAbility, getPhotoRarityLevelRange, getSetting, listItemsByType } from '../master/index.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { listElements, putElements } from './playerState.ts';

/**
 * Photo ability-set generation.
 *
 * Ported from the Solis reference server (`internal/viber/photo.go`:
 * Generate / RandomAbilities / genericSets / dedicatedSets /
 * ConfigureDedicatedPhotoAbility). There are two kinds of photo:
 *
 * - GENERAL (the default): no `CharacterIds`, so any idol can equip it. Its
 *   abilities come from a random generic PhotoAbilitySet of the rolled rarity.
 * - DEDICATED: `CharacterIds = [mainCharacterId]`, rarity 5, and the abilities
 *   come from that idol's dedicated PhotoAbilitySet. The first ability of a
 *   dedicated set is a passive that is gated behind manager level 80.
 */

const PHOTO_ABILITY_MSG = 'Solis.Common.Proto.Transaction.UserPhotoAbility';

/**
 * Chance (percent) that a max-level film whose roll came out rarity 5 produces a
 * dedicated photo instead of a general one. Tunable private-server guess; Solis
 * uses 1.
 */
export const DEDICATED_PHOTO_CHANCE_PERCENT = 1;

/** Mission that unlocks a dedicated photo's passive ability. */
export const DEDICATED_PHOTO_MISSION_ID = 'ms-photo-manager_level_achievement-80';

/** Manager level at which a dedicated photo's passive ability becomes available. */
export const DEDICATED_PHOTO_MIN_MANAGER_LEVEL = 80;

export type PhotoAbilitySetRow = {
  Id: string;
  PhotoAbilityIds: unknown;
  PhotoRarity: number | null;
};

export type PhotoKind = 'general' | 'dedicated';

/** Rarity of every dedicated photo. */
export const DEDICATED_PHOTO_RARITY = 5;

/**
 * Whether a PhotoAbilitySet id is an idol-specific (master `Limited`) set.
 *
 * The curated `master_PhotoAbilitySet` table drops the proto `Limited` flag, so
 * the id shape is the discriminator: dedicated sets are exactly
 * `pab-set-sk-phot-<short>-idol-<n>`, and no generic or recipe set carries
 * `-idol-`.
 */
function isLimitedSet(setId: string): boolean {
  return setId.includes('-idol-');
}

/** `char-smr` -> `smr` (dedicated set ids embed the character id without `char-`). */
function shortCharacterId(characterId: string): string {
  return characterId.replace(/^char-/, '');
}

/** Generic sets for `rarity`: master `Limited` not set, `pab-set-<rarity>-*`, no recipe sets. */
export async function genericSets(rarity: number): Promise<PhotoAbilitySetRow[]> {
  const prefix = `pab-set-${rarity}-`;
  const sets = await db
    .select({
      Id: master.masterPhotoAbilitySet.Id,
      PhotoAbilityIds: master.masterPhotoAbilitySet.PhotoAbilityIds,
      PhotoRarity: master.masterPhotoAbilitySet.PhotoRarity,
    })
    .from(master.masterPhotoAbilitySet)
    .where(eq(master.masterPhotoAbilitySet.PhotoRarity, rarity));
  return sets.filter((s) => !isLimitedSet(s.Id) && s.Id.startsWith(prefix) && !s.Id.includes('recipe'));
}

/** Dedicated sets for `characterId`: rarity 5 and `pab-set-...-<short>-idol-*`. */
export async function dedicatedSets(characterId: string): Promise<PhotoAbilitySetRow[]> {
  const short = shortCharacterId(characterId);
  if (!short) return [];
  const needle = `-${short}-idol-`;
  const sets = await db
    .select({
      Id: master.masterPhotoAbilitySet.Id,
      PhotoAbilityIds: master.masterPhotoAbilitySet.PhotoAbilityIds,
      PhotoRarity: master.masterPhotoAbilitySet.PhotoRarity,
    })
    .from(master.masterPhotoAbilitySet)
    .where(eq(master.masterPhotoAbilitySet.PhotoRarity, DEDICATED_PHOTO_RARITY));
  return sets.filter((s) => isLimitedSet(s.Id) && s.Id.includes(needle));
}

/** Pick a random set out of `sets`; null when there is nothing to pick. */
export function pickAbilitySet(
  sets: PhotoAbilitySetRow[],
  rng: () => number = Math.random,
): PhotoAbilitySetRow | null {
  if (!sets.length) return null;
  return sets[Math.floor(rng() * sets.length)] ?? sets[0];
}

/**
 * Decide whether a shot ends up dedicated. The character-only film always is;
 * otherwise only a level-9 film that rolled rarity 5 has a
 * `DEDICATED_PHOTO_CHANCE_PERCENT` chance, and only if the idol has dedicated
 * sets (otherwise the shot falls back to a general photo).
 */
export async function decidePhotoKind(opts: {
  characterOnlyFilm: boolean;
  filmLevel: number;
  rarity: number;
  characterId: string;
  rng?: () => number;
}): Promise<PhotoKind> {
  if (opts.characterOnlyFilm) return 'dedicated';
  if (opts.filmLevel < 9 || opts.rarity !== DEDICATED_PHOTO_RARITY) return 'general';
  const rng = opts.rng ?? Math.random;
  if (rng() * 100 >= DEDICATED_PHOTO_CHANCE_PERCENT) return 'general';
  return (await dedicatedSets(opts.characterId)).length ? 'dedicated' : 'general';
}

/** The player's manager level (stored on the `players` row, like `conditions.ts` reads it). */
export async function managerLevel(playerId: string, exec: Executor = db): Promise<number> {
  const [row] = await exec.select({ level: players.level }).from(players).where(eq(players.id, playerId)).limit(1);
  return Number(row?.level ?? 1);
}

type AbilityGrade = { Grade: number; BonusPermil?: number; BonusValue?: number };

/** A PhotoAbility's effect value at the given photo level and grade, as Solis
 *  computes it: the value of the highest PhotoAbilityLevel at or below `level`
 *  (the lowest one when `level` is below all), times the grade's BonusPermil/1000,
 *  plus its BonusValue. */
export function photoAbilityEffectValue(
  levels: Array<{ Level: number; Value: number }>,
  grades: AbilityGrade[],
  level: number,
  grade: number,
): number {
  if (!levels.length) return 0;
  const sorted = [...levels].sort((x, y) => x.Level - y.Level);
  let base = sorted[0].Value;
  for (const l of sorted) {
    if (l.Level <= level) base = l.Value;
    else break;
  }
  const g = grades.find((x) => Number(x.Grade) === grade);
  return Math.floor((base * Number(g?.BonusPermil ?? 1000)) / 1000) + Number(g?.BonusValue ?? 0);
}

/** Resolve every ability of `set` at `level`, each with a grade drawn uniformly
 *  from that ability's master grades (Solis does the same). */
export async function rollPhotoAbilities(
  set: PhotoAbilitySetRow,
  level: number,
  rng: () => number = Math.random,
): Promise<Decoded[]> {
  const ids = (set.PhotoAbilityIds as string[] | undefined) ?? [];
  const out: Decoded[] = [];
  for (const id of ids) {
    const a = await getPhotoAbility(id);
    const levels = (a?.PhotoAbilityLevels as Array<{ Level: number; Value: number }> | undefined) ?? [];
    const grades = (a?.PhotoAbilityGrades as AbilityGrade[] | undefined) ?? [];
    const grade = grades.length ? Number(grades[Math.floor(rng() * grades.length)].Grade) : 1;
    out.push({
      __msg: PHOTO_ABILITY_MSG,
      PhotoAbilityId: id,
      EffectValue: photoAbilityEffectValue(levels, grades, level, grade),
      Grade: grade,
      IsAvailable: true,
    } as Decoded);
  }
  return out;
}

/**
 * Dedicated photos gate their passive first ability behind manager level 80:
 * the ability keeps its mission id and is only available from level 80 up.
 * Every other ability stays available with no mission id.
 */
export function configureDedicatedAbilities(abilities: Decoded[], manager: number): void {
  const first = abilities[0];
  if (!first) return;
  if (!String(first.PhotoAbilityId ?? '').startsWith('pab-passive-skill_')) return;
  first.MissionId = DEDICATED_PHOTO_MISSION_ID;
  first.IsAvailable = manager >= DEDICATED_PHOTO_MIN_MANAGER_LEVEL;
}

/**
 * The photo detail screen looks up the player's UserMission for a gated
 * ability's MissionId and throws (NullReferenceException) when it is absent.
 * Solis keeps a row for every active mission; we create the gate mission's row
 * the first time a dedicated photo needs it. Returns the new row, or null when
 * the player already has one.
 */
export async function ensureDedicatedPhotoMission(playerId: string, exec: Executor = db): Promise<Decoded | null> {
  const missions = await listElements(playerId, 'Missions', exec);
  if (missions.some((m) => String(m.MissionId) === DEDICATED_PHOTO_MISSION_ID)) return null;
  const row = {
    __msg: 'Solis.Common.Proto.Transaction.UserMission',
    MissionId: DEDICATED_PHOTO_MISSION_ID,
    CurrentThreshold: 1,
    Progress: 0,
    StatusType: 1,
    LastUpdateTime: Date.now(),
  } as Decoded;
  await putElements(playerId, 'Missions', [row], exec);
  return row;
}

/**
 * Port of Solis `UnlockManagerLevelPhotoAbilities`: once the manager reaches
 * level 80, make every mission-gated dedicated ability available. Returns the
 * photos that changed (already saved).
 */
export async function unlockManagerLevelPhotoAbilities(
  playerId: string,
  manager: number,
  exec: Executor = db,
): Promise<Decoded[]> {
  if (manager < DEDICATED_PHOTO_MIN_MANAGER_LEVEL) return [];
  const changed: Decoded[] = [];
  for (const photo of await listElements(playerId, 'Photos', exec)) {
    let photoChanged = false;
    for (const ability of (photo.Abilities as Decoded[] | undefined) ?? []) {
      if (ability.MissionId === DEDICATED_PHOTO_MISSION_ID && !ability.IsAvailable) {
        ability.IsAvailable = true;
        photoChanged = true;
      }
    }
    if (photoChanged) changed.push(photo);
  }
  if (changed.length) await putElements(playerId, 'Photos', changed, exec);
  return changed;
}

/* -------------------------------------------------------------------------
 * Film rarity + quality model
 *
 * Ported from the Solis reference server (`internal/viber/photo.go`:
 * photoRarityPercentagesByMinimumRarity / NewPhotoGenerator / Generate /
 * randomRarity / randomLevel / qualityForFilmLevel / photoQualityFromDescription /
 * photoMaximumQualityFromDescription / photoNumberAfter). A shooting film rolls
 * a rarity (1..5) from its level and a photo quality (the photo's `Level`) from
 * its item Value plus its description.
 * ---------------------------------------------------------------------- */

/** `Solis.Common.Proto.ItemType.PhotoShooting` (src/gen/enums.ts). */
const ITEM_TYPE_PHOTO_SHOOTING = 11;
/** `Solis.Common.Proto.ItemType.PhotoShootingLevelChange` (src/gen/enums.ts). */
const ITEM_TYPE_PHOTO_SHOOTING_LEVEL_CHANGE = 13;

/**
 * Rarity weights (percent, each row totals 100) keyed by minimum rarity, i.e.
 * row N holds the odds for rarity N..5. These are Solis's tuning guesses, not
 * official rates (`photoRarityPercentagesByMinimumRarity`).
 */
export const PHOTO_RARITY_PERCENTAGES_BY_MINIMUM_RARITY: Record<number, number[]> = {
  1: [55, 25, 12, 6, 2],
  2: [60, 25, 10, 5],
  3: [70, 25, 5],
  4: [90, 10],
  5: [100],
};

/**
 * Quality jitter added to a non-fixed photo before rounding, chosen uniformly
 * (Solis `randomLevel`'s `{-10, -5, 0, 5, 10, 15}`).
 */
const PHOTO_QUALITY_JITTER = [-10, -5, 0, 5, 10, 15];

/**
 * `Setting.PhotoShootingItemThresholds` fallback. The curated `master_Setting`
 * table (src/db/masterSchema.ts) does not carry the proto field yet, so the
 * seeded DB row has no value and this list is always used for now. The values
 * match the A2 master dump (`phaseA2/out/structured/Setting.json` -> [1,4,7]).
 */
export const DEFAULT_PHOTO_SHOOTING_ITEM_THRESHOLDS = [1, 4, 7];

/** The film master fields the rarity/quality model reads. */
export type PhotoFilm = {
  Name?: string | null;
  Description?: string | null;
  Type?: number | null;
  Value?: number | null;
  IsPhotoShootingCharacterOnly?: boolean | null;
};

/** Master snapshot for the rarity/quality model (Solis `PhotoGenerator`). */
export type PhotoGenerationMaster = {
  /** Film level -> best quality stated in a PhotoShooting item description. */
  qualityAnchors: Map<number, number>;
  /** `Setting.PhotoShootingItemThresholds`, ascending. */
  thresholds: number[];
  minLevel: number;
  maxLevel: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read `Setting.PhotoShootingItemThresholds` when the Setting master exposes it,
 *  else `DEFAULT_PHOTO_SHOOTING_ITEM_THRESHOLDS`. */
export function photoShootingItemThresholds(setting: unknown): number[] {
  const raw = isRecord(setting) ? setting.PhotoShootingItemThresholds : undefined;
  if (Array.isArray(raw)) {
    const values = raw.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    if (values.length) return values.sort((a, b) => a - b);
  }
  return [...DEFAULT_PHOTO_SHOOTING_ITEM_THRESHOLDS];
}

/** Load the static masters the model needs. Cheap enough to load per shooting. */
export async function loadPhotoGenerationMaster(): Promise<PhotoGenerationMaster> {
  const [setting, films, range] = await Promise.all([
    getSetting(),
    listItemsByType(ITEM_TYPE_PHOTO_SHOOTING),
    getPhotoRarityLevelRange(),
  ]);
  const qualityAnchors = new Map<number, number>();
  for (const film of films) {
    const filmLevel = Number(film.Value ?? 0);
    const quality = photoQualityFromDescription(film.Description);
    if (filmLevel <= 0 || quality === null) continue;
    qualityAnchors.set(filmLevel, Math.max(qualityAnchors.get(filmLevel) ?? 0, quality));
  }
  return {
    qualityAnchors,
    thresholds: photoShootingItemThresholds(setting),
    minLevel: range?.min ?? 0,
    maxLevel: range?.max ?? 0,
  };
}

/** Minimum rarity for `filmLevel`: the count of thresholds it reaches (Solis
 *  `randomRarity`), clamped to 1..5. */
export function photoRarityMinimum(filmLevel: number, thresholds: number[]): number {
  const sorted = [...thresholds].sort((a, b) => a - b);
  let minimum = 1;
  sorted.forEach((threshold, index) => {
    if (filmLevel >= threshold) minimum = index + 1;
  });
  return Math.min(Math.max(minimum, 1), 5);
}

/** Roll a rarity (1..5) for `filmLevel` from the minimum-rarity weight table. */
export function rollPhotoRarity(
  filmLevel: number,
  thresholds: number[],
  rng: () => number = Math.random,
): number {
  const minimum = photoRarityMinimum(filmLevel, thresholds);
  const weights = PHOTO_RARITY_PERCENTAGES_BY_MINIMUM_RARITY[minimum] ?? [100];
  let draw = Math.floor(rng() * 100);
  for (let index = 0; index < weights.length; index++) {
    if (draw < weights[index]) return minimum + index;
    draw -= weights[index];
  }
  return 5;
}

/** Parse the decimal number that immediately follows `marker`; null when the
 *  marker is absent or is not followed by digits (Solis `photoNumberAfter`).
 *  The digits must be adjacent, so `高品質な` does not match `品質`. */
export function photoNumberAfter(value: string | null | undefined, marker: string): number | null {
  if (!value) return null;
  const index = value.indexOf(marker);
  if (index < 0) return null;
  const match = /^\d+/.exec(value.slice(index + marker.length));
  return match ? Number(match[0]) : null;
}

/** Quality stated in a description (`品質<digits>`). */
export function photoQualityFromDescription(description: string | null | undefined): number | null {
  return photoNumberAfter(description, '品質');
}

/** Maximum quality stated in a description (`最大品質:<digits>`). */
export function photoMaximumQualityFromDescription(
  description: string | null | undefined,
): number | null {
  return photoNumberAfter(description, '最大品質:');
}

/**
 * Quality for a film level from the master anchors (Solis
 * `qualityForFilmLevel`): an exact anchor wins; otherwise interpolate between
 * the nearest lower and upper anchors, extrapolate with +10 per level below the
 * anchors, -20 per level above them (floored at `minLevel`), or fall back to
 * `filmLevel * 20`.
 */
export function qualityForFilmLevel(
  filmLevel: number,
  anchors: Map<number, number>,
  minLevel: number,
): number {
  const exact = anchors.get(filmLevel);
  if (exact !== undefined) return exact;
  let lowerLevel = -1;
  let lowerQuality = 0;
  let upperLevel = Number.POSITIVE_INFINITY;
  let upperQuality = 0;
  for (const [level, quality] of anchors) {
    if (level < filmLevel && level > lowerLevel) {
      lowerLevel = level;
      lowerQuality = quality;
    }
    if (level > filmLevel && level < upperLevel) {
      upperLevel = level;
      upperQuality = quality;
    }
  }
  if (lowerLevel >= 0 && upperLevel < Number.POSITIVE_INFINITY) {
    return (
      lowerQuality +
      Math.trunc(((upperQuality - lowerQuality) * (filmLevel - lowerLevel)) / (upperLevel - lowerLevel))
    );
  }
  if (lowerLevel >= 0) return lowerQuality + 10 * (filmLevel - lowerLevel);
  if (upperLevel < Number.POSITIVE_INFINITY) {
    return Math.max(minLevel, upperQuality - 20 * (upperLevel - filmLevel));
  }
  return Math.max(minLevel, filmLevel * 20);
}

/** True when the film always produces a ★5 photo at a fixed quality: the
 *  `★5確定` marker in its name or the character-only flag (Solis `Generate`). */
export function isGuaranteedFiveStarFilm(film: PhotoFilm | null | undefined): boolean {
  return Boolean(film?.Name?.includes('★5確定')) || Boolean(film?.IsPhotoShootingCharacterOnly);
}

/**
 * Photo quality before jitter and rounding. The film level anchor can be
 * overridden by a `品質<digits>` in the film's own description, and a
 * PhotoShootingLevelChange film (the manager-level film) instead uses the
 * player's manager level capped by `最大品質:<digits>`.
 */
export function photoQualityBase(
  film: PhotoFilm | null | undefined,
  filmLevel: number,
  manager: number,
  anchors: Map<number, number>,
  minLevel: number,
): number {
  let base = qualityForFilmLevel(filmLevel, anchors, minLevel);
  const described = photoQualityFromDescription(film?.Description);
  if (described !== null) base = described;
  if (Number(film?.Type ?? 0) === ITEM_TYPE_PHOTO_SHOOTING_LEVEL_CHANGE) {
    const maximum = photoMaximumQualityFromDescription(film?.Description);
    base = maximum === null ? manager : Math.min(manager, maximum);
  }
  return base;
}

/** Roll a photo quality: the base above, plus jitter unless `fixed`, then round
 *  to the nearest 5 and clamp to the PhotoRarityLevel range (Solis
 *  `randomLevel`). */
export function rollPhotoQuality(opts: {
  film: PhotoFilm | null | undefined;
  filmLevel: number;
  managerLevel: number;
  fixed: boolean;
  anchors: Map<number, number>;
  minLevel: number;
  maxLevel: number;
  rng?: () => number;
}): number {
  const rng = opts.rng ?? Math.random;
  let base = photoQualityBase(opts.film, opts.filmLevel, opts.managerLevel, opts.anchors, opts.minLevel);
  if (!opts.fixed) {
    const jitter = PHOTO_QUALITY_JITTER[Math.floor(rng() * PHOTO_QUALITY_JITTER.length)] ?? 0;
    base += jitter;
  }
  base = Math.floor((base + 2) / 5) * 5;
  const lower = opts.minLevel > 0 ? opts.minLevel : Number.NEGATIVE_INFINITY;
  const upper = opts.maxLevel > 0 ? opts.maxLevel : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(base, lower), upper);
}

export type FilmPhotoTraits = {
  rarity: number;
  /** The photo's `Level`. */
  level: number;
  /** True for a guaranteed ★5 film, which skips rarity and quality rolls. */
  fixed: boolean;
};

/**
 * Roll the rarity and quality of one shot (Solis `Generate`). `filmLevel` is the
 * level resolved by the caller, so a shot with no film row (the tutorial) still
 * gets a quality. `rarity` forces the roll (album photos are always rarity 3);
 * the quality still comes from the film.
 */
export function rollFilmPhotoTraits(opts: {
  film: PhotoFilm | null | undefined;
  filmLevel: number;
  managerLevel: number;
  master: PhotoGenerationMaster;
  rarity?: number;
  rng?: () => number;
}): FilmPhotoTraits {
  const rng = opts.rng ?? Math.random;
  const fixed = isGuaranteedFiveStarFilm(opts.film);
  const rarity =
    opts.rarity ?? (fixed ? DEDICATED_PHOTO_RARITY : rollPhotoRarity(opts.filmLevel, opts.master.thresholds, rng));
  const level = rollPhotoQuality({
    film: opts.film,
    filmLevel: opts.filmLevel,
    managerLevel: opts.managerLevel,
    fixed,
    anchors: opts.master.qualityAnchors,
    minLevel: opts.master.minLevel,
    maxLevel: opts.master.maxLevel,
    rng,
  });
  return { rarity, level, fixed };
}

