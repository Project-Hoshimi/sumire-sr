import { db } from '../db/client.ts';
import type { Executor } from '../db/tx.ts';
import {
  getCondition,
  listHierarchyDetailGrades,
  listHierarchyDivisionRewards,
  listHierarchyRewards,
} from '../master/index.ts';
import { getSingleton, putSingleton } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Port of Solis `viber/hierarchy.go` (Venus grade notification). The private
 * server has no ranking, so every player is rank 1, as in Solis.
 */

export const HIERARCHY_PRIVATE_SERVER_RANK = 1;

const USER_HIERARCHY_MSG = 'Solis.Common.Proto.Transaction.UserHierarchy';
const HIERARCHY_NOTI_INFO_MSG = 'Solis.Common.Proto.Api.HierarchyNotiInfo';

type Grade = { Id: string; RequiredHierarchyPoint: number | null; RequiredHierarchyRank: number | null };

function orderedGrades(grades: Grade[]): Grade[] {
  if (grades.length === 0) throw new Error('hierarchy detail grade master data is empty');
  for (const g of grades) {
    if (!g.Id || Number(g.RequiredHierarchyPoint ?? 0) < 0 || Number(g.RequiredHierarchyRank ?? 0) < 0) {
      throw new Error('hierarchy detail grade master data is invalid');
    }
  }
  const rankKey = (g: Grade) => Number(g.RequiredHierarchyRank ?? 0) || 0x7fffffff;
  return [...grades].sort((a, b) => {
    const pa = Number(a.RequiredHierarchyPoint ?? 0);
    const pb = Number(b.RequiredHierarchyPoint ?? 0);
    if (pa !== pb) return pb - pa;
    if (rankKey(a) !== rankKey(b)) return rankKey(a) - rankKey(b);
    return a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0;
  });
}

/** Solis `ResolveHierarchyDetailGrade`: strongest grade whose point and rank requirements hold. */
export function resolveHierarchyDetailGrade(grades: Grade[], point: number, rank: number): Grade {
  if (point < 0 || rank <= 0) throw new Error('hierarchy point or rank is invalid');
  for (const grade of orderedGrades(grades)) {
    if (point < Number(grade.RequiredHierarchyPoint ?? 0)) continue;
    const requiredRank = Number(grade.RequiredHierarchyRank ?? 0);
    if (requiredRank > 0 && rank > requiredRank) continue;
    return grade;
  }
  throw new Error(`no hierarchy detail grade matches point ${point} and rank ${rank}`);
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

function strongestGradeId(grades: Grade[], first: string, second: string): string {
  if (!first) return second;
  if (!second) return first;
  return hierarchyDetailGradeReached(grades, first, second) ? first : second;
}

async function rewardTargetGradeId(reward: { Id: string; ConditionId: string | null }): Promise<string> {
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

/**
 * Solis `ReconcileHierarchyNotification`: refresh the best grade high-water
 * mark and build the notification. Returns the UserHierarchy when it changed.
 */
export async function reconcileHierarchyNotification(
  playerId: string,
  rank: number,
  exec: Executor = db,
): Promise<{ info: Decoded; hierarchy: Decoded | null }> {
  // Solis creates an empty UserHierarchy at account creation; ours are created lazily.
  const hierarchy = (await getSingleton(playerId, 'Hierarchy', exec)) ?? {
    __msg: USER_HIERARCHY_MSG,
    ReceivedRewardIds: [],
    ReceivedDivisionRewardIds: [],
  };
  const fixed = Number(hierarchy.CurrentFixedPoint ?? 0);
  const variable = Number(hierarchy.CurrentVariablePoint ?? 0);
  if (fixed < 0 || variable < 0) throw new Error('hierarchy point is negative');
  const point = fixed + variable;

  const grades = (await listHierarchyDetailGrades()) as Grade[];
  const currentGrade = resolveHierarchyDetailGrade(grades, point, rank);
  const storedBest = Number(hierarchy.BestTotalPoint ?? 0);
  if (storedBest < 0) throw new Error('Hierarchy best point is invalid');
  const bestPoint = Math.max(storedBest, point);
  const bestPointGrade = resolveHierarchyDetailGrade(grades, bestPoint, rank);
  const achievedId = strongestGradeId(grades, bestPointGrade.Id, String(hierarchy.BestDetailGradeId ?? ''));
  const changed = storedBest !== bestPoint || String(hierarchy.BestDetailGradeId ?? '') !== achievedId;
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
    CurrentDetailGradeId: currentGrade.Id,
    CurrentRank: rank,
  } as Decoded;
  return { info, hierarchy: changed ? hierarchy : null };
}
