import { db } from '../db/client.ts';
import type { Executor } from '../db/tx.ts';
import { masterCharacter } from '../db/masterSchema.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { getSingleton, listElements, putSingleton } from './playerState.ts';

/**
 * Default profile favourites.
 *
 * The race board soft-locks when the player's `Profile.FavoriteCharacterIds` is
 * empty: at least one favourite idol must be set before the board renders. This
 * helper seeds three random main idols (master `Character.Type` 1) from the
 * player's owned roster the first time the profile is served, then leaves the
 * field alone so the picks stay stable until the player overwrites them via
 * `Profile:UpdateFavoriteCharacters`.
 */

const PROFILE_MSG = 'Solis.Common.Proto.Transaction.UserProfile';
const FAVORITE_COUNT = 3;

/** Master `Character.Type` of the main idols (the pickable favourites). */
const MAIN_IDOL_TYPE = 1;

/**
 * Draw up to `count` distinct entries from `pool`, removing each pick so the
 * result never repeats an id. Deterministic for a deterministic `rng`.
 */
function pickDistinct(pool: readonly string[], count: number, rng: () => number): string[] {
  const remaining = [...pool];
  const picked: string[] = [];
  while (picked.length < count && remaining.length > 0) {
    const raw = Math.floor(rng() * remaining.length);
    const index = Math.min(remaining.length - 1, Math.max(0, raw));
    picked.push(remaining.splice(index, 1)[0]);
  }
  return picked;
}

/** Sorted ids of every master character of the given `Type`. */
async function characterIdsOfType(exec: Executor, type: number): Promise<string[]> {
  const rows = await exec.select({ Id: masterCharacter.Id, Type: masterCharacter.Type }).from(masterCharacter);
  return rows
    .filter((row) => Number(row.Type ?? 0) === type)
    .map((row) => String(row.Id ?? ''))
    .filter(Boolean)
    .sort();
}

/**
 * Give `playerId` three random favourite idols when the profile has none.
 * Returns true when the profile was written, false when it already had at
 * least one non-empty favourite id (or no candidate character exists at all).
 */
export async function ensureDefaultFavoriteCharacters(
  playerId: string,
  exec: Executor = db,
  rng: () => number = Math.random,
): Promise<boolean> {
  const profile = (await getSingleton(playerId, 'Profile', exec)) ?? ({ __msg: PROFILE_MSG } as Decoded);
  const existing = ((profile.FavoriteCharacterIds as unknown[] | undefined) ?? [])
    .map((value) => String(value ?? ''))
    .filter(Boolean);
  if (existing.length > 0) return false;

  const owned = new Set(
    (await listElements(playerId, 'Characters', exec))
      .map((character) => String(character.CharacterId ?? ''))
      .filter(Boolean),
  );
  // Prefer owned main idols; fall back to every main idol so the field is
  // never left empty when the roster carries no Type-1 character at all.
  const mainIdols = await characterIdsOfType(exec, MAIN_IDOL_TYPE);
  const ownedMainIdols = mainIdols.filter((id) => owned.has(id));
  const pool = ownedMainIdols.length > 0 ? ownedMainIdols : mainIdols;
  if (pool.length === 0) return false;

  profile.FavoriteCharacterIds = pickDistinct(pool, FAVORITE_COUNT, rng);
  await putSingleton(playerId, 'Profile', profile, exec);
  return true;
}
