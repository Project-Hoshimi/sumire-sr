// Pure VENUS rank-page logic: competition ranking, page assembly, reward
// reached flags and deck card rows. No database.
import '@sumire-sr/protocol/gen/registry.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDeckCards,
  hierarchyDivisionRewardInfos,
  hierarchyRewardInfos,
  rankLeaderboard,
  rankUserInfo,
  rankingPage,
  validateRewardIds,
} from './hierarchyRpc.ts';
import { GRPC_STATUS, RpcError } from './errors.ts';
import type { Grade } from './hierarchy.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const GRADES: Grade[] = [
  { Id: 'hie-001-001', HierarchyGradeId: 'hie-001', RequiredHierarchyPoint: 25000, RequiredHierarchyRank: 4 },
  { Id: 'hie-002-001', HierarchyGradeId: 'hie-002', RequiredHierarchyPoint: 15000, RequiredHierarchyRank: 1000 },
  { Id: 'hie-003-001', HierarchyGradeId: 'hie-003', RequiredHierarchyPoint: 10000, RequiredHierarchyRank: 2000 },
  { Id: 'hie-004-001', HierarchyGradeId: 'hie-004', RequiredHierarchyPoint: 7000, RequiredHierarchyRank: null },
  { Id: 'hie-004-002', HierarchyGradeId: 'hie-004', RequiredHierarchyPoint: 6200, RequiredHierarchyRank: null },
  { Id: 'hie-004-003', HierarchyGradeId: 'hie-004', RequiredHierarchyPoint: 5400, RequiredHierarchyRank: null },
  { Id: 'hie-005-001', HierarchyGradeId: 'hie-005', RequiredHierarchyPoint: 4500, RequiredHierarchyRank: null },
  { Id: 'hie-005-002', HierarchyGradeId: 'hie-005', RequiredHierarchyPoint: 3700, RequiredHierarchyRank: null },
  { Id: 'hie-005-003', HierarchyGradeId: 'hie-005', RequiredHierarchyPoint: 3000, RequiredHierarchyRank: null },
  { Id: 'hie-006-001', HierarchyGradeId: 'hie-006', RequiredHierarchyPoint: 2000, RequiredHierarchyRank: null },
  { Id: 'hie-006-002', HierarchyGradeId: 'hie-006', RequiredHierarchyPoint: 1500, RequiredHierarchyRank: null },
  { Id: 'hie-006-003', HierarchyGradeId: 'hie-006', RequiredHierarchyPoint: 1000, RequiredHierarchyRank: null },
  { Id: 'hie-007-001', HierarchyGradeId: 'hie-007', RequiredHierarchyPoint: 600, RequiredHierarchyRank: null },
  { Id: 'hie-007-002', HierarchyGradeId: 'hie-007', RequiredHierarchyPoint: 300, RequiredHierarchyRank: null },
  { Id: 'hie-007-003', HierarchyGradeId: 'hie-007', RequiredHierarchyPoint: null, RequiredHierarchyRank: null },
];

test('rankLeaderboard: Diamond floor, total desc, ties share the rank', () => {
  const ranked = rankLeaderboard(
    [
      { playerId: 'a', total: 30000 },
      { playerId: 'b', total: 20000 },
      { playerId: 'c', total: 20000 },
      { playerId: 'd', total: 16000 },
      { playerId: 'e', total: 14999 },
    ],
    15000,
  );
  assert.deepEqual(
    ranked.map((entry) => [entry.playerId, entry.rank]),
    [
      ['a', 1],
      ['b', 2],
      ['c', 2],
      ['d', 4],
    ],
  );
});

test('rankingPage keeps a listed caller once and ignores a caller below the leaderboard', () => {
  const ranked = rankLeaderboard(
    [
      { playerId: 'a', total: 30000 },
      { playerId: 'b', total: 20000 },
      { playerId: 'caller', total: 16000 },
    ],
    15000,
  );
  const listed = rankingPage(ranked, { playerId: 'caller', total: 16000 });
  assert.equal(listed.filter((row) => row.playerId === 'caller').length, 1);
  assert.equal(listed.find((row) => row.playerId === 'caller')?.rank, 3);

  const below = rankingPage(ranked, { playerId: 'below', total: 14000 });
  assert.equal(below.length, 3);
  assert.equal(below.some((row) => row.playerId === 'below'), false);
});

