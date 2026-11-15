/**
 * Marathon event story and event mission info for `Marathon:Top` and
 * `Mission:Event`. The story is the master EventStory row whose AssetId is the
 * marathon's assetId. The missions are the master Mission rows whose
 * EventMissionId is the marathon's eventMissionId.
 */
import { eq } from 'drizzle-orm';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { db } from '../../db/client.ts';
import * as master from '../../db/masterSchema.ts';
import type { Executor } from '../../db/tx.ts';
import { listElements, putElements } from '../playerState.ts';
import type { MarathonConfig } from './catalog.ts';

const EVENT_STORY_INFO_MSG = 'Solis.Common.Proto.Api.EventStoryInfo';
const EVENT_STORY_EPISODE_INFO_MSG = 'Solis.Common.Proto.Api.EventStoryEpisodeInfo';
const EVENT_MISSION_INFO_MSG = 'Solis.Common.Proto.Api.EventMissionInfo';
const USER_MISSION_MSG = 'Solis.Common.Proto.Transaction.UserMission';

// MissionStatusType_Progress (phase3d dump.cs, enum MissionStatusType).
const STATUS_PROGRESS = 1;
// MissionCategoryType_Daily (phase3d dump.cs, enum MissionCategoryType).
const CATEGORY_DAILY = 1;

/** JST is UTC+9 with no DST, so a calendar day starts at 15:00 UTC. */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function sameJstDay(a: number, b: number): boolean {
  return Math.floor((a + JST_OFFSET_MS) / DAY_MS) === Math.floor((b + JST_OFFSET_MS) / DAY_MS);
}

/** A brand-new, untouched UserMission row for a marathon event mission. */
export function freshMarathonMission(missionId: string, firstThreshold: number, now: number): Decoded {
  return {
    __msg: USER_MISSION_MSG,
    MissionId: missionId,
    CurrentThreshold: firstThreshold,
    Progress: 0,
    StatusType: STATUS_PROGRESS,
    LastUpdateTime: now,
  } as Decoded;
}


export type EventStoryRow = {
  Id: string;
  Episodes?: Array<{ Episode?: number }> | null;
};

export type EventMissionRef = { id: string; firstThreshold: number };

/** EventStoryInfo with every episode unlocked, sorted by episode number. */
export function buildEventStoryInfo(story: EventStoryRow | null | undefined): Decoded | undefined {
  if (!story) return undefined;
  const episodes = (story.Episodes ?? [])
    .map((e) => ({ __msg: EVENT_STORY_EPISODE_INFO_MSG, Episode: Number(e.Episode ?? 0), Unlocked: true }) as Decoded)
    .sort((a, b) => Number(a.Episode) - Number(b.Episode));
  return { __msg: EVENT_STORY_INFO_MSG, Id: story.Id, Episodes: episodes } as Decoded;
}

/**
 * EventMissionInfo with one UserMission per mission, in `missions` order. A
 * player's existing element is kept as-is; a missing one starts at Progress 0.
 */
export function buildEventMissionInfo(args: {
  eventMissionId: string;
  missions: EventMissionRef[];
  userMissions: Decoded[];
}): Decoded {
  const byMission = new Map<string, Decoded>();
  for (const um of args.userMissions) byMission.set(String(um.MissionId ?? ''), um);

  const userMissions = args.missions.map((m) => {
    const existing = byMission.get(m.id);
    if (existing) return { ...existing, __msg: USER_MISSION_MSG } as Decoded;
    return {
      __msg: USER_MISSION_MSG,
      MissionId: m.id,
      CurrentThreshold: m.firstThreshold,
      Progress: 0,
      StatusType: STATUS_PROGRESS,
    } as Decoded;
  });

  return {
    __msg: EVENT_MISSION_INFO_MSG,
    Id: args.eventMissionId,
    Unlocked: true,
    UserMissions: userMissions,
  } as Decoded;
}

/** The master EventStory row for the marathon's assetId, or null. */
export async function loadMarathonEventStory(
  config: Pick<MarathonConfig, 'assetId'> | undefined,
): Promise<EventStoryRow | null> {
  const assetId = config?.assetId ?? '';
  if (assetId === '') return null;
  const [row] = await db
    .select()
    .from(master.masterEventStory)
    .where(eq(master.masterEventStory.AssetId, assetId))
    .limit(1);
  return (row as unknown as EventStoryRow | undefined) ?? null;
}

/**
 * Identity of an event mission for the player: mission type, the unordered
 * target set, and the ordered (Threshold, RewardSetId) pairs. CategoryType,
 * Name, ViewConditionId and Order are deliberately excluded: two masters that
 * differ only in their date window are the same mission to the player.
 */
