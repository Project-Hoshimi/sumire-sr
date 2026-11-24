import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { Executor } from '../db/tx.ts';
import { playerEntities } from '../db/schema.ts';
import {
  getCondition,
  getQuest,
  listHierarchyDetailGrades,
  listHierarchyDivisionRewards,
  listHierarchyRewards,
} from '../master/index.ts';
import { resolveRewardRefs } from '../master/reward.ts';
import { isSandbox } from '../profile.ts';
import { sandboxHierarchyStanding } from '../profiles/sandbox/hierarchy.ts';
import {
  fieldSpecs,
  getSingleton,
  listElements,
  putSingleton,
  type FieldSpec,
} from './playerState.ts';
import { decodeMessage, Reader, type Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Port of Solis `viber/hierarchy.go` (VENUS grade notification), extended with
 * a real server-wide Platinum leaderboard: every player's rank is 1 + the
 * number of other players at Platinum or above with strictly more points.
 * Grades below Platinum ignore the rank requirement, and a player outside the
 * Platinum/Diamond/BIG4 rank window falls back to the strongest point-only
 * grade (Gold) at rank 0.
 */

export const HIERARCHY_LEADERBOARD_GRADE_IDS: readonly string[] = ['hie-001', 'hie-002', 'hie-003'];

const USER_HIERARCHY_MSG = 'Solis.Common.Proto.Transaction.UserHierarchy';
const HIERARCHY_NOTI_INFO_MSG = 'Solis.Common.Proto.Api.HierarchyNotiInfo';

/** Server-only singleton marking that a player's VENUS points were backfilled. */
const HIERARCHY_BACKFILL_FIELD = 'HierarchyBackfill';

const HIERARCHY_FIXED_POINT_TYPE = 22;
const HIERARCHY_VARIABLE_POINT_TYPE = 23;

export type Grade = {
  Id: string;
  HierarchyGradeId?: string | null;
  RequiredHierarchyPoint: number | null;
  RequiredHierarchyRank: number | null;
};

/** The grade/rank shown in the hierarchy notification. */
export type HierarchyStanding = { detailGradeId: string; gradeId: string; rank: number };

function gradeIdOf(grade: Grade): string {
  return String(grade.HierarchyGradeId ?? '');
}

function pointOf(grade: Grade): number {
  return Number(grade.RequiredHierarchyPoint ?? 0);
}

function requiredRankOf(grade: Grade): number {
  return Number(grade.RequiredHierarchyRank ?? 0);
}

export function orderedGrades(grades: Grade[]): Grade[] {
  if (grades.length === 0) throw new Error('hierarchy detail grade master data is empty');
  for (const g of grades) {
    if (!g.Id || pointOf(g) < 0 || requiredRankOf(g) < 0) {
      throw new Error('hierarchy detail grade master data is invalid');
    }
  }
  const rankKey = (g: Grade) => requiredRankOf(g) || 0x7fffffff;
  return [...grades].sort((a, b) => {
    const pa = pointOf(a);
    const pb = pointOf(b);
    if (pa !== pb) return pb - pa;
    if (rankKey(a) !== rankKey(b)) return rankKey(a) - rankKey(b);
    return a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0;
  });
}

/** Leaderboard grades (BIG4 + Diamond + Platinum) strongest first, plus Platinum's point floor. */
export function leaderboardGrades(grades: Grade[]): { minPoint: number; ordered: Grade[] } {
  const ordered = orderedGrades(grades).filter((g) => HIERARCHY_LEADERBOARD_GRADE_IDS.includes(gradeIdOf(g)));
  if (ordered.length === 0) throw new Error('hierarchy leaderboard grade master data is missing');
  return { minPoint: Math.min(...ordered.map(pointOf)), ordered };
}

/** Strongest grade below the leaderboard: point requirement only, rank ignored. */
function highestNonLeaderboardGrade(grades: Grade[], total: number): Grade {
  const candidates = orderedGrades(grades).filter((g) => !HIERARCHY_LEADERBOARD_GRADE_IDS.includes(gradeIdOf(g)));
  const found = candidates.find((g) => total >= pointOf(g));
  if (!found) throw new Error(`no hierarchy detail grade matches point ${total}`);
  return found;
}

/** Solis `ResolveHierarchyDetailGrade`: strongest grade whose point and rank requirements hold. */
export function resolveHierarchyDetailGrade(grades: Grade[], point: number, rank: number): Grade {
  if (point < 0 || rank <= 0) throw new Error('hierarchy point or rank is invalid');
  for (const grade of orderedGrades(grades)) {
    if (point < pointOf(grade)) continue;
    const requiredRank = requiredRankOf(grade);
    if (requiredRank > 0 && rank > requiredRank) continue;
    return grade;
  }
  throw new Error(`no hierarchy detail grade matches point ${point} and rank ${rank}`);
}

/**
 * Resolve the grade to show for a total and a computed server-wide rank.
 * Below Platinum the rank is ignored; at/above Platinum the strongest
 * leaderboard grade whose point and rank requirement fit wins, and a rank
 * beyond that window falls back to the point-only grade at rank 0.
 */
export function resolveHierarchyStanding(grades: Grade[], total: number, rank: number): HierarchyStanding {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('hierarchy point is invalid');
  const { minPoint, ordered } = leaderboardGrades(grades);
  if (total < minPoint) {
    const grade = highestNonLeaderboardGrade(grades, total);
    return { detailGradeId: grade.Id, gradeId: gradeIdOf(grade), rank: 0 };
  }
  if (!Number.isSafeInteger(rank) || rank <= 0) throw new Error('hierarchy leaderboard rank is invalid');
  for (const grade of ordered) {
    if (total < pointOf(grade)) continue;
    const requiredRank = requiredRankOf(grade);
    if (requiredRank > 0 && rank > requiredRank) continue;
    return { detailGradeId: grade.Id, gradeId: gradeIdOf(grade), rank };
  }
  const fallback = highestNonLeaderboardGrade(grades, total);
  return { detailGradeId: fallback.Id, gradeId: gradeIdOf(fallback), rank: 0 };
}

/** Competition rank: 1 + other players at Platinum or above with more points. Ties share. */
function leaderboardRankFor(grades: Grade[], otherTotals: readonly number[], total: number): number {
  const { minPoint } = leaderboardGrades(grades);
  let ahead = 0;
  for (const other of otherTotals) {
    if (other >= minPoint && other > total) ahead += 1;
  }
  return 1 + ahead;
}

/** Solis `HierarchyDetailGradeReached`: achieved is as strong as target or stronger. */
export function hierarchyDetailGradeReached(grades: Grade[], achievedId: string, targetId: string): boolean {
  if (!achievedId || !targetId) return false;
  const ordered = orderedGrades(grades);
  const achieved = ordered.findIndex((g) => g.Id === achievedId);
  const target = ordered.findIndex((g) => g.Id === targetId);
  if (achieved < 0) throw new Error(`unknown achieved hierarchy detail grade ${achievedId}`);
  if (target < 0) throw new Error(`unknown target hierarchy detail grade ${targetId}`);
  return achieved <= target;
}

export function strongestGradeId(grades: Grade[], first: string, second: string): string {
  if (!first) return second;
  if (!second) return first;
  return hierarchyDetailGradeReached(grades, first, second) ? first : second;
}

export async function rewardTargetGradeId(reward: { Id: string; ConditionId: string | null }): Promise<string> {
  if (!reward.Id || !reward.ConditionId) throw new Error('Hierarchy reward master data is invalid');
  const condition = await getCondition(reward.ConditionId);
  if (!condition) throw new Error(`Hierarchy reward ${reward.Id} condition is missing`);
  let target = '';
  for (const setting of (Array.isArray(condition.Settings) ? condition.Settings : []) as Decoded[]) {
    const value = setting.HierarchyDetailGradeId as Decoded | undefined;
    if (!value) continue;
    const candidate = String(value.HierarchyDetailGradeId ?? '');
    if (!candidate || target) throw new Error(`Hierarchy reward ${reward.Id} condition is invalid`);
    target = candidate;
  }
  if (!target) throw new Error(`Hierarchy reward ${reward.Id} has no detail-grade condition`);
  return target;
}

function freshHierarchy(): Decoded {
  // Solis creates an empty UserHierarchy at account creation; ours are lazy.
  return {
    __msg: USER_HIERARCHY_MSG,
    ReceivedRewardIds: [],
    ReceivedDivisionRewardIds: [],
  } as Decoded;
}

function hierarchyTotal(hierarchy: Decoded): number {
  const fixed = Number(hierarchy.CurrentFixedPoint ?? 0);
  const variable = Number(hierarchy.CurrentVariablePoint ?? 0);
  if (!Number.isSafeInteger(fixed) || !Number.isSafeInteger(variable) || fixed < 0 || variable < 0) {
    throw new Error('hierarchy point is invalid');
  }
  const total = fixed + variable;
  if (!Number.isSafeInteger(total)) throw new Error('hierarchy point overflow');
  return total;
}

function hierarchySpec(): FieldSpec {
  const spec = fieldSpecs().find((s) => s.field === 'Hierarchy');
  if (!spec) throw new Error('Hierarchy singleton schema is missing');
  return spec;
}

/**
 * Totals of every backfilled player's UserHierarchy row (one bulk read, no
 * per-player query). Only backfilled players are ranked: captured corpus seeds
 * may carry official point values that are not real on this server. A player
 * without the `HierarchyBackfill` singleton is skipped and is backfilled on
 * their next login.
 */
export async function listHierarchyTotals(exec: Executor = db): Promise<Array<{ playerId: string; total: number }>> {
  const spec = hierarchySpec();
  const backfilledRows = await exec
    .select({ playerId: playerEntities.playerId })
    .from(playerEntities)
    .where(eq(playerEntities.kind, HIERARCHY_BACKFILL_FIELD));
  const backfilled = new Set(backfilledRows.map((row) => String(row.playerId)));
  const rows = await exec
    .select({ playerId: playerEntities.playerId, blob: playerEntities.blob })
    .from(playerEntities)
    .where(eq(playerEntities.kind, 'Hierarchy'));
  const totals: Array<{ playerId: string; total: number }> = [];
  for (const row of rows) {
    const playerId = String(row.playerId);
    if (!backfilled.has(playerId)) continue;
    let total: number;
    try {
      const decoded = decodeMessage(spec.shape, new Reader(Uint8Array.from(Buffer.from(row.blob, 'base64'))));
      total = hierarchyTotal(decoded);
    } catch {
      // A corrupt or invalid seed row must not break the whole leaderboard.
      continue;
    }
    totals.push({ playerId, total });
  }
  return totals;
}

/** Totals of every OTHER player's UserHierarchy row. */
async function otherHierarchyTotals(playerId: string, exec: Executor): Promise<number[]> {
  const totals = await listHierarchyTotals(exec);
  return totals.filter((entry) => entry.playerId !== playerId).map((entry) => entry.total);
}

/**
 * VENUS fixed points never existed before hierarchy grants were implemented:
 * main-quest clear rewards (resource type 22) were dropped by `applyGrants`,
 * so a player who already cleared quests has no record of them. The lazy
 * backfill sums the type-22 amount of every main quest the player has cleared
 * and REPLACES `CurrentFixedPoint` with that sum. Replacing, not adding, is
 * deliberate: the value can only have come from the old sandbox display seed
 * (a fake 25000), and replacing makes the backfill idempotent even though it
 * is keyed by the `HierarchyBackfill` singleton rather than by quest history.
 *
 * The singleton is absent for every existing player, so the first
 * `loadUserHierarchy` for that player performs the backfill and then records
 * `{ doneAt, fixedPoint }`; later loads (and grants) skip it entirely.
 */
async function backfillHierarchyPoint(playerId: string, exec: Executor): Promise<void> {
  if (await getSingleton(playerId, HIERARCHY_BACKFILL_FIELD, exec)) return;

  let fixedPoint = 0;
  for (const quest of await listElements(playerId, 'Quests', exec)) {
    if (Number(quest.LastClearedTime ?? 0) <= 0) continue;
    const row = await getQuest(String(quest.QuestId ?? ''));
    if (!row?.ClearRewardId) continue;
    for (const grant of await resolveRewardRefs([row.ClearRewardId])) {
      if (grant.resourceType !== HIERARCHY_FIXED_POINT_TYPE) continue;
      const next = fixedPoint + grant.amount;
      if (!Number.isSafeInteger(next)) throw new Error('hierarchy backfill point overflow');
      fixedPoint = next;
    }
  }

  const hierarchy = (await getSingleton(playerId, 'Hierarchy', exec)) ?? freshHierarchy();
  const variable = Number(hierarchy.CurrentVariablePoint ?? 0);
  if (variable < 0) throw new Error('hierarchy point is negative');
  const total = fixedPoint + variable;
  if (!Number.isSafeInteger(total)) throw new Error('hierarchy backfill point overflow');

  hierarchy.CurrentFixedPoint = fixedPoint;
  hierarchy.BestTotalPoint = total;
  // Reconcile recomputes the stored best grade from the new total.
  hierarchy.BestDetailGradeId = '';
  await putSingleton(playerId, 'Hierarchy', hierarchy, exec);
  await putSingleton(
    playerId,
    HIERARCHY_BACKFILL_FIELD,
    { doneAt: Date.now(), fixedPoint } as Decoded,
    exec,
  );
}

/**
 * Load a player's UserHierarchy, running the one-time point backfill first.
 * Returns a fresh (unsaved) entity when the player has none yet.
 */
export async function loadUserHierarchy(playerId: string, exec: Executor = db): Promise<Decoded> {
  await backfillHierarchyPoint(playerId, exec);
  return (await getSingleton(playerId, 'Hierarchy', exec)) ?? freshHierarchy();
}

/**
 * Solis `grantHierarchyPoint`: add fixed (22) or variable (23) VENUS points,
 * raise the best-total high-water mark, then reconcile the grade notification.
 * Returns the stored UserHierarchy plus the touched resource's before/after.
 */
export async function grantHierarchyPoint(
  playerId: string,
  resourceType: typeof HIERARCHY_FIXED_POINT_TYPE | typeof HIERARCHY_VARIABLE_POINT_TYPE,
  amount: number,
  exec: Executor = db,
): Promise<{ hierarchy: Decoded; before: number; after: number }> {
  if (resourceType !== HIERARCHY_FIXED_POINT_TYPE && resourceType !== HIERARCHY_VARIABLE_POINT_TYPE) {
    throw new Error(`unknown hierarchy resource type ${resourceType}`);
  }
  if (!Number.isSafeInteger(amount)) throw new Error('hierarchy grant amount is invalid');

  const hierarchy = await loadUserHierarchy(playerId, exec);
  const fixed = Number(hierarchy.CurrentFixedPoint ?? 0);
  const variable = Number(hierarchy.CurrentVariablePoint ?? 0);
  if (fixed < 0 || variable < 0) throw new Error('hierarchy point is negative');

  const before = resourceType === HIERARCHY_FIXED_POINT_TYPE ? fixed : variable;
  const after = before + amount;
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('hierarchy point overflow');

  if (resourceType === HIERARCHY_FIXED_POINT_TYPE) hierarchy.CurrentFixedPoint = after;
  else hierarchy.CurrentVariablePoint = after;
  hierarchy.CurrentPointUpdateDatetime = Date.now();
  await putSingleton(playerId, 'Hierarchy', hierarchy, exec);

  const reconciled = await reconcileHierarchyNotification(playerId, exec);
  const stored = reconciled.hierarchy ?? (await getSingleton(playerId, 'Hierarchy', exec)) ?? hierarchy;
  return { hierarchy: stored, before, after };
}

/**
 * Compute the player's grade/rank: total points plus the server-wide
 * competition rank from every other player's UserHierarchy row. In the sandbox
 * every player is BIG4 rank 1 and the leaderboard is off, so no other player's
 * totals are read; the real total is still returned.
 */
export async function loadHierarchyStanding(
  playerId: string,
  exec: Executor = db,
): Promise<HierarchyStanding & { total: number }> {
  const hierarchy = await loadUserHierarchy(playerId, exec);
  const total = hierarchyTotal(hierarchy);
  if (isSandbox()) return { total, ...sandboxHierarchyStanding() };
  const grades = (await listHierarchyDetailGrades()) as Grade[];
  const others = await otherHierarchyTotals(playerId, exec);
  const rank = leaderboardRankFor(grades, others, total);
  return { total, ...resolveHierarchyStanding(grades, total, rank) };
}

/**
 * Solis `ReconcileHierarchyNotification`: refresh the best grade high-water
 * mark and build the notification. Returns the UserHierarchy when it changed.
 *
 * The stored best point and best grade are always the real ones, in both
 * profiles. Only the grade and rank reported in the notification info are
 * replaced with the sandbox BIG4 standing; the sandbox grade is never written
 * to `UserHierarchy`.
 */
export async function reconcileHierarchyNotification(
  playerId: string,
  exec: Executor = db,
): Promise<{ info: Decoded; hierarchy: Decoded | null }> {
  const hierarchy = await loadUserHierarchy(playerId, exec);
  const total = hierarchyTotal(hierarchy);

  const grades = (await listHierarchyDetailGrades()) as Grade[];
  const others = await otherHierarchyTotals(playerId, exec);
  const rank = leaderboardRankFor(grades, others, total);
  const standing = resolveHierarchyStanding(grades, total, rank);
  const reported = isSandbox() ? sandboxHierarchyStanding() : standing;

  const storedBest = Number(hierarchy.BestTotalPoint ?? 0);
  if (storedBest < 0) throw new Error('Hierarchy best point is invalid');
  const bestPoint = Math.max(storedBest, total);
  // The best-grade high-water mark is graded like a current standing, so a
  // player who has spent nothing keeps their historic grade at its new rank.
  const bestRank = bestPoint === total ? rank : leaderboardRankFor(grades, others, bestPoint);
  const bestPointGrade = resolveHierarchyStanding(grades, bestPoint, bestRank);
  const achievedId = strongestGradeId(grades, bestPointGrade.detailGradeId, String(hierarchy.BestDetailGradeId ?? ''));
  const changed =
    storedBest !== bestPoint || String(hierarchy.BestDetailGradeId ?? '') !== achievedId;
  hierarchy.BestTotalPoint = bestPoint;
  hierarchy.BestDetailGradeId = achievedId;

  const received = new Set((hierarchy.ReceivedRewardIds as string[] | undefined) ?? []);
  const rewardIds: string[] = [];
  for (const reward of await listHierarchyRewards()) {
    const target = await rewardTargetGradeId(reward);
    if (hierarchyDetailGradeReached(grades, achievedId, target) && !received.has(reward.Id)) rewardIds.push(reward.Id);
  }
  const receivedDivision = new Set((hierarchy.ReceivedDivisionRewardIds as string[] | undefined) ?? []);
  const divisionRewardIds: string[] = [];
  for (const reward of await listHierarchyDivisionRewards()) {
    if (!reward.DetailGradeId) throw new Error(`Hierarchy division reward ${reward.Id} has no detail grade`);
    if (hierarchyDetailGradeReached(grades, achievedId, reward.DetailGradeId) && !receivedDivision.has(reward.Id)) {
      divisionRewardIds.push(reward.Id);
    }
  }

  if (changed) await putSingleton(playerId, 'Hierarchy', hierarchy, exec);
  // not ported: Solis also persists the notification (UserHierarchyNotiInfo) for Home:Enter.
  const info = {
    __msg: HIERARCHY_NOTI_INFO_MSG,
    RewardIds: rewardIds,
    DivisionRewardIds: divisionRewardIds,
    CurrentDetailGradeId: reported.detailGradeId,
    CurrentRank: reported.rank,
  } as Decoded;
  return { info, hierarchy: changed ? hierarchy : null };
}