test('rankingPage caps rows and appends a past-the-cut caller with its real rank', () => {
  const entries = Array.from({ length: 105 }, (_, i) => ({
    playerId: `p${i}`,
    total: 100_000 - i,
  }));
  const ranked = rankLeaderboard(entries, 15000);
  const page = rankingPage(ranked, { playerId: 'p104', total: 100_000 - 104 });
  assert.equal(page.length, 101);
  assert.equal(page.at(-1)?.playerId, 'p104');
  assert.equal(page.at(-1)?.rank, 105);
  assert.equal(page.at(-1)?.gradeRank, 105);
});

test('hierarchyRewardInfos: reached follows the achieved grade, received is sticky', () => {
  const rewards = [
    { Id: 'hr-final', targetGradeId: 'hie-001-001' },
    { Id: 'hr-bronze', targetGradeId: 'hie-007-003' },
  ];
  const infos = hierarchyRewardInfos(rewards, GRADES, 'hie-003-001', ['hr-bronze']);
  assert.deepEqual(
    infos.map((info) => [info.HierarchyRewardId, info.CanReceive, info.HaveReceived]),
    [
      ['hr-final', false, false],
      ['hr-bronze', true, true],
    ],
  );
});

test('hierarchyDivisionRewardInfos: reached follows the achieved grade', () => {
  const rewards = [
    { Id: 'hdr-final', RewardId: 'rd_auto;stone;;1', DetailGradeId: 'hie-001-001' },
    { Id: 'hdr-bronze', RewardId: 'rd_auto;stone;;1', DetailGradeId: 'hie-007-003' },
  ];
  const infos = hierarchyDivisionRewardInfos(rewards, GRADES, 'hie-007-003', ['hdr-final']);
  assert.deepEqual(
    infos.map((info) => [info.HierarchyDivisionRewardId, info.CanReceive, info.HaveReceived]),
    [
      ['hdr-final', false, true],
      ['hdr-bronze', true, false],
    ],
  );
});

test('buildDeckCards orders by position and skips cards the player no longer owns', () => {
  const cardById = new Map<string, Decoded>([
    ['card-a', { __msg: 'Solis.Common.Proto.Transaction.UserCard', Level: 10, Rarity: 3, EvolutionLevel: 2 } as Decoded],
    ['card-c', { __msg: 'Solis.Common.Proto.Transaction.UserCard', Level: 5, Rarity: 1, EvolutionLevel: 0 } as Decoded],
  ]);
  const infos = buildDeckCards(
    [
      { Position: 3, CardId: 'card-c' },
      { Position: 1, CardId: 'card-a' },
      { Position: 2, CardId: 'card-missing' },
    ],
    cardById,
  );
  assert.deepEqual(
    infos.map((info) => [info.Position, info.CardId, info.Level, info.Rarity, info.EvolutionLevel]),
    [
      [1, 'card-a', 10, 3, 2],
      [3, 'card-c', 5, 1, 0],
    ],
  );
});

test('rankUserInfo carries every HierarchyRankUserInfo field', () => {
  const row = rankUserInfo({
    userId: 'public-id',
    rank: 2,
    name: 'manager',
    level: 42,
    detailGradeId: 'hie-002-001',
    point: 16000,
    emblemId: 'emblem-1',
    deckName: 'main',
    cardInfos: [],
  });
  assert.equal(row.__msg, 'Solis.Common.Proto.Api.HierarchyRankUserInfo');
  assert.equal(row.UserId, 'public-id');
  assert.equal(row.CurrentRank, 2);
  assert.equal(row.ManagerName, 'manager');
  assert.equal(row.ManagerLevel, 42);
  assert.equal(row.CurrentDetailGradeId, 'hie-002-001');
  assert.equal(row.CurrentPoint, 16000);
  assert.equal(row.EmblemId, 'emblem-1');
  assert.equal(row.DeckName, 'main');
  assert.deepEqual(row.CardInfos, []);
});

test('validateRewardIds rejects empty, blank and duplicate ids as INVALID_ARGUMENT', () => {
  for (const ids of [[], [''], ['a', 'a']]) {
    assert.throws(
      () => validateRewardIds(ids, 'hierarchyRewardIds'),
      (error) => error instanceof RpcError && error.grpcStatus === GRPC_STATUS.INVALID_ARGUMENT,
    );
  }
  assert.doesNotThrow(() => validateRewardIds(['a', 'b'], 'hierarchyRewardIds'));
});