function eventMissionKey(mission: Decoded): string {
  const missionType = String(mission.MissionType ?? '');
  const targetIds = (Array.isArray(mission.TargetIds) ? (mission.TargetIds as unknown[]) : [])
    .map((id) => String(id))
    .sort();
  const progresses = (Array.isArray(mission.Progresses) ? (mission.Progresses as Decoded[]) : []).map((p) => [
    Number(p?.Threshold ?? 0),
    p?.RewardSetId == null ? null : String(p.RewardSetId),
  ]);
  return JSON.stringify([missionType, targetIds, progresses]);
}

/**
 * Drop master missions that duplicate an earlier kept mission, keeping the
 * order of the survivors.
 */
export function dedupeEventMissions(masters: Decoded[]): Decoded[] {
  const seen = new Set<string>();
  const kept: Decoded[] = [];
  for (const mission of masters) {
    const key = eventMissionKey(mission);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(mission);
  }
  return kept;
}

function lowestThreshold(progresses: unknown): number {
  if (!Array.isArray(progresses)) return 0;
  const values = progresses.map((p) => Number((p as Decoded | null)?.Threshold ?? 0));
  return values.length > 0 ? Math.min(...values) : 0;
}

/**
 * The master Mission rows of the marathon's event mission, ordered by the
 * master EventMission MissionIds. Missions not listed there go last, by id.
 * Missions that are identical for the player (same type, targets, thresholds
 * and rewards) are collapsed to the first one, because their date windows
 * (ViewConditionId) are not applied.
 */
export async function loadMarathonMissionMasterRows(eventMissionId: string): Promise<Decoded[]> {
  if (eventMissionId === '') return [];

  const rows = await db
    .select()
    .from(master.masterMission)
    .where(eq(master.masterMission.EventMissionId, eventMissionId));
  const [eventMission] = await db
    .select()
    .from(master.masterEventMission)
    .where(eq(master.masterEventMission.Id, eventMissionId))
    .limit(1);

  const listed = Array.isArray(eventMission?.MissionIds) ? (eventMission.MissionIds as unknown[]) : [];
  const rank = new Map(listed.map((id, i) => [String(id), i]));
  const rankOf = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;

  return dedupeEventMissions(
    [...rows]
      .sort((a, b) => {
        const diff = rankOf(a.Id) - rankOf(b.Id);
        if (diff !== 0) return diff;
        return a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0;
      })
      .map((r) => r as unknown as Decoded),
  );
}

/**
 * Missions of the marathon's event mission, ordered by the master EventMission
 * MissionIds.
 */
export async function loadMarathonMissions(
  config: Pick<MarathonConfig, 'eventMissionId'> | undefined,
): Promise<EventMissionRef[]> {
  const rows = await loadMarathonMissionMasterRows(config?.eventMissionId ?? '');
  return rows.map((r) => ({ id: String(r.Id), firstThreshold: lowestThreshold(r.Progresses) }));
}

/**
 * Return one stored UserMission per master event mission, creating missing rows
 * and resetting daily missions whose LastUpdateTime is not on the current JST
 * calendar day. The result keeps the master mission order.
 */
export async function ensureMarathonMissionRows(
  playerId: string,
  eventMissionId: string,
  now: number,
  exec: Executor = db,
): Promise<Decoded[]> {
  const masters = await loadMarathonMissionMasterRows(eventMissionId);
  if (masters.length === 0) return [];

  const stored = await listElements(playerId, 'Missions', exec);
  const byId = new Map(stored.map((row) => [String(row.MissionId ?? ''), row]));
  const changed: Decoded[] = [];
  const result: Decoded[] = [];

  for (const masterRow of masters) {
    const missionId = String(masterRow.Id ?? '');
    if (missionId === '') continue;
    const firstThreshold = lowestThreshold(masterRow.Progresses);
    const existing = byId.get(missionId);
    let row: Decoded;
    if (!existing) {
      row = freshMarathonMission(missionId, firstThreshold, now);
      changed.push(row);
    } else if (
      Number(masterRow.CategoryType ?? 0) === CATEGORY_DAILY &&
      !sameJstDay(now, Number(existing.LastUpdateTime ?? 0))
    ) {
      row = freshMarathonMission(missionId, firstThreshold, now);
      changed.push(row);
    } else {
      row = existing;
    }
    result.push(row);
  }

  if (changed.length > 0) await putElements(playerId, 'Missions', changed, exec);
  return result;
}

/** EventMissionInfo for a player, or undefined when the marathon has no event mission. */
export async function marathonEventMissionInfo(
  playerId: string,
  config: Pick<MarathonConfig, 'eventMissionId'> | undefined,
  exec: Executor = db,
): Promise<Decoded | undefined> {
  const eventMissionId = config?.eventMissionId ?? '';
  if (eventMissionId === '') return undefined;
  const userMissions = await ensureMarathonMissionRows(playerId, eventMissionId, Date.now(), exec);
  const missions = userMissions.map((row) => ({
    id: String(row.MissionId ?? ''),
    firstThreshold: Number(row.CurrentThreshold ?? 0),
  }));
  return buildEventMissionInfo({ eventMissionId, missions, userMissions });
}
