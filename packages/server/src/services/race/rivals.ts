// Opponent list of the race board (`RaceOpponentProgressInfo` rows).
//
// The board shows real players in the same race: the rank-1 players plus the
// players closest ahead of the caller, up to `config.rivals` (default 4). When
// those do not fill the list, the closest players behind the caller backfill the
// remaining rows, so tied players see each other and an outright leader sees the
// players chasing them. Only a player alone in the race sees their own row.
import { inArray } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import type { Executor } from '../../db/tx.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { listCharacters } from '../../master/index.ts';
import { isRivalCharacter, type RivalCharacter } from './botIdols.ts';
import { players } from '../../db/schema.ts';
import { publicUserIdOf } from '../friendLinks.ts';
import { getSingleton } from '../playerState.ts';
import { raceRanking } from './ranking.ts';
import type { RaceConfig } from './types.ts';
import type { RaceState } from './state.ts';
import { buildRaceLiveBonusInfos } from './userRaceInfo.ts';

const RIVAL_MSG = 'Solis.Common.Proto.Api.RaceOpponentProgressInfo';

export { RACE_RIVAL_CHARACTER_TYPES, isRivalCharacter } from './botIdols.ts';

/** A ranked race entry the opponent list can be drawn from. */
export interface RaceOpponentCandidate {
  playerId: string;
  /** Competition rank, ascending (1 = leader; ties share a rank). */
  rank: number;
  /** `totalClearPanelCount` of the entry; the caller's own count is the bar. */
  clearPanelCount: number;
}

/**
 * Pick the opponents shown next to `playerId` out of `entries` (the full
 * ranking, the caller included when ranked).
 *
 * Candidates are all other players whose `clearPanelCount` is at least the
 * caller's, so tied players see each other. The candidates with the best
 * (rank-1) count come first, in list order, then the remaining candidates
 * closest to the caller (smallest count difference first, equal counts in list
 * order) join until `limit` rows are chosen. If that still leaves free rows, the
 * players strictly behind the caller (smaller `clearPanelCount`) fill them,
 * closest first (smallest count difference, equal counts in list order). The
 * caller's own row is only listed when no other player is in the race at all;
 * otherwise a caller with no ranked entry counts as ranked behind everyone and
 * takes the rows in list order after the rank-1 players. The result is ordered
 * by rank, then list order. Pure so the selection is testable.
 */
export function selectRaceOpponents<T extends RaceOpponentCandidate>(
  entries: readonly T[],
  playerId: string,
  limit: number,
): T[] {
  if (limit <= 0 || entries.length === 0) return [];
  const self = entries.find((entry) => entry.playerId === playerId);
  const candidates = entries.filter(
    (entry) =>
      entry.playerId !== playerId &&
      (self === undefined || entry.clearPanelCount >= self.clearPanelCount),
  );
  const picked: T[] = [];
  if (candidates.length > 0) {
    let bestCount = candidates[0]!.clearPanelCount;
    for (const candidate of candidates) {
      if (candidate.clearPanelCount > bestCount) bestCount = candidate.clearPanelCount;
    }
    // The rank-1 players first, in list order.
    for (const candidate of candidates) {
      if (picked.length >= limit) break;
      if (candidate.clearPanelCount === bestCount) picked.push(candidate);
    }
    // Then the players closest to the caller, smallest count difference first.
    // Without a ranked caller every candidate is equally far, so list order holds.
    const rest = candidates.filter((candidate) => candidate.clearPanelCount !== bestCount);
    if (self !== undefined) {
      const selfCount = self.clearPanelCount;
      rest.sort(
        (a, b) =>
          Math.abs(a.clearPanelCount - selfCount) - Math.abs(b.clearPanelCount - selfCount),
      );
    }
    for (const candidate of rest) {
      if (picked.length >= limit) break;
      picked.push(candidate);
    }
  }
  // Backfill with the players behind the caller, closest first, until the limit.
  if (picked.length < limit && self !== undefined) {
    const selfCount = self.clearPanelCount;
    const behind = entries
      .filter((entry) => entry.playerId !== playerId && entry.clearPanelCount < selfCount)
      .sort((a, b) => b.clearPanelCount - a.clearPanelCount);
    for (const candidate of behind) {
      if (picked.length >= limit) break;
      picked.push(candidate);
    }
  }
  // Alone in the race (or unranked and alone): the caller's own row.
  if (picked.length === 0) return self === undefined ? [] : [self];
  const listOrder = new Map(entries.map((entry, index) => [entry.playerId, index] as const));
  return picked
    .slice(0, limit)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (listOrder.get(a.playerId) ?? 0) - (listOrder.get(b.playerId) ?? 0),
    );
}

