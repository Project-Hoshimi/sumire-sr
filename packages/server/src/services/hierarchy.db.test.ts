// VENUS point grants and the one-time main-quest backfill, against the
// configured Postgres. Skips (with a message) when the database is unreachable.
//
//   node --test src/services/hierarchy.db.test.ts
import '@sumire-sr/protocol/gen/registry.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { client, db } from '../db/client.ts';
import { accounts, players } from '../db/schema.ts';
import { applyGrants } from '../master/reward.ts';
import { collectionElementMsg, getSingleton, putElements, putSingleton } from './playerState.ts';
import {
  grantHierarchyPoint,
  loadHierarchyStanding,
  loadUserHierarchy,
  reconcileHierarchyNotification,
} from './hierarchy.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const created: { accountId: string; playerId: string }[] = [];

let available: boolean | null = null;

async function dbAvailable(): Promise<boolean> {
  if (available !== null) return available;
  try {
    await db.execute(sql`select 1`);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

after(async () => {
  try {
    for (const { playerId, accountId } of created) {
      await db.execute(sql`delete from player_entities where player_id = ${playerId}`);
      await db.execute(sql`delete from players where id = ${playerId}`);
      await db.execute(sql`delete from accounts where id = ${accountId}`);
    }
  } catch {
    // Nothing was created when the database is unreachable.
  }
  await client.end({ timeout: 5 });
});

async function newPlayer(t: { skip: (message: string) => void }): Promise<string | null> {
  if (!(await dbAvailable())) {
    t.skip('dev postgres is not reachable; run `npm run db:migrate` and retry');
    return null;
  }
  const suffix = randomUUID();
  const accountId = `test-hierarchy-${suffix}`;
  const playerId = `test-hierarchy-player-${suffix}`;
  await db.insert(accounts).values({ id: accountId, displayName: `hierarchy ${suffix.slice(0, 8)}` });
  await db.insert(players).values({ id: playerId, accountId, name: `hierarchy-${suffix.slice(0, 8)}` });
  created.push({ accountId, playerId });
  return playerId;
}

const QUEST_MSG = collectionElementMsg('Quests') ?? 'Solis.Common.Proto.Transaction.UserQuest';

async function seedClearedQuest(playerId: string, questId: string): Promise<void> {
  await putElements(
    playerId,
    'Quests',
    [{ __msg: QUEST_MSG, QuestId: questId, LastClearedTime: Date.now() } as Decoded],
  );
}

test('a fixed-point (22) grant updates UserHierarchy and returns a RewardResult', async (t) => {
  const playerId = await newPlayer(t);
  if (!playerId) return;

  const applied = await applyGrants(playerId, [{ resourceType: 22, resourceId: '', amount: 15 }]);
  const hierarchy = applied.updated?.Hierarchy as Decoded | undefined;
  assert.ok(hierarchy, 'UpdatedData.Hierarchy is set');
  assert.equal(hierarchy.__msg, 'Solis.Common.Proto.Transaction.UserHierarchy');
  assert.equal(Number(hierarchy.CurrentFixedPoint ?? 0), 15);
  assert.equal(Number(hierarchy.CurrentVariablePoint ?? 0), 0);
  assert.equal(Number(hierarchy.BestTotalPoint ?? 0), 15);

  assert.equal(applied.results.length, 1);
  const reward = applied.results[0];
  assert.equal(Number(reward.ResourceType), 22);
  assert.equal(Number(reward.BeforeAmount), 0);
  assert.equal(Number(reward.AfterAmount), 15);
  assert.equal(Number(reward.AmountI64), 15);

  const stored = await loadUserHierarchy(playerId);
  assert.equal(Number(stored.CurrentFixedPoint ?? 0), 15);
});

test('a variable-point (23) grant updates CurrentVariablePoint and raises the best total', async (t) => {
  const playerId = await newPlayer(t);
  if (!playerId) return;

  await grantHierarchyPoint(playerId, 22, 100, db);
  const granted = await grantHierarchyPoint(playerId, 23, 40, db);
  assert.equal(granted.before, 0);
  assert.equal(granted.after, 40);
  assert.equal(Number(granted.hierarchy.CurrentFixedPoint ?? 0), 100);
  assert.equal(Number(granted.hierarchy.CurrentVariablePoint ?? 0), 40);
  assert.equal(Number(granted.hierarchy.BestTotalPoint ?? 0), 140);
  assert.ok(Number(granted.hierarchy.CurrentPointUpdateDatetime ?? 0) > 0);
});

test('the lazy backfill sums cleared main-quest fixed points exactly once', async (t) => {
  const playerId = await newPlayer(t);
  if (!playerId) return;

  await seedClearedQuest(playerId, 'qt-main-1-006-01');
  const first = await loadUserHierarchy(playerId);
  // rd-main-quest-006-01 carries HierarchyFixedPoint 15.
  assert.equal(Number(first.CurrentFixedPoint ?? 0), 15);
  assert.equal(Number(first.BestTotalPoint ?? 0), 15);
  assert.equal(String(first.BestDetailGradeId ?? ''), '');

  const marker = await getSingleton(playerId, 'HierarchyBackfill');
  assert.ok(marker, 'the backfill singleton is written');
  assert.equal(Number(marker.fixedPoint ?? 0), 15);

  // Loading again does not re-run the sum (and would replace, not add).
  const second = await loadUserHierarchy(playerId);
  assert.equal(Number(second.CurrentFixedPoint ?? 0), 15);

  // A later grant adds on top of the backfilled points; it must not re-run.
  const granted = await grantHierarchyPoint(playerId, 22, 15, db);
  assert.equal(Number(granted.hierarchy.CurrentFixedPoint ?? 0), 30);
  const third = await loadUserHierarchy(playerId);
  assert.equal(Number(third.CurrentFixedPoint ?? 0), 30);
});

test('an existing backfill singleton is left alone', async (t) => {
  const playerId = await newPlayer(t);
  if (!playerId) return;

  await seedClearedQuest(playerId, 'qt-main-1-006-01');
  await putSingleton(playerId, 'Hierarchy', {
    __msg: 'Solis.Common.Proto.Transaction.UserHierarchy',
    CurrentFixedPoint: 5,
    CurrentVariablePoint: 0,
    BestTotalPoint: 5,
    BestDetailGradeId: '',
    ReceivedRewardIds: [],
    ReceivedDivisionRewardIds: [],
  } as Decoded);
  await putSingleton(playerId, 'HierarchyBackfill', { doneAt: 1, fixedPoint: 999 } as Decoded);

  const loaded = await loadUserHierarchy(playerId);
  assert.equal(Number(loaded.CurrentFixedPoint ?? 0), 5);
  assert.equal(Number(loaded.BestTotalPoint ?? 0), 5);
  const marker = await getSingleton(playerId, 'HierarchyBackfill');
  assert.equal(Number(marker?.fixedPoint ?? 0), 999);
});

/** Run the one-time backfill, then set the player's total points directly. */
async function seedPoints(playerId: string, total: number): Promise<void> {
  await loadUserHierarchy(playerId);
  await putSingleton(playerId, 'Hierarchy', {
    __msg: 'Solis.Common.Proto.Transaction.UserHierarchy',
    CurrentFixedPoint: total,
    CurrentVariablePoint: 0,
    BestTotalPoint: total,
    BestDetailGradeId: '',
    ReceivedRewardIds: [],
    ReceivedDivisionRewardIds: [],
  } as Decoded);
}

test('the server-wide Diamond leaderboard ranks players and awards BIG4/Diamond', async (t) => {
  // Totals far above anything realistic so unrelated players in the shared
  // test database cannot change the relative order.
  const totals = [
    10_000_030_000,
    10_000_029_000,
    10_000_028_000,
    10_000_027_000,
    10_000_026_000,
    10_000_026_000,
  ];
  const ids: string[] = [];
  for (const total of totals) {
    const playerId = await newPlayer(t);
    if (!playerId) return;
    await seedPoints(playerId, total);
    ids.push(playerId);
  }

  // A corpus-style Hierarchy row with no HierarchyBackfill singleton: loading
  // the player would backfill it, so it is seeded directly and must not be
  // counted until then.
  const unbackfilled = await newPlayer(t);
  if (!unbackfilled) return;
  await putSingleton(unbackfilled, 'Hierarchy', {
    __msg: 'Solis.Common.Proto.Transaction.UserHierarchy',
    CurrentFixedPoint: 10_000_099_000,
    CurrentVariablePoint: 0,
    BestTotalPoint: 10_000_099_000,
    BestDetailGradeId: '',
    ReceivedRewardIds: [],
    ReceivedDivisionRewardIds: [],
  } as Decoded);

  const expectedRanks = [1, 2, 3, 4, 5, 5];
  for (let i = 0; i < ids.length; i += 1) {
    const standing = await loadHierarchyStanding(ids[i]);
    assert.equal(standing.total, totals[i]);
    assert.equal(standing.rank, expectedRanks[i]);
    // BIG4 admits the top 4 ranks; the rest of the field is Diamond.
    assert.equal(standing.detailGradeId, i < 4 ? 'hie-001-001' : 'hie-002-001');
    assert.equal(standing.gradeId, i < 4 ? 'hie-001' : 'hie-002');
  }

  // Reloading the top player keeps rank 1: the unbackfilled row is ignored.
  const reloaded = await loadHierarchyStanding(ids[0]);
  assert.equal(reloaded.rank, 1);
  assert.equal(reloaded.detailGradeId, 'hie-001-001');

  // Quest:Top reconciles the same standing into its notification info.
  const reconciled = await reconcileHierarchyNotification(ids[0]);
  assert.equal(Number(reconciled.info.CurrentRank), 1);
  assert.equal(String(reconciled.info.CurrentDetailGradeId), 'hie-001-001');
  assert.equal(String(reconciled.hierarchy?.BestDetailGradeId ?? ''), 'hie-001-001');
});

test('a Platinum-point player is ranked and stays Platinum inside the rank window', async (t) => {
  const playerId = await newPlayer(t);
  if (!playerId) return;
  await seedPoints(playerId, 14000);

  const standing = await loadHierarchyStanding(playerId);
  assert.equal(standing.total, 14000);
  // The six huge-total players seeded by the leaderboard test above sit ahead
  // of this player, so competition rank is 1 + 6.
  assert.equal(standing.rank, 7);
  assert.equal(standing.detailGradeId, 'hie-003-001');
  assert.equal(standing.gradeId, 'hie-003');
});
