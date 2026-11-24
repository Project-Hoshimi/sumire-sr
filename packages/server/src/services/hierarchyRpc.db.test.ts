// VENUS rank page (Top / ListRanking / reward claims) against the configured
// Postgres. Skips (with a message) when the database is unreachable.
//
//   node --test src/services/hierarchyRpc.db.test.ts
import '@sumire-sr/protocol/gen/registry.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { client, db } from '../db/client.ts';
import { accounts, players } from '../db/schema.ts';
import { getSingleton, putSingleton } from './playerState.ts';
import { loadUserHierarchy } from './hierarchy.ts';
import {
  buildHierarchyListRanking,
  buildHierarchyTop,
  receiveHierarchyDivisionRewards,
  receiveHierarchyRewards,
} from './hierarchyRpc.ts';
import { GRPC_STATUS, RpcError } from './errors.ts';
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
  const accountId = `test-hierarchy-rpc-${suffix}`;
  const playerId = `test-hierarchy-rpc-player-${suffix}`;
  await db.insert(accounts).values({ id: accountId, displayName: `hierarchy rpc ${suffix.slice(0, 8)}` });
  await db.insert(players).values({ id: playerId, accountId, name: `hierarchy-rpc-${suffix.slice(0, 8)}` });
  created.push({ accountId, playerId });
  return playerId;
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

function rewardInfo(top: Decoded, id: string): Decoded {
  const infos = (top.RewardInfos as Decoded[] | undefined) ?? [];
  const found = infos.find((info) => String(info.HierarchyRewardId ?? '') === id);
  assert.ok(found, `reward ${id} is listed`);
  return found;
}

function divisionInfo(top: Decoded, id: string): Decoded {
  const infos = (top.DivisionRewardInfos as Decoded[] | undefined) ?? [];
  const found = infos.find((info) => String(info.HierarchyDivisionRewardId ?? '') === id);
  assert.ok(found, `division reward ${id} is listed`);
  return found;
}

function isFailedPrecondition(error: unknown): boolean {
  return error instanceof RpcError && error.grpcStatus === GRPC_STATUS.FAILED_PRECONDITION;
}

function isInvalidArgument(error: unknown): boolean {
  return error instanceof RpcError && error.grpcStatus === GRPC_STATUS.INVALID_ARGUMENT;
}

test('Top at 0 points: lowest grade, rank 0, lowest reward claimable', async (t) => {
  const playerId = await newPlayer(t);
  if (!playerId) return;
  await seedPoints(playerId, 0);

  const top = await buildHierarchyTop(playerId);
  const info = top.UserHierarchyInfo as Decoded;
  assert.equal(info.CurrentDetailGradeId, 'hie-007-003');
  assert.equal(Number(info.CurrentRank), 0);
  assert.equal(Number(info.CurrentPoint), 0);

  const reward = rewardInfo(top, 'hr-achievement-hie-007-003');
  assert.equal(reward.CanReceive, true);
  assert.equal(reward.HaveReceived, false);

  const division = divisionInfo(top, 'hdr-achievement-hie-007-003');
  assert.equal(division.CanReceive, true);
  assert.equal(division.HaveReceived, false);
  const firstUser = division.FirstUserInfo as Decoded;
  assert.ok(firstUser, 'reached division reward names the caller as first receiver');
  assert.equal(String(firstUser.UserId ?? ''), playerId);

  assert.ok(Array.isArray(top.HighestGradeUserNames));
});

test('Top at 12000 points: Platinum grade and a competition rank', async (t) => {
  const playerId = await newPlayer(t);
  if (!playerId) return;
  await seedPoints(playerId, 12000);

  const top = await buildHierarchyTop(playerId);
  const info = top.UserHierarchyInfo as Decoded;
  assert.equal(info.CurrentDetailGradeId, 'hie-003-001');
  // 12000 points is on the leaderboard now; the only other player in this file
  // is the 0-point player from the test above, so the caller is rank 1.
  assert.equal(Number(info.CurrentRank), 1);
  assert.equal(Number(info.CurrentPoint), 12000);
  assert.equal(rewardInfo(top, 'hr-achievement-hie-001-001').CanReceive, false);
  assert.equal(rewardInfo(top, 'hr-achievement-hie-003-001').CanReceive, true);
});

