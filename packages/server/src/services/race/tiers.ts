// Area-quest (pt / medal) tier unlock rules.
//
// Race area quests start at `DifficultyNumber` 2 in the master data, so the
// plain "clear + 1" rule would leave a fresh player with nothing unlocked
// (1 exists for no quest). The rule implemented here is the one the client
// shows:
//
//   - the lowest existing tier of a quest is always unlocked;
//   - any other existing tier is unlocked once it is at most the smallest
//     existing tier strictly above the highest cleared tier;
//   - an existing tier is also unlocked when its `UnlockConditionId` is a
//     manager-level gate the player already satisfies (master `Condition`
//     `Settings` = `[{}, {ManagerLevel: {LevelGte}}]`: the empty setting is the
//     previous-clear rule above, the `ManagerLevel` one lets the player skip
//     ahead);
//   - a tier the quest does not define is never unlocked.
//
// Both `Race:Top`'s liveQuestInfos builder and `Race:StartLiveAreaQuest` share
// these helpers so the board and the RPC agree.
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Ascending, de-duplicated `DifficultyNumber`s of a quest's difficulty rows. */
export function tierNumbers(difficulties: readonly Decoded[]): number[] {
  const numbers = difficulties.map((row) => n(row.DifficultyNumber)).filter((number) => number > 0);
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** Number of `tiers` at or below `currentClear` (the cleared-tier count). */
export function clearedTierCountOf(tiers: readonly number[], currentClear: number): number {
  return tiers.filter((number) => number <= currentClear).length;
}

/** Number of existing tiers at or below `currentClear` (the cleared-tier count). */
export function clearedTierCount(difficulties: readonly Decoded[], currentClear: number): number {
  return clearedTierCountOf(tierNumbers(difficulties), currentClear);
}

/** Unlock signals a tier has besides the cleared-tier rule. */
export interface TierUnlockOptions {
  /**
   * Condition ids whose manager-level gate the player already satisfies.
   * Callers resolve these from the master `Condition` rows, so this module
   * stays free of database access.
   */
  managerLevelConditions?: ReadonlySet<string>;
}

/** `UnlockConditionId` of one tier, or `''` when the tier has none. */
function tierUnlockConditionId(difficulties: readonly Decoded[], difficultyNumber: number): string {
  const row = difficulties.find((difficulty) => n(difficulty.DifficultyNumber) === difficultyNumber);
  return row == null || row.UnlockConditionId == null ? '' : String(row.UnlockConditionId);
}

/** True when `difficultyNumber` may be played at `currentClear`. */
export function tierUnlocked(
  difficulties: readonly Decoded[],
  currentClear: number,
  difficultyNumber: number,
  options: TierUnlockOptions = {},
): boolean {
  const tiers = tierNumbers(difficulties);
  if (tiers.length === 0) return false;
  if (!tiers.includes(difficultyNumber)) return false;
  if (difficultyNumber === tiers[0]) return true;
  const cleared = tiers.filter((number) => number <= currentClear);
  if (cleared.length > 0) {
    const highestCleared = cleared[cleared.length - 1];
    const nextAbove = tiers.find((number) => number > highestCleared);
    if (nextAbove === undefined || difficultyNumber <= nextAbove) return true;
  }
  // Manager level: reaching the level in the tier's unlock condition opens it
  // without clearing the tier right below it.
  const conditionId = tierUnlockConditionId(difficulties, difficultyNumber);
  return conditionId !== '' && options.managerLevelConditions?.has(conditionId) === true;
}

/** The current tier to play: the highest cleared tier, or the lowest existing one. */
export function currentTier(difficulties: readonly Decoded[], currentClear: number): number {
  const tiers = tierNumbers(difficulties);
  if (tiers.length === 0) return 0;
  const cleared = tiers.filter((number) => number <= currentClear);
  if (cleared.length > 0) return cleared[cleared.length - 1];
  return tiers[0];
}

/**
 * Difficulty number to report as the player's clear level in
 * `RaceLiveQuestInfo`.
 *
 * The client derives the quest icon level from `NextLevel`
 * (= `CurrentClearDifficultyNumber`): it bumps the level by one when a tier
 * exists there, then looks the row up in its own master with
 * `RaceQuestDifficultyMaster.FindByKey(RaceQuestId, level)` and throws a
 * NullReferenceException when that row is missing
 * (`Solis.OutGame.RaceMainItemQuestButton.SetRaceLiveQuestInfo`,
 * phase3d/dump/dump.cs:335812). Area-quest tiers start at `DifficultyNumber` 2,
 * so a raw clear level of 0 has no row and crashes the race home for a fresh
 * player. Report the level just below the lowest tier (1 for pt / medal)
 * instead: the client then prefers the lowest tier. A level the client could
 * not resolve is clamped down to the closest existing tier.
 */
export function clientClearLevel(difficulties: readonly Decoded[], currentClear: number): number {
  const tiers = tierNumbers(difficulties);
  if (tiers.length === 0) return 0;
  const level = Math.max(currentClear, tiers[0] - 1);
  if (tiers.includes(level) || tiers.includes(level + 1)) return level;
  const below = tiers.filter((tier) => tier <= level);
  return below.length > 0 ? below[below.length - 1] : tiers[0];
}

/** Tier nearest to `wanted` that the quest actually defines (clamps out-of-range ids). */
export function nearestTier(difficulties: readonly Decoded[], wanted: number): number {
  const tiers = tierNumbers(difficulties);
  if (tiers.length === 0) return 0;
  if (tiers.includes(wanted)) return wanted;
  const below = tiers.filter((number) => number <= wanted);
  return below.length > 0 ? below[below.length - 1] : tiers[0];
}
