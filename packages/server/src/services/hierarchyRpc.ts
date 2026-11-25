import { eq, inArray } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { accounts, players } from '../db/schema.ts';
import { getSingleton, listElements, putSingleton } from './playerState.ts';
import {
  hierarchyDetailGradeReached,
  leaderboardGrades,
  listHierarchyTotals,
  loadHierarchyStanding,
  loadUserHierarchy,
  reconcileHierarchyNotification,
  resolveHierarchyStanding,
  rewardTargetGradeId,
  strongestGradeId,
  type Grade,
} from './hierarchy.ts';
import {
  listHierarchyDetailGrades,
  listHierarchyDivisionRewards,
  listHierarchyRewards,
} from '../master/index.ts';
import { applyRewardRefs } from '../master/reward.ts';
import { GRPC_STATUS, RpcError } from './errors.ts';
import { profileInfosFor, publicUserIdOf } from './friendLinks.ts';
import { mergeUpdated } from './activity.ts';
import { isSandbox } from '../profile.ts';
import {
  SANDBOX_HIERARCHY_DETAIL_GRADE_ID,
  SANDBOX_HIERARCHY_RANK,
} from '../profiles/sandbox/hierarchy.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * VENUS (Hierarchy) rank page: Top, ListRanking and the two reward claims.
 * Ported from Solis `rpc/servers/hierarchy/*.go` and `viber/hierarchy.go`, with
 * a real server-wide Platinum/Diamond/BIG4 leaderboard instead of Solis' constant rank.
 */

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const TOP_RESPONSE_MSG = 'Solis.Common.Proto.Api.HierarchyTopResponse';
const RANKING_RESPONSE_MSG = 'Solis.Common.Proto.Api.HierarchyRankingResponse';
const REWARDS_RECEIVE_RESPONSE_MSG = 'Solis.Common.Proto.Api.HierarchyRewardsReceiveResponse';
const DIVISION_RECEIVE_RESPONSE_MSG = 'Solis.Common.Proto.Api.HierarchyDivisionRewardsReceiveResponse';
const LAST_CARD_INFO_MSG = 'Solis.Common.Proto.Api.LastCardInfo';

/** Solis caps the rank page at the same size the client requests. */
export const HIERARCHY_RANKING_LIMIT = 100;
/** BIG4: the leaderboard's first four places. */
const BIG4_RANK_LIMIT = 4;

// ---------------------------------------------------------------------------
// Pure leaderboard helpers (unit-tested in hierarchyRpc.test.ts)
// ---------------------------------------------------------------------------

export type RankingEntry = { playerId: string; total: number };
export type RankedEntry = RankingEntry & { rank: number };

/**
 * Competition ranking over every player at Platinum or above: total desc, ties
 * share the same rank (1 + the number of entries with strictly more points).
 * Ties break on player id so the row order is stable across requests.
 */