/** First non-empty `Profile.FavoriteCharacterIds` id of `profile`. */
function favoriteCharacterIdOf(profile: Decoded | null): string {
  const ids = (profile?.FavoriteCharacterIds as unknown[] | undefined) ?? [];
  for (const id of ids) {
    const value = String(id ?? '');
    if (value !== '') return value;
  }
  return '';
}

/**
 * The character a player shows on their profile. It is the first
 * `Profile.FavoriteCharacterIds` entry — the same field `Profile:FindUser` and
 * `profileInfosFor` expose for other players. A player who never picked one
 * falls back to the first main idol (Type 1) so the board still renders an
 * icon.
 */
async function displayCharacterIdFor(
  profile: Decoded | null,
  fallback: () => Promise<string>,
): Promise<string> {
  const favorite = favoriteCharacterIdOf(profile);
  return favorite !== '' ? favorite : fallback();
}

/**
 * `RaceOpponentProgressInfo` rows for `Race:Top` / `Race:MovePanel` /
 * `Race:StartLivePanelQuest`: the players ahead of or level with `playerId`,
 * backfilled with the closest players behind when the list would otherwise be
 * short. Synthetic race bots take part like any other ranked entry but render
 * from their own generated data (no player row, no live bonuses, a playable
 * character picked by their seeded index).
 *
 * `state` is the caller's state; the caller is excluded from the list, so it is
 * only kept to preserve the caller-facing signature.
 */
export async function buildRaceOpponentProgressInfos(
  playerId: string,
  config: RaceConfig,
  state: RaceState,
  exec: Executor = db,
): Promise<Decoded[]> {
  void state;
  const limit = Math.max(0, Math.floor(config.rivals));
  if (limit === 0) return [];
  const ranking = await raceRanking(config.raceId, exec);
  const selected = selectRaceOpponents(
    ranking.map((entry) => ({
      playerId: entry.playerId,
      rank: entry.rank,
      clearPanelCount: entry.state.totalClearPanelCount,
    })),
    playerId,
    limit,
  );
  if (selected.length === 0) return [];
  const entryByPlayer = new Map(ranking.map((entry) => [entry.playerId, entry] as const));
  // Only real ids reach the players table; bots render without a row.
  const realIds = selected
    .filter((candidate) => entryByPlayer.get(candidate.playerId)?.bot === undefined)
    .map((candidate) => candidate.playerId);
  const rows =
    realIds.length === 0
      ? []
      : await exec.select().from(players).where(inArray(players.id, realIds));
  const byId = new Map(rows.map((row) => [row.id, row] as const));

  let fallbackCharacterId = '';
  const fallback = async (): Promise<string> => {
    if (fallbackCharacterId === '') {
      const characters = (await listCharacters()) as unknown as RivalCharacter[];
      fallbackCharacterId = String(characters.find(isRivalCharacter)?.Id ?? '');
    }
    return fallbackCharacterId;
  };

  // The playable idol list a bot's seeded index addresses, ordered by id so the
  // same bot always shows the same character.
  let playableCharacterIds: string[] | null = null;
  const playableCharacters = async (): Promise<string[]> => {
    if (playableCharacterIds === null) {
      const characters = (await listCharacters()) as unknown as RivalCharacter[];
      playableCharacterIds = characters
        .filter(isRivalCharacter)
        .map((character) => String(character.Id))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    return playableCharacterIds;
  };

  const out: Decoded[] = [];
  for (const candidate of selected) {
    const entry = entryByPlayer.get(candidate.playerId);
    if (!entry) continue;
    if (entry.bot !== undefined) {
      let characterId = entry.bot.characterId ?? '';
      if (characterId === '') {
        const characters = await playableCharacters();
        characterId =
          characters.length === 0
            ? ''
            : (characters[entry.bot.displayCharacterIndex % characters.length] as string);
      }
      out.push({
        __msg: RIVAL_MSG,
        UserId: entry.bot.userId,
        Name: entry.bot.name,
        DisplayCharacterId: characterId,
        ClearPanelCount: entry.state.totalClearPanelCount,
        Rank: entry.rank,
        LiveBonusInfos: [],
      } as Decoded);
      continue;
    }
    const row = byId.get(candidate.playerId);
    if (!row) continue;
    const profile = await getSingleton(entry.playerId, 'Profile', exec);
    out.push({
      __msg: RIVAL_MSG,
      UserId: publicUserIdOf(row),
      Name: row.name,
      DisplayCharacterId: await displayCharacterIdFor(profile, fallback),
      ClearPanelCount: entry.state.totalClearPanelCount,
      Rank: entry.rank,
      LiveBonusInfos: buildRaceLiveBonusInfos(entry.state),
    } as Decoded);
  }
  return out;
}
