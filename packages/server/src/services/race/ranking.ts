// Cross-player race ranking: `Race:Ranking` plus the player's own position for
// `UserRaceInfo.CurrnentRank`.
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import type { Executor } from '../../db/tx.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { playerEntities, players } from '../../db/schema.ts';
import { register, type RpcContext } from '../handlers.ts';
import { publicUserIdOf } from '../friendLinks.ts';
import { decodeJsonSingletonBlob, getSingleton } from '../playerState.ts';
import { withQuestPlayer } from '../quest.ts';
import { raceConfigFor, raceWindowFor } from './catalog.ts';
import { raceBotEntries, type RaceBot } from './bots.ts';
import { raceBotIdols } from './botIdols.ts';
import { normalizeRaceState, raceStateField } from './state.ts';
import type { RaceState } from './state.ts';

/**
 * `RaceRankingDisplayNum` of the race master `Setting` row. `master_Setting`
 * has no race columns in this schema, so the official cap is a constant.
 */
export const RACE_RANKING_DISPLAY_NUM = 1000;

const RANKING_INFO_MSG = 'Solis.Common.Proto.Api.RaceRankingInfo';

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

export interface RaceRankingEntry {
  playerId: string;
  state: RaceState;
  /**
   * Competition rank: `1 +` the number of players with a strictly greater
   * `totalClearPanelCount`, so tied players share a rank (49, 49, 40 → 1, 1, 3).
   */
  rank: number;
  /**
   * Present when the entry is a synthetic bot. `playerId` is then `bot.id` and
   * `state` only carries `totalClearPanelCount`; nothing is stored or granted.
   */
  bot?: RaceBot;
}

/**
 * Every stored `RaceState:<raceId>` row with its rank, best first, followed by
 * the race's synthetic bots (when enabled). The list order is
 * `totalClearPanelCount` desc; ties keep the database row order, which is the
 * order players first wrote the state in (ascending row id), so an earlier board
 * still lists ahead of a later one, and real players list ahead of bots at an
 * equal count. The rank number is shared by ties: it is `1 +` the number of
 * participants with a strictly greater count.
 */
export async function raceRanking(
  raceId: string,
  exec: Executor = db,
  now: number = Date.now(),
): Promise<RaceRankingEntry[]> {
  const rows = await exec
    .select({ playerId: playerEntities.playerId, blob: playerEntities.blob, id: playerEntities.id })
    .from(playerEntities)
    .where(and(eq(playerEntities.kind, raceStateField(raceId)), eq(playerEntities.entityKey, '')))
    .orderBy(playerEntities.id);
  const entries: Omit<RaceRankingEntry, 'rank'>[] = [];
  for (const row of rows) {
    const decoded = decodeJsonSingletonBlob(row.blob);
    if (!decoded) continue;
    const state = normalizeRaceState(decoded);
    if (!state.initialized) continue;
    entries.push({ playerId: row.playerId, state });
  }
  // Bots are appended after the real rows so the stable sort below keeps real
  // players ahead of a bot on the same clear count.
  const window = raceWindowFor(raceId, now);
  const bots = raceConfigFor(raceId)?.bots;
  if (window !== undefined && bots !== undefined && bots.enabled && Math.floor(bots.count) > 0) {
    // Only a bot-enabled race reads the master character list for idol names.
    const idols = await raceBotIdols();
    for (const bot of raceBotEntries(raceId, bots, window, now, idols)) {
      const state = normalizeRaceState({});
      state.initialized = true;
      state.totalClearPanelCount = bot.clearPanelCount;
      entries.push({ playerId: bot.id, state, bot });
    }
  }
  entries.sort((a, b) => b.state.totalClearPanelCount - a.state.totalClearPanelCount);
  let rank = 0;
  let previous: number | null = null;
  return entries.map((entry, index) => {
    if (previous === null || entry.state.totalClearPanelCount !== previous) {
      rank = index + 1;
      previous = entry.state.totalClearPanelCount;
    }
    return { ...entry, rank };
  });
}

/**
 * Competition rank of `playerId` (shared by ties), or 0 when the player has no
 * race state.
 */
export async function racePlayerRank(
  playerId: string,
  raceId: string,
  exec: Executor = db,
): Promise<number> {
  const entries = await raceRanking(raceId, exec);
  return entries.find((entry) => entry.playerId === playerId)?.rank ?? 0;
}

/** `RaceRankingInfo` rows for the leading entries of `entries`. */
export async function buildRaceRankingInfos(
  entries: readonly RaceRankingEntry[],
  exec: Executor = db,
): Promise<Decoded[]> {
  const displayed = entries.slice(0, RACE_RANKING_DISPLAY_NUM);
  if (displayed.length === 0) return [];
  // Only real ids reach the players table; a bot renders from its own data.
  const realIds = displayed.filter((entry) => entry.bot === undefined).map((entry) => entry.playerId);
  const rows =
    realIds.length === 0
      ? []
      : await exec.select().from(players).where(inArray(players.id, realIds));
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const out: Decoded[] = [];
  for (const entry of displayed) {
    if (entry.bot !== undefined) {
      out.push({
        __msg: RANKING_INFO_MSG,
        UserId: entry.bot.userId,
        Name: entry.bot.name,
        ManagerLevel: entry.bot.managerLevel,
        ClearPanelCount: entry.state.totalClearPanelCount,
        Rank: entry.rank,
        EmblemId: '',
      } as Decoded);
      continue;
    }
    const row = byId.get(entry.playerId);
    if (!row) continue;
    const user = await getSingleton(entry.playerId, 'User', exec);
    out.push({
      __msg: RANKING_INFO_MSG,
      UserId: publicUserIdOf(row),
      Name: row.name,
      ManagerLevel: row.level,
      ClearPanelCount: entry.state.totalClearPanelCount,
      Rank: entry.rank,
      EmblemId: s(user?.EmblemId),
    } as Decoded);
  }
  return out;
}

register(
  'Race:Ranking',
  async (ctx: RpcContext) => {
    const RPC = 'Race:Ranking';
    const req = (ctx.request ?? {}) as Decoded;
    const raceId = s(req.RaceId);
    if (raceConfigFor(raceId) === undefined) throw new Error(`${RPC}: unknown race ${raceId}`);
    return withQuestPlayer(ctx, RPC, async (playerId) => {
      const entries = await raceRanking(raceId, db);
      const self = entries.find((entry) => entry.playerId === playerId);
      return {
        __msg: 'Solis.Common.Proto.Api.RaceRankingResponse',
        RankingInfos: await buildRaceRankingInfos(entries, db),
        SelfClearPanelCount: self?.state.totalClearPanelCount ?? 0,
        SelfRank: self?.rank ?? 0,
      } as Decoded;
    });
  },
  { ownsState: true },
);
