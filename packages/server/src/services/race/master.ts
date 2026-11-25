// Typed accessors for the Race (レース) master partitions. Race quests carry no
// race id column, so a race owns every quest whose id starts with
// `race-qt-<YY-MMDD>-`; the board areas are the distinct `RaceAreaId` values of
// the panel rows that point at one of those quests.
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import type { Executor } from '../../db/tx.ts';
import * as master from '../../db/masterSchema.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { ConditionEvaluator } from '../conditions.ts';
import { raceQuestIdPrefix } from './types.ts';

/** Every `RaceQuest` row of a race, ordered by `Order` then id. */
export async function listRaceQuests(raceId: string) {
  const prefix = raceQuestIdPrefix(raceId);
  if (prefix === '') return [];
  return db
    .select()
    .from(master.masterRaceQuest)
    .where(like(master.masterRaceQuest.Id, `${prefix}%`))
    .orderBy(asc(master.masterRaceQuest.Order), asc(master.masterRaceQuest.Id));
}

/** The pt (1) and medal (2) area quests of a race, keyed by reward type. */
export async function listRaceAreaQuests(raceId: string) {
  const prefix = raceQuestIdPrefix(raceId);
  if (prefix === '') return [];
  return db
    .select()
    .from(master.masterRaceQuest)
    .where(
      and(
        like(master.masterRaceQuest.Id, `${prefix}%`),
        sql`${master.masterRaceQuest.ActivityLessonRewardType} is not null`,
      ),
    )
    .orderBy(asc(master.masterRaceQuest.Order), asc(master.masterRaceQuest.Id));
}

export async function getRaceQuest(id: string) {
  const [row] = await db
    .select()
    .from(master.masterRaceQuest)
    .where(eq(master.masterRaceQuest.Id, id))
    .limit(1);
  return row ?? null;
}

/** Every difficulty tier of one race quest, ordered by `DifficultyNumber`. */
export async function listRaceQuestDifficulties(raceQuestId: string) {
  return db
    .select()
    .from(master.masterRaceQuestDifficulty)
    .where(eq(master.masterRaceQuestDifficulty.RaceQuestId, raceQuestId))
    .orderBy(asc(master.masterRaceQuestDifficulty.DifficultyNumber));
}

/**
 * `UnlockConditionId`s of `difficulties` that the player already satisfies by
 * manager level. Feeds `tierUnlocked`'s `managerLevelConditions`, so a tier
 * whose condition is `[{}, {ManagerLevel: {LevelGte}}]` opens once the level is
 * reached, without clearing the previous tier.
 */
export async function managerLevelUnlockConditions(
  playerId: string,
  difficulties: readonly Decoded[],
  now: number,
  exec: Executor = db,
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      difficulties
        .map((row) => (row.UnlockConditionId == null ? '' : String(row.UnlockConditionId)))
        .filter((id) => id !== ''),
    ),
  ];
  const unlocked = new Set<string>();
  if (ids.length === 0) return unlocked;
  const evaluator = new ConditionEvaluator(playerId, now, exec);
  await evaluator.prime(ids);
  for (const id of ids) {
    if (await evaluator.managerLevelUnlocked(id)) unlocked.add(id);
  }
  return unlocked;
}

