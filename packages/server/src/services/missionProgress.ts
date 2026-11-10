import { db } from '../db/client.ts';
import type { Executor } from '../db/tx.ts';
import { listMissions } from '../master/index.ts';
import { listElements, putElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Port of Solis `viber/mission_progress.go`: gameplay advances only missions
 * that are already active for the player; nothing here creates mission rows.
 */

const USER_MISSION_MSG = 'Solis.Common.Proto.Transaction.UserMission';

export const MISSION_STATUS_PROGRESS = 1;
export const MISSION_STATUS_CLEAR = 2;
export const MISSION_STATUS_NOT_RECEIVED = 3;

export const MissionType = {
  MissionClearCount: 3,
  QuestMainClearCount: 5,
  QuestContestClearCount: 6,
  QuestDailyClearCount: 7,
  QuestTowerClearCount: 9,
  QuestAllClearCount: 11,
  CardLevelUpCount: 12,
  ContestTotalScoreAchievement: 26,
  QuestSubTowerClearCount: 52,
  CharacterQuestAllClearCount: 66,
  QuestAllScoreAchievement: 75,
  CharacterQuestContestScoreAchievement: 80,
  AreaAllMainQuestClearCountAchievement: 82,
  AreaAllTowerQuestClearCountAchievement: 83,
  AreaSubTowerQuestClearCountAchievement: 84,
  ReliabilityAchievement: 49,
} as const;

/** Solis `AdvanceUserMissions`: adds `amount` to matching active missions. */
export function advanceUserMissions(
  playerId: string,
  missionType: number,
  amount: number,
  targetIds: string[],
  exec: Executor = db,
): Promise<Decoded[]> {
  return updateUserMissions(playerId, missionType, amount, false, targetIds, exec);
}

/** Solis `ReachUserMissions`: records an achievement value; never lowers progress. */
export function reachUserMissions(
  playerId: string,
  missionType: number,
  value: number,
  targetIds: string[],
  exec: Executor = db,
): Promise<Decoded[]> {
  return updateUserMissions(playerId, missionType, value, true, targetIds, exec);
}

async function updateUserMissions(
  playerId: string,
  missionType: number,
  amount: number,
  reach: boolean,
  targetIds: string[],
  exec: Executor,
): Promise<Decoded[]> {
  const active = (await listElements(playerId, 'Missions', exec)).filter(missionCanProgress);
  if (active.length === 0) return [];
  if (amount <= 0) throw new Error('mission progress amount must be positive');
  const masters = new Map((await listMissions()).map((row) => [String(row.Id), row as unknown as Decoded]));
  const userById = new Map(active.map((row) => [String(row.MissionId), row]));

  const now = Date.now();
  const changed = new Map<string, Decoded>();
  let completed: string[] = [];
  for (const mission of active) {
    const master = masters.get(String(mission.MissionId));
    if (!master || Number(master.MissionType) !== missionType) continue;
    if (!missionTargetsMatch(stringList(master.TargetIds), targetIds)) continue;
    const step = reach
      ? reachMissionProgress(mission, master, amount, now)
      : addMissionProgress(mission, master, amount, now);
    if (!step.changed) continue;
    changed.set(String(mission.MissionId), mission);
    if (step.newlyCompleted) completed.push(String(mission.MissionId));
  }

  // A newly cleared mission counts once toward each active MissionClearCount
  // mission naming it; that may clear further parents.
  while (completed.length > 0) {
    const increments = new Map<string, number>();
    const hasParent = new Set<string>();
    for (const parent of active) {
      const parentMaster = masters.get(String(parent.MissionId));
      if (!parentMaster || Number(parentMaster.MissionType) !== MissionType.MissionClearCount) continue;
      if (!missionCanProgress(parent)) continue;
      const targets = stringList(parentMaster.TargetIds);
      for (const childId of completed) {
        if (!targets.includes(childId)) continue;
        increments.set(String(parent.MissionId), (increments.get(String(parent.MissionId)) ?? 0) + 1);
        hasParent.add(childId);
      }
    }
    for (const childId of completed) {
      const child = userById.get(childId)!;
      child.StatusType = hasParent.has(childId) ? MISSION_STATUS_CLEAR : MISSION_STATUS_NOT_RECEIVED;
    }
    const next: string[] = [];
    for (const [parentId, increment] of increments) {
      const parent = userById.get(parentId)!;
      const step = addMissionProgress(parent, masters.get(parentId)!, increment, now);
      if (!step.changed) continue;
      changed.set(parentId, parent);
      if (step.newlyCompleted) next.push(parentId);
    }
    completed = next;
  }

  const rows = [...changed.values()];
  for (const row of rows) if (!row.__msg) row.__msg = USER_MISSION_MSG;
  if (rows.length > 0) await putElements(playerId, 'Missions', rows, exec);
  return rows;
}

function reachMissionProgress(mission: Decoded, master: Decoded, value: number, now: number) {
  if (value <= Number(mission.Progress ?? 0)) return { newlyCompleted: false, changed: false };
  return addMissionProgress(mission, master, value - Number(mission.Progress ?? 0), now);
}

function addMissionProgress(mission: Decoded, master: Decoded, amount: number, now: number) {
  if (!missionCanProgress(mission)) return { newlyCompleted: false, changed: false };
  const progress = Number(mission.Progress ?? 0);
  const current = Number(mission.CurrentThreshold ?? 0);
  if (progress < 0 || current <= 0) {
    throw new Error(`mission ${String(mission.MissionId)} has invalid user progress`);
  }
  const thresholds = (Array.isArray(master.Progresses) ? (master.Progresses as Decoded[]) : []).map((p) =>
    Number(p.Threshold ?? 0),
  );
  const maxThreshold = Math.max(0, ...thresholds);
  if (!thresholds.includes(current) || maxThreshold <= 0) {
    throw new Error(`mission ${String(mission.MissionId)} user threshold is absent from master data`);
  }
  const oldStatus = Number(mission.StatusType ?? 0);
  mission.Progress = Math.min(maxThreshold, progress + amount);
  mission.LastUpdateTime = now;
  if (oldStatus === MISSION_STATUS_CLEAR && Number(mission.Progress) >= current) {
    mission.StatusType = MISSION_STATUS_NOT_RECEIVED;
  }
  return { newlyCompleted: oldStatus === MISSION_STATUS_PROGRESS && Number(mission.Progress) >= current, changed: true };
}

function missionCanProgress(mission: Decoded): boolean {
  const status = Number(mission.StatusType ?? 0);
  return status === MISSION_STATUS_PROGRESS || status === MISSION_STATUS_CLEAR || status === MISSION_STATUS_NOT_RECEIVED;
}

function missionTargetsMatch(masterTargetIds: string[], actionTargetIds: string[]): boolean {
  if (masterTargetIds.length === 0) return true;
  return actionTargetIds.some((id) => masterTargetIds.includes(id));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
