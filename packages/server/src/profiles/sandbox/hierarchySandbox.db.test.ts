// Sandbox VENUS behaviour: every player is BIG4 rank 1 and the leaderboard is
// off, while points and the stored real best grade stay real. Runs under the
// default `sandbox` profile against the configured Postgres and skips (with a
// message) when the database is unreachable.
//
//   node --test src/profiles/sandbox/hierarchySandbox.db.test.ts
import '@sumire-sr/protocol/gen/registry.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { client, db } from '../../db/client.ts';
import { accounts, players } from '../../db/schema.ts';
import { listHierarchyDetailGrades } from '../../master/index.ts';
import { getSingleton, putSingleton } from '../../services/playerState.ts';
import {
  loadHierarchyStanding,
  loadUserHierarchy,
  reconcileHierarchyNotification,
} from '../../services/hierarchy.ts';
import {
  buildHierarchyListRanking,
  buildHierarchyTop,
  receiveHierarchyRewards,
} from '../../services/hierarchyRpc.ts';
import { GRPC_STATUS, RpcError } from '../../services/errors.ts';
import { isSandbox } from '../../profile.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const created: { accountId: string; playerId: string }[] = [];

let available: boolean | null = null;
let masterLoaded: boolean | null = null;

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

/** The hierarchy tests need the master grade rows, which a fresh CI database lacks. */
async function masterLoadedAvailable(): Promise<boolean> {
  if (masterLoaded !== null) return masterLoaded;
  try {
    masterLoaded = (await listHierarchyDetailGrades()).length > 0;
  } catch {
    masterLoaded = false;
  }
  return masterLoaded;
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

async function newPlayer(
  t: { skip: (message: string) => void },
): Promise<{ playerId: string; name: string } | null> {
  if (!(await dbAvailable())) {
    t.skip('dev postgres is not reachable; run `npm run db:migrate` and retry');
    return null;
  }
  if (!(await masterLoadedAvailable())) {
    t.skip('master hierarchy grades are not loaded (no game data); run the master import and retry');
    return null;
  }
  const suffix = randomUUID();
  const accountId = `test-sandbox-hierarchy-${suffix}`;
  const playerId = `test-sandbox-hierarchy-player-${suffix}`;
  const name = `sandbox-hierarchy-${suffix.slice(0, 8)}`;
  await db.insert(accounts).values({ id: accountId, displayName: `sandbox hierarchy ${suffix.slice(0, 8)}` });
  await db.insert(players).values({ id: playerId, accountId, name });
  created.push({ accountId, playerId });
  return { playerId, name };
}

/** Give a player a fixed point total and no best grade / claim history. */
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

function isFailedPrecondition(error: unknown): boolean {
  return error instanceof RpcError && error.grpcStatus === GRPC_STATUS.FAILED_PRECONDITION;
}

test('the suite runs under the sandbox profile', () => {
  assert.equal(isSandbox(), true);
});

test('loadHierarchyStanding gives BIG4 rank 1 with the real point total', async (t) => {
  const player = await newPlayer(t);
  if (!player) return;
  await seedPoints(player.playerId, 12_000);

  const standing = await loadHierarchyStanding(player.playerId);
  assert.equal(standing.detailGradeId, 'hie-001-001');
  assert.equal(standing.gradeId, 'hie-001');
  assert.equal(standing.rank, 1);
  assert.equal(standing.total, 12_000);
});

test('Top reports BIG4 rank 1 and lists only the caller as highest grade', async (t) => {
  const player = await newPlayer(t);
  if (!player) return;
  // A second player with far more points must not appear in the names list.
  const rival = await newPlayer(t);
  if (!rival) return;
  await seedPoints(rival.playerId, 10_000_050_000);
  await seedPoints(player.playerId, 12_000);

  const top = await buildHierarchyTop(player.playerId);
  const info = top.UserHierarchyInfo as Decoded;
  assert.equal(String(info.CurrentDetailGradeId ?? ''), 'hie-001-001');
  assert.equal(Number(info.CurrentRank), 1);
  assert.equal(Number(info.CurrentPoint), 12_000);
  assert.deepEqual(top.HighestGradeUserNames, [player.name]);
});

test('ListRanking returns exactly one row: the caller at BIG4 rank 1', async (t) => {
  const player = await newPlayer(t);
  if (!player) return;
  const rival = await newPlayer(t);
  if (!rival) return;
  await seedPoints(rival.playerId, 10_000_050_000);
  await seedPoints(player.playerId, 12_000);

  const ranking = await buildHierarchyListRanking(player.playerId);
  const rows = (ranking.RankUserInfos as Decoded[] | undefined) ?? [];
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(String(row.UserId ?? ''), player.playerId);
  assert.equal(Number(row.CurrentRank), 1);
  assert.equal(String(row.CurrentDetailGradeId ?? ''), 'hie-001-001');
  assert.equal(Number(row.CurrentPoint), 12_000);
});

test('a BIG4 reward is claimable once, then FAILED_PRECONDITION', async (t) => {
  const player = await newPlayer(t);
  if (!player) return;
  // Zero real points: the reward is only reachable because the sandbox shows
  // the player as BIG4.
  await seedPoints(player.playerId, 0);

  const top = await buildHierarchyTop(player.playerId);
  const infos = (top.RewardInfos as Decoded[] | undefined) ?? [];
  const big4Reward = infos.find((info) => String(info.HierarchyRewardId ?? '') === 'hr-achievement-hie-001-001');
  assert.ok(big4Reward, 'the BIG4 reward is listed');
  assert.equal(big4Reward.CanReceive, true);
  assert.equal(big4Reward.HaveReceived, false);

  const received = await receiveHierarchyRewards(player.playerId, ['hr-achievement-hie-001-001']);
  assert.ok((received.Results as Decoded[]).length > 0, 'reward results are returned');
  const stored = await getSingleton(player.playerId, 'Hierarchy');
  assert.deepEqual(stored?.ReceivedRewardIds, ['hr-achievement-hie-001-001']);

  await assert.rejects(
    receiveHierarchyRewards(player.playerId, ['hr-achievement-hie-001-001']),
    isFailedPrecondition,
  );
});

test('the stored best grade stays real below 25000 points after Top/reconcile', async (t) => {
  const player = await newPlayer(t);
  if (!player) return;
  // 5000 points is a point-only grade, so the stored result does not depend on
  // any other player's rank.
  await seedPoints(player.playerId, 5_000);

  const top = await buildHierarchyTop(player.playerId);
  assert.equal(String((top.UserHierarchyInfo as Decoded).CurrentDetailGradeId ?? ''), 'hie-001-001');

  const stored = await getSingleton(player.playerId, 'Hierarchy');
  assert.notEqual(stored?.BestDetailGradeId, 'hie-001-001');
  assert.equal(String(stored?.BestDetailGradeId ?? ''), 'hie-005-001');
  assert.equal(Number(stored?.BestTotalPoint ?? 0), 5_000);

  const reconciled = await reconcileHierarchyNotification(player.playerId);
  assert.equal(String(reconciled.info.CurrentDetailGradeId ?? ''), 'hie-001-001');
  assert.equal(Number(reconciled.info.CurrentRank), 1);
  const afterReconcile = await getSingleton(player.playerId, 'Hierarchy');
  assert.equal(String(afterReconcile?.BestDetailGradeId ?? ''), 'hie-005-001');
});