export async function getRaceQuestDifficulty(raceQuestId: string, difficultyNumber: number) {
  const [row] = await db
    .select()
    .from(master.masterRaceQuestDifficulty)
    .where(
      and(
        eq(master.masterRaceQuestDifficulty.RaceQuestId, raceQuestId),
        eq(master.masterRaceQuestDifficulty.DifficultyNumber, difficultyNumber),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Board area ids of a race: the distinct `RaceAreaId` of the panel rows whose
 * `RaceQuestId` belongs to the race, sorted ascending. A race whose board rows
 * are missing in master data yields an empty list.
 */
export async function listRaceAreaIds(raceId: string): Promise<string[]> {
  const prefix = raceQuestIdPrefix(raceId);
  if (prefix === '') return [];
  const rows = await db
    .selectDistinct({ RaceAreaId: master.masterRacePanel.RaceAreaId })
    .from(master.masterRacePanel)
    .where(like(master.masterRacePanel.RaceQuestId, `${prefix}%`))
    .orderBy(asc(master.masterRacePanel.RaceAreaId));
  return rows.map((row) => String(row.RaceAreaId ?? '')).filter((id) => id !== '');
}

/** Every panel of one area, ordered by `Number`. */
export async function listRacePanels(raceAreaId: string) {
  return db
    .select()
    .from(master.masterRacePanel)
    .where(eq(master.masterRacePanel.RaceAreaId, raceAreaId))
    .orderBy(asc(master.masterRacePanel.Number));
}

/** Every panel of several areas at once, ordered by area then `Number`. */
export async function listRacePanelsByAreas(raceAreaIds: readonly string[]) {
  if (raceAreaIds.length === 0) return [];
  return db
    .select()
    .from(master.masterRacePanel)
    .where(inArray(master.masterRacePanel.RaceAreaId, [...raceAreaIds]))
    .orderBy(asc(master.masterRacePanel.RaceAreaId), asc(master.masterRacePanel.Number));
}

export async function getRacePanel(raceAreaId: string, number: number) {
  const [row] = await db
    .select()
    .from(master.masterRacePanel)
    .where(
      and(
        eq(master.masterRacePanel.RaceAreaId, raceAreaId),
        eq(master.masterRacePanel.Number, number),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Panel count per area id; areas without rows are absent from the map. */
export async function countRacePanels(areaIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (areaIds.length === 0) return counts;
  const rows = await db
    .select({ RaceAreaId: master.masterRacePanel.RaceAreaId, count: sql<number>`count(*)::int` })
    .from(master.masterRacePanel)
    .where(inArray(master.masterRacePanel.RaceAreaId, [...areaIds]))
    .groupBy(master.masterRacePanel.RaceAreaId);
  for (const row of rows) counts.set(String(row.RaceAreaId ?? ''), Number(row.count ?? 0));
  return counts;
}

export async function getRacePanelReward(id: string, raceId?: string) {
  // `master_RacePanelReward` is keyed by (Id, RaceId): the same reward id is
  // reused by several races, so callers pass their race to disambiguate.
  const where =
    raceId === undefined
      ? eq(master.masterRacePanelReward.Id, id)
      : and(eq(master.masterRacePanelReward.Id, id), eq(master.masterRacePanelReward.RaceId, raceId));
  const [row] = await db.select().from(master.masterRacePanelReward).where(where).limit(1);
  return row ?? null;
}

/** `RacePanelReward` rows of one race for a panel reward id batch. */
export async function listRacePanelRewards(raceId: string, ids: readonly string[]) {
  if (raceId === '' || ids.length === 0) return [];
  return db
    .select()
    .from(master.masterRacePanelReward)
    .where(
      and(
        eq(master.masterRacePanelReward.RaceId, raceId),
        inArray(master.masterRacePanelReward.Id, [...ids]),
      ),
    );
}

/** Every difficulty tier of several race quests, in one batch. */
export async function listRaceQuestDifficultiesFor(raceQuestIds: readonly string[]) {
  if (raceQuestIds.length === 0) return [];
  return db
    .select()
    .from(master.masterRaceQuestDifficulty)
    .where(inArray(master.masterRaceQuestDifficulty.RaceQuestId, [...raceQuestIds]))
    .orderBy(
      asc(master.masterRaceQuestDifficulty.RaceQuestId),
      asc(master.masterRaceQuestDifficulty.DifficultyNumber),
    );
}

/** Live-bonus ids of one group, ordered by `Order` then id. */
export async function listRaceLiveBonusGroupIds(groupId: string): Promise<string[]> {
  if (groupId === '') return [];
  const rows = await db
    .select({
      LiveBonusId: master.masterRaceLiveBonusGroup.LiveBonusId,
      Order: master.masterRaceLiveBonusGroup.Order,
    })
    .from(master.masterRaceLiveBonusGroup)
    .where(eq(master.masterRaceLiveBonusGroup.GroupId, groupId))
    .orderBy(asc(master.masterRaceLiveBonusGroup.Order));
  return rows.map((row) => String(row.LiveBonusId ?? '')).filter((id) => id !== '');
}

/** One live-bonus level row, keyed by (id, level). */
export async function getRaceLiveBonus(liveBonusId: string, level: number) {
  const [row] = await db
    .select()
    .from(master.masterRaceLiveBonus)
    .where(
      and(
        eq(master.masterRaceLiveBonus.Id, liveBonusId),
        eq(master.masterRaceLiveBonus.Level, level),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every level row of one live-bonus id, ordered by `Level`. */
export async function listRaceLiveBonusLevels(liveBonusId: string) {
  return db
    .select()
    .from(master.masterRaceLiveBonus)
    .where(eq(master.masterRaceLiveBonus.Id, liveBonusId))
    .orderBy(asc(master.masterRaceLiveBonus.Level));
}

/** Ranking payout rows of one rank grade, lowest rank first. */
export async function listRaceRankingRewards(rankGradeId: string) {
  return db
    .select()
    .from(master.masterRaceRankingReward)
    .where(eq(master.masterRaceRankingReward.RankGradeId, rankGradeId))
    .orderBy(asc(master.masterRaceRankingReward.RankFrom));
}