export function rankLeaderboard(entries: readonly RankingEntry[], minPoint: number): RankedEntry[] {
  const ranked = entries
    .filter((entry) => entry.total >= minPoint)
    .sort((a, b) => b.total - a.total || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  return ranked.map((entry) => ({
    ...entry,
    rank: 1 + ranked.reduce((ahead, other) => (other.total > entry.total ? ahead + 1 : ahead), 0),
  }));
}

/**
 * A row on the page plus the rank used to resolve its detail grade. For rows
 * from the top of the leaderboard, `rank` and `gradeRank` are the same real
 * rank. A ranked caller past the row cap is appended with their real rank in
 * both fields. A caller below the leaderboard floor is not appended, because
 * the client cannot show rank 0. The caller is never duplicated: when it is
 * already in the page, the page is returned as is.
 */
export type RankingPageRow = RankingEntry & { rank: number; gradeRank: number };

export function rankingPage(
  ranked: readonly RankedEntry[],
  caller: RankingEntry,
  limit = HIERARCHY_RANKING_LIMIT,
): RankingPageRow[] {
  const page: RankingPageRow[] = ranked
    .slice(0, limit)
    .map((entry) => ({ ...entry, gradeRank: entry.rank }));
  if (page.some((entry) => entry.playerId === caller.playerId)) return page;
  const real = ranked.find((entry) => entry.playerId === caller.playerId);
  if (!real) return page;
  return [...page, { ...caller, rank: real.rank, gradeRank: real.rank }];
}

export type HierarchyRewardRow = { Id: string; targetGradeId: string };

/** Solis `Top` reward rows: reached stays true after claiming (HaveReceived marks that). */
export function hierarchyRewardInfos(
  rewards: readonly HierarchyRewardRow[],
  grades: Grade[],
  achievedId: string,
  receivedIds: readonly string[],
): Decoded[] {
  const received = new Set(receivedIds);
  return rewards.map(
    (reward) =>
      ({
        __msg: 'Solis.Common.Proto.Api.HierarchyRewardInfo',
        HierarchyRewardId: reward.Id,
        CanReceive: hierarchyDetailGradeReached(grades, achievedId, reward.targetGradeId),
        HaveReceived: received.has(reward.Id),
      }) as Decoded,
  );
}

export type HierarchyDivisionRewardRow = { Id: string; RewardId: string | null; DetailGradeId: string | null };

export function hierarchyDivisionRewardInfos(
  rewards: readonly HierarchyDivisionRewardRow[],
  grades: Grade[],
  achievedId: string,
  receivedIds: readonly string[],
): Decoded[] {
  const received = new Set(receivedIds);
  return rewards.map((reward) => {
    const target = String(reward.DetailGradeId ?? '');
    if (!target) throw new Error(`Hierarchy division reward ${reward.Id} has no detail grade`);
    return {
      __msg: 'Solis.Common.Proto.Api.HierarchyDivisionRewardInfo',
      HierarchyDivisionRewardId: reward.Id,
      CanReceive: hierarchyDetailGradeReached(grades, achievedId, target),
      HaveReceived: received.has(reward.Id),
    } as Decoded;
  });
}

export type DeckPositionRow = { Position: number; CardId: string };

/** Solis `hierarchyRankingDeck`: primary deck positions in order, cards resolved. */
export function buildDeckCards(
  positions: readonly DeckPositionRow[],
  cardById: ReadonlyMap<string, Decoded>,
): Decoded[] {
  const infos: Decoded[] = [];
  for (const position of [...positions].sort((a, b) => a.Position - b.Position)) {
    const card = cardById.get(position.CardId);
    if (!card) continue;
    infos.push({
      __msg: LAST_CARD_INFO_MSG,
      Position: position.Position,
      CardId: position.CardId,
      Level: Number(card.Level ?? 0),
      Rarity: Number(card.Rarity ?? 0),
      EvolutionLevel: Number(card.EvolutionLevel ?? 0),
    } as Decoded);
  }
  return infos;
}

export type RankUserSource = {
  userId: string;
  rank: number;
  name: string;
  level: number;
  detailGradeId: string;
  point: number;
  emblemId: string;
  deckName: string;
  cardInfos: Decoded[];
};

export function rankUserInfo(source: RankUserSource): Decoded {
  return {
    __msg: 'Solis.Common.Proto.Api.HierarchyRankUserInfo',
    UserId: source.userId,
    CurrentRank: source.rank,
    ManagerName: source.name,
    ManagerLevel: source.level,
    CurrentDetailGradeId: source.detailGradeId,
    CurrentPoint: source.point,
    EmblemId: source.emblemId,
    DeckName: source.deckName,
    CardInfos: source.cardInfos,
  } as Decoded;
}

// ---------------------------------------------------------------------------
// Shared loading
// ---------------------------------------------------------------------------

async function hierarchyGrades(): Promise<Grade[]> {
  return (await listHierarchyDetailGrades()) as Grade[];
}

/**
 * The grade whose rewards are reachable. In the sandbox every player is BIG4,
 * so every reward is reached; the official profile uses the real achieved
 * high-water grade.
 */
function profileAchievedGradeId(realAchievedId: string): string {
  return isSandbox() ? SANDBOX_HIERARCHY_DETAIL_GRADE_ID : realAchievedId;
}

/** The reached high-water grade: current standing, or the stored best if stronger. */
async function achievedGradeId(grades: Grade[], playerId: string, exec: Executor): Promise<string> {
  const standing = await loadHierarchyStanding(playerId, exec);
  const hierarchy = await loadUserHierarchy(playerId, exec);
  return profileAchievedGradeId(
    strongestGradeId(grades, standing.detailGradeId, String(hierarchy.BestDetailGradeId ?? '')),
  );
}

function updatedData(hierarchy: Decoded | null): Decoded {
  const updated: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
  if (hierarchy) updated.Hierarchy = hierarchy;
  return updated;
}

function commonResponse(updated: Decoded): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: updated,
    DeletedData: { __msg: DELETED_DATA_MSG } as Decoded,
  } as Decoded;
}