test('ListRanking orders by total, shares ties and ranks a Platinum caller', async (t) => {
  const totals = [10_000_030_000, 10_000_029_000, 10_000_028_000, 10_000_027_000, 10_000_026_000, 10_000_026_000];
  const ids: string[] = [];
  for (const total of totals) {
    const playerId = await newPlayer(t);
    if (!playerId) return;
    await seedPoints(playerId, total);
    ids.push(playerId);
  }
  const callerId = await newPlayer(t);
  if (!callerId) return;
  await seedPoints(callerId, 14000);

  const ranking = await buildHierarchyListRanking(callerId);
  const rows = (ranking.RankUserInfos as Decoded[]) ?? [];
  const rowFor = (id: string) => rows.find((row) => String(row.UserId ?? '') === id);

  const expectedRanks = [1, 2, 3, 4, 5, 5];
  ids.forEach((id, index) => {
    const row = rowFor(id);
    assert.ok(row, `row for player ${index} is present`);
    assert.equal(Number(row.CurrentRank), expectedRanks[index], `rank for player ${index}`);
    assert.equal(Number(row.CurrentPoint), totals[index]);
  });
  assert.equal(rowFor(ids[0])?.CurrentDetailGradeId, 'hie-001-001');
  assert.equal(rowFor(ids[3])?.CurrentDetailGradeId, 'hie-001-001');
  assert.equal(rowFor(ids[4])?.CurrentDetailGradeId, 'hie-002-001');

  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(
      Number(rows[i - 1].CurrentPoint) >= Number(rows[i].CurrentPoint),
      `row ${i} does not have more points than row ${i + 1}`,
    );
  }
  const positions = ids.map((id) => rows.findIndex((row) => String(row.UserId ?? '') === id));
  for (let i = 1; i < positions.length; i += 1) {
    if (totals[i - 1] === totals[i]) continue;
    assert.ok(positions[i - 1] < positions[i], `player ${i - 1} is listed before player ${i}`);
  }

  const caller = rowFor(callerId);
  assert.ok(caller, 'the caller is on the page');
  // The caller is ranked: 1 + the six players above.
  assert.equal(Number(caller?.CurrentRank), 7);
  assert.equal(Number(caller?.CurrentPoint), 14000);
  assert.equal(String(caller?.CurrentDetailGradeId ?? ''), 'hie-003-001');
  assert.equal(rows.filter((row) => String(row.UserId ?? '') === callerId).length, 1);
});

test('ReceiveRewards grants once, then refuses repeats and unreached/unknown ids', async (t) => {
  const playerId = await newPlayer(t);
  if (!playerId) return;
  await seedPoints(playerId, 12000);

  const received = await receiveHierarchyRewards(playerId, ['hr-achievement-hie-003-001']);
  assert.ok((received.Results as Decoded[]).length > 0, 'reward results are returned');
  const updatedData = (received.CommonResponse as Decoded).UpdatedData as Decoded;
  const updatedHierarchy = updatedData.Hierarchy as Decoded;
  assert.deepEqual(updatedHierarchy.ReceivedRewardIds, ['hr-achievement-hie-003-001']);

  const stored = await getSingleton(playerId, 'Hierarchy');
  assert.deepEqual(stored?.ReceivedRewardIds, ['hr-achievement-hie-003-001']);

  const top = await buildHierarchyTop(playerId);
  assert.equal(rewardInfo(top, 'hr-achievement-hie-003-001').HaveReceived, true);
  assert.equal(rewardInfo(top, 'hr-achievement-hie-003-001').CanReceive, true);

  await assert.rejects(
    receiveHierarchyRewards(playerId, ['hr-achievement-hie-003-001']),
    isFailedPrecondition,
  );
  await assert.rejects(
    receiveHierarchyRewards(playerId, ['hr-achievement-hie-001-001']),
    isFailedPrecondition,
  );
  await assert.rejects(receiveHierarchyRewards(playerId, ['hr-no-such-reward']), isInvalidArgument);
});

test('ReceiveDivisionRewards grants once and refuses the repeat', async (t) => {
  const playerId = await newPlayer(t);
  if (!playerId) return;
  await seedPoints(playerId, 12000);

  const received = await receiveHierarchyDivisionRewards(playerId, ['hdr-achievement-hie-003-001']);
  assert.ok((received.Results as Decoded[]).length > 0, 'division reward results are returned');
  const stored = await getSingleton(playerId, 'Hierarchy');
  assert.deepEqual(stored?.ReceivedDivisionRewardIds, ['hdr-achievement-hie-003-001']);

  const top = await buildHierarchyTop(playerId);
  assert.equal(divisionInfo(top, 'hdr-achievement-hie-003-001').HaveReceived, true);

  await assert.rejects(
    receiveHierarchyDivisionRewards(playerId, ['hdr-achievement-hie-003-001']),
    isFailedPrecondition,
  );
  await assert.rejects(
    receiveHierarchyDivisionRewards(playerId, ['hdr-achievement-hie-001-001']),
    isFailedPrecondition,
  );
  await assert.rejects(
    receiveHierarchyDivisionRewards(playerId, ['hdr-no-such-reward']),
    isInvalidArgument,
  );
});