function rewardResults(results: Decoded[]): Decoded[] {
  const byKey = new Map<string, Decoded>();
  for (const result of results) {
    const key = `${Number(result.ResourceType ?? 0)}:${String(result.ResourceId ?? '')}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...result, AmountI64: Number(result.AmountI64 ?? 0) } as Decoded);
      continue;
    }
    current.AmountI64 = Number(current.AmountI64 ?? 0) + Number(result.AmountI64 ?? 0);
    current.AfterAmount = result.AfterAmount;
  }
  return [...byKey.values()];
}

/** Solis `validateHierarchyRewardIDs`: non-empty, no empty id, no duplicate. */
export function validateRewardIds(ids: readonly string[], label: string): void {
  if (ids.length === 0) throw new RpcError(`${label} is empty`, GRPC_STATUS.INVALID_ARGUMENT);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id) throw new RpcError(`${label} contains an empty id`, GRPC_STATUS.INVALID_ARGUMENT);
    if (seen.has(id)) throw new RpcError(`${label} contains duplicate ${id}`, GRPC_STATUS.INVALID_ARGUMENT);
    seen.add(id);
  }
}

// ---------------------------------------------------------------------------
// Hierarchy:Top
// ---------------------------------------------------------------------------

export async function buildHierarchyTop(playerId: string, exec: Executor = db): Promise<Decoded> {
  const standing = await loadHierarchyStanding(playerId, exec);
  const reconciled = await reconcileHierarchyNotification(playerId, exec);
  const hierarchy = reconciled.hierarchy ?? (await loadUserHierarchy(playerId, exec));
  const grades = await hierarchyGrades();
  const achievedId = profileAchievedGradeId(
    strongestGradeId(grades, standing.detailGradeId, String(hierarchy.BestDetailGradeId ?? '')),
  );
  const receivedIds = (hierarchy.ReceivedRewardIds as string[] | undefined) ?? [];
  const receivedDivisionIds = (hierarchy.ReceivedDivisionRewardIds as string[] | undefined) ?? [];

  const rewards: HierarchyRewardRow[] = [];
  for (const reward of await listHierarchyRewards()) {
    rewards.push({ Id: reward.Id, targetGradeId: await rewardTargetGradeId(reward) });
  }
  const rewardInfos = hierarchyRewardInfos(rewards, grades, achievedId, receivedIds);

  const divisionRewards = (await listHierarchyDivisionRewards()) as HierarchyDivisionRewardRow[];
  const divisionInfos = hierarchyDivisionRewardInfos(divisionRewards, grades, achievedId, receivedDivisionIds);
  const anyDivisionReached = divisionInfos.some((info) => info.CanReceive === true);
  const callerProfile = anyDivisionReached ? ((await profileInfosFor([playerId], exec))[0] ?? null) : null;
  if (callerProfile) {
    for (const info of divisionInfos) {
      if (info.CanReceive === true) info.FirstUserInfo = callerProfile;
    }
  }

  let highestGradeUserNames: string[] = [];
  if (isSandbox()) {
    // The sandbox leaderboard is off: only the caller is BIG4, so only their
    // own name is listed and no other player's totals/rows are read.
    const [caller] = await exec
      .select({ name: players.name })
      .from(players)
      .where(eq(players.id, playerId));
    const callerName = String(caller?.name ?? '');
    if (callerName !== '') highestGradeUserNames = [callerName];
  } else {
    const { minPoint } = leaderboardGrades(grades);
    // BIG4 needs both a top-4 rank and the BIG4 point floor; a top-4 player
    // below it is Diamond.
    const big4 = rankLeaderboard(await listHierarchyTotals(exec), minPoint).filter(
      (entry) =>
        entry.rank <= BIG4_RANK_LIMIT &&
        resolveHierarchyStanding(grades, entry.total, entry.rank).gradeId === 'hie-001',
    );
    if (big4.length > 0) {
      const rows = await exec
        .select({ id: players.id, name: players.name })
        .from(players)
        .where(inArray(players.id, big4.map((entry) => entry.playerId)));
      const nameById = new Map(rows.map((row) => [String(row.id), String(row.name ?? '')]));
      highestGradeUserNames = big4
        .map((entry) => nameById.get(entry.playerId) ?? '')
        .filter((name) => name !== '');
    }
  }

  return {
    __msg: TOP_RESPONSE_MSG,
    UserHierarchyInfo: {
      __msg: 'Solis.Common.Proto.Api.UserHierarchyInfo',
      CurrentDetailGradeId: standing.detailGradeId,
      CurrentRank: standing.rank,
      CurrentPoint: standing.total,
    },
    RewardInfos: rewardInfos,
    DivisionRewardInfos: divisionInfos,
    HighestGradeUserNames: highestGradeUserNames,
    CommonResponse: commonResponse(updatedData(reconciled.hierarchy)),
  } as Decoded;
}

// ---------------------------------------------------------------------------
// Hierarchy:ListRanking
// ---------------------------------------------------------------------------

type PlayerRow = typeof players.$inferSelect;

async function rankingDeck(
  playerId: string,
  exec: Executor,
): Promise<{ deckName: string; cardInfos: Decoded[] }> {
  const decks = await listElements(playerId, 'Decks', exec);
  if (decks.length === 0) return { deckName: '', cardInfos: [] };
  const deck = [...decks].sort((a, b) => Number(a.Number ?? 0) - Number(b.Number ?? 0))[0];
  const deckNumber = Number(deck.Number ?? 0);
  const positions = (await listElements(playerId, 'DeckPositions', exec))
    .filter((row) => Number(row.Number ?? 0) === deckNumber)
    .map((row) => ({ Position: Number(row.Position ?? 0), CardId: String(row.CardId ?? '') }));
  const cards = await listElements(playerId, 'Cards', exec);
  const cardById = new Map(cards.map((card) => [String(card.CardId ?? ''), card]));
  return { deckName: String(deck.Name ?? ''), cardInfos: buildDeckCards(positions, cardById) };
}

/**
 * Detail grade for a ranking row. The sandbox shows every player at BIG4 and
 * disables the leaderboard, so the row grade is the fixed sandbox grade.
 */
function profileRankingDetailGradeId(grades: Grade[], total: number, gradeRank: number): string {
  return isSandbox()
    ? SANDBOX_HIERARCHY_DETAIL_GRADE_ID
    : resolveHierarchyStanding(grades, total, gradeRank).detailGradeId;
}

async function rankRow(
  playerId: string,
  rank: number,
  total: number,
  grades: Grade[],
  gradeRank: number,
  exec: Executor,
  playerRow: PlayerRow,
): Promise<Decoded> {
  const user = await getSingleton(playerId, 'User', exec);
  const detailGradeId = profileRankingDetailGradeId(grades, total, gradeRank);
  const deck = await rankingDeck(playerId, exec);
  return rankUserInfo({
    userId: publicUserIdOf(playerRow),
    rank,
    name: String(playerRow.name ?? ''),
    level: Number(playerRow.level ?? 0),
    detailGradeId,
    point: total,
    emblemId: String(user?.EmblemId ?? ''),
    deckName: deck.deckName,
    cardInfos: deck.cardInfos,
  });
}

export async function buildHierarchyListRanking(playerId: string, exec: Executor = db): Promise<Decoded> {
  const standing = await loadHierarchyStanding(playerId, exec);
  const grades = await hierarchyGrades();

  if (isSandbox()) {
    // The sandbox leaderboard is off: the page is exactly one row, the caller,
    // at BIG4 rank 1 with their real points. No other player is queried.
    const rows = await exec
      .select({ player: players, deletedAt: accounts.deletedAt })
      .from(players)
      .innerJoin(accounts, eq(accounts.id, players.accountId))
      .where(eq(players.id, playerId));
    const row = rows.find((entry) => entry.deletedAt == null);
    const rankUserInfos: Decoded[] = [];
    if (row) {
      rankUserInfos.push(
        await rankRow(
          playerId,
          SANDBOX_HIERARCHY_RANK,
          standing.total,
          grades,
          SANDBOX_HIERARCHY_RANK,
          exec,
          row.player,
        ),
      );
    }
    return {
      __msg: RANKING_RESPONSE_MSG,
      RankUserInfos: rankUserInfos,
      CommonResponse: commonResponse({ __msg: UPDATED_DATA_MSG } as Decoded),
    } as Decoded;
  }

  const { minPoint } = leaderboardGrades(grades);
  const ranked = rankLeaderboard(await listHierarchyTotals(exec), minPoint);
  const page = rankingPage(ranked, { playerId, total: standing.total });

  const ids = page.map((entry) => entry.playerId);
  const rows = await exec
    .select({ player: players, deletedAt: accounts.deletedAt })
    .from(players)
    .innerJoin(accounts, eq(accounts.id, players.accountId))
    .where(inArray(players.id, ids));
  const byId = new Map(
    rows.filter((row) => row.deletedAt == null).map((row) => [String(row.player.id), row.player] as const),
  );

  const rankUserInfos: Decoded[] = [];
  for (const entry of page) {
    const playerRow = byId.get(entry.playerId);
    if (!playerRow) continue;
    rankUserInfos.push(
      await rankRow(entry.playerId, entry.rank, entry.total, grades, entry.gradeRank, exec, playerRow),
    );
  }
  return {
    __msg: RANKING_RESPONSE_MSG,
    RankUserInfos: rankUserInfos,
    CommonResponse: commonResponse({ __msg: UPDATED_DATA_MSG } as Decoded),
  } as Decoded;
}

// ---------------------------------------------------------------------------
// Hierarchy:ReceiveRewards / Hierarchy:ReceiveDivisionRewards
// ---------------------------------------------------------------------------

export async function receiveHierarchyRewards(
  playerId: string,
  ids: string[],
  exec: Executor = db,
): Promise<Decoded> {
  validateRewardIds(ids, 'hierarchyRewardIds');
  const grades = await hierarchyGrades();
  const achievedId = await achievedGradeId(grades, playerId, exec);

  const rewards = await listHierarchyRewards();
  const byId = new Map(rewards.map((reward) => [String(reward.Id), reward] as const));
  const reached = new Set<string>();
  for (const reward of rewards) {
    const target = await rewardTargetGradeId(reward);
    if (hierarchyDetailGradeReached(grades, achievedId, target)) reached.add(String(reward.Id));
  }

  const hierarchy = await loadUserHierarchy(playerId, exec);
  const receivedIds = ((hierarchy.ReceivedRewardIds as string[] | undefined) ?? []).slice();
  const received = new Set(receivedIds);
  const selected: typeof rewards = [];
  for (const id of ids) {
    const reward = byId.get(id);
    if (!reward) throw new RpcError(`unknown Hierarchy reward ${id}`, GRPC_STATUS.INVALID_ARGUMENT);
    if (received.has(id)) {
      throw new RpcError(`Hierarchy reward ${id} was already received`, GRPC_STATUS.FAILED_PRECONDITION);
    }
    if (!reached.has(id)) {
      throw new RpcError(`Hierarchy reward ${id} is not reached`, GRPC_STATUS.FAILED_PRECONDITION);
    }
    selected.push(reward);
    received.add(id);
    receivedIds.push(id);
  }
  receivedIds.sort();
  hierarchy.ReceivedRewardIds = receivedIds;
  await putSingleton(playerId, 'Hierarchy', hierarchy, exec);

  const updated = updatedData(hierarchy);
  const results: Decoded[] = [];
  for (const reward of selected) {
    const ref = String(reward.RewardId ?? '');
    if (!ref) continue;
    const applied = await applyRewardRefs(playerId, [ref], exec);
    mergeUpdated(updated, applied.updated);
    results.push(...applied.results);
  }

  const reconciled = await reconcileHierarchyNotification(playerId, exec);
  updated.Hierarchy = reconciled.hierarchy ?? (await loadUserHierarchy(playerId, exec));

  return {
    __msg: REWARDS_RECEIVE_RESPONSE_MSG,
    Results: rewardResults(results),
    CommonResponse: commonResponse(updated),
  } as Decoded;
}

export async function receiveHierarchyDivisionRewards(
  playerId: string,
  ids: string[],
  exec: Executor = db,
): Promise<Decoded> {
  validateRewardIds(ids, 'hierarchyDivisionRewardIds');
  const grades = await hierarchyGrades();
  const achievedId = await achievedGradeId(grades, playerId, exec);

  const rewards = (await listHierarchyDivisionRewards()) as HierarchyDivisionRewardRow[];
  const byId = new Map(rewards.map((reward) => [String(reward.Id), reward] as const));

  const hierarchy = await loadUserHierarchy(playerId, exec);
  const receivedIds = ((hierarchy.ReceivedDivisionRewardIds as string[] | undefined) ?? []).slice();
  const received = new Set(receivedIds);
  const selected: HierarchyDivisionRewardRow[] = [];
  for (const id of ids) {
    const reward = byId.get(id);
    if (!reward) throw new RpcError(`unknown Hierarchy division reward ${id}`, GRPC_STATUS.INVALID_ARGUMENT);
    if (received.has(id)) {
      throw new RpcError(
        `Hierarchy division reward ${id} was already received`,
        GRPC_STATUS.FAILED_PRECONDITION,
      );
    }
    const target = String(reward.DetailGradeId ?? '');
    if (!target) throw new Error(`Hierarchy division reward ${id} has no detail grade`);
    if (!hierarchyDetailGradeReached(grades, achievedId, target)) {
      throw new RpcError(`Hierarchy division reward ${id} is not reached`, GRPC_STATUS.FAILED_PRECONDITION);
    }
    selected.push(reward);
    received.add(id);
    receivedIds.push(id);
  }
  receivedIds.sort();
  hierarchy.ReceivedDivisionRewardIds = receivedIds;
  await putSingleton(playerId, 'Hierarchy', hierarchy, exec);

  const updated = updatedData(hierarchy);
  const results: Decoded[] = [];
  for (const reward of selected) {
    const ref = String(reward.RewardId ?? '');
    if (!ref) continue;
    const applied = await applyRewardRefs(playerId, [ref], exec);
    mergeUpdated(updated, applied.updated);
    results.push(...applied.results);
  }

  const reconciled = await reconcileHierarchyNotification(playerId, exec);
  updated.Hierarchy = reconciled.hierarchy ?? (await loadUserHierarchy(playerId, exec));

  return {
    __msg: DIVISION_RECEIVE_RESPONSE_MSG,
    Results: rewardResults(results),
    CommonResponse: commonResponse(updated),
  } as Decoded;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function accountOf(ctx: { auth: { ok: boolean; claims?: { sub?: string } } }): string {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error('unauthenticated');
  return accountId;
}

async function playerForAccount(accountId: string, rpc: string): Promise<PlayerRow> {
  const [pl] = await db.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

register(
  'Hierarchy:Top',
  async (ctx) => {
    const pl = await playerForAccount(accountOf(ctx), 'Hierarchy:Top');
    return withPlayerTx(pl.id, (tx) => buildHierarchyTop(pl.id, tx));
  },
  { ownsState: true },
);

register(
  'Hierarchy:ListRanking',
  async (ctx) => {
    const pl = await playerForAccount(accountOf(ctx), 'Hierarchy:ListRanking');
    return withPlayerTx(pl.id, (tx) => buildHierarchyListRanking(pl.id, tx));
  },
  { ownsState: true },
);

register(
  'Hierarchy:ReceiveRewards',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Hierarchy:ReceiveRewards: missing request');
    const ids = Array.isArray(req.HierarchyRewardIds) ? (req.HierarchyRewardIds as string[]) : [];
    const pl = await playerForAccount(accountOf(ctx), 'Hierarchy:ReceiveRewards');
    return withPlayerTx(pl.id, (tx) => receiveHierarchyRewards(pl.id, ids, tx));
  },
  { ownsState: true },
);

register(
  'Hierarchy:ReceiveDivisionRewards',
  async (ctx) => {
    const req = ctx.request;
    if (!req) throw new Error('Hierarchy:ReceiveDivisionRewards: missing request');
    const ids = Array.isArray(req.HierarchyDivisionRewardIds)
      ? (req.HierarchyDivisionRewardIds as string[])
      : [];
    const pl = await playerForAccount(accountOf(ctx), 'Hierarchy:ReceiveDivisionRewards');
    return withPlayerTx(pl.id, (tx) => receiveHierarchyDivisionRewards(pl.id, ids, tx));
  },
  { ownsState: true },
);
