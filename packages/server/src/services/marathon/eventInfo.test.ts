// Marathon event story and event mission builders. Pure unit tests; no database.
//
//   node --test src/services/marathon/eventInfo.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEventMissionInfo,
  buildEventStoryInfo,
  dedupeEventMissions,
  freshMarathonMission,
  sameJstDay,
} from './eventInfo.ts';
import { MissionType, applyMissionProgress } from '../missionProgress.ts';

const STORY_MSG = 'Solis.Common.Proto.Api.EventStoryInfo';
const EPISODE_MSG = 'Solis.Common.Proto.Api.EventStoryEpisodeInfo';
const EVENT_MISSION_MSG = 'Solis.Common.Proto.Api.EventMissionInfo';
const USER_MISSION_MSG = 'Solis.Common.Proto.Transaction.UserMission';

test('event story: null or undefined story gives undefined', () => {
  assert.equal(buildEventStoryInfo(null), undefined);
  assert.equal(buildEventStoryInfo(undefined), undefined);
});

test('event story: episodes are sorted ascending and all unlocked', () => {
  const info = buildEventStoryInfo({
    Id: 'story-test-1',
    Episodes: [{ Episode: 3 }, { Episode: 1 }, { Episode: 2 }],
  });
  assert.deepEqual(info, {
    __msg: STORY_MSG,
    Id: 'story-test-1',
    Episodes: [
      { __msg: EPISODE_MSG, Episode: 1, Unlocked: true },
      { __msg: EPISODE_MSG, Episode: 2, Unlocked: true },
      { __msg: EPISODE_MSG, Episode: 3, Unlocked: true },
    ],
  });
});

test('event story: null episodes give an empty list', () => {
  assert.deepEqual(buildEventStoryInfo({ Id: 'story-test-2', Episodes: null }), {
    __msg: STORY_MSG,
    Id: 'story-test-2',
    Episodes: [],
  });
});

test('event mission: missing user missions are synthesized at Progress 0 with the first threshold', () => {
  const info = buildEventMissionInfo({
    eventMissionId: 'event-test-1',
    missions: [{ id: 'ms-test-a', firstThreshold: 10 }],
    userMissions: [],
  });
  assert.deepEqual(info, {
    __msg: EVENT_MISSION_MSG,
    Id: 'event-test-1',
    Unlocked: true,
    UserMissions: [
      { __msg: USER_MISSION_MSG, MissionId: 'ms-test-a', CurrentThreshold: 10, Progress: 0, StatusType: 1 },
    ],
  });
});

test('event mission: an existing user mission is passed through with the correct __msg', () => {
  const existing = { MissionId: 'ms-test-b', CurrentThreshold: 5, Progress: 3, StatusType: 2, LastUpdateTime: 123 };
  const info = buildEventMissionInfo({
    eventMissionId: 'event-test-1',
    missions: [{ id: 'ms-test-b', firstThreshold: 5 }],
    userMissions: [existing as never],
  });
  assert.deepEqual(info.UserMissions, [{ __msg: USER_MISSION_MSG, ...existing }]);
});

test('event mission: UserMissions follow the missions order, not the player list order', () => {
  const info = buildEventMissionInfo({
    eventMissionId: 'event-test-1',
    missions: [
      { id: 'ms-test-x', firstThreshold: 1 },
      { id: 'ms-test-y', firstThreshold: 2 },
      { id: 'ms-test-z', firstThreshold: 3 },
    ],
    userMissions: [
      { MissionId: 'ms-test-z', Progress: 9 } as never,
      { MissionId: 'ms-test-x', Progress: 7 } as never,
    ],
  });
  const ids = (info.UserMissions as Array<{ MissionId: string }>).map((m) => m.MissionId);
  assert.deepEqual(ids, ['ms-test-x', 'ms-test-y', 'ms-test-z']);
  const progress = (info.UserMissions as Array<{ Progress: number }>).map((m) => m.Progress);
  assert.deepEqual(progress, [7, 0, 9]);
});

test('daily reset boundary: JST day flips at 15:00 UTC', () => {
  // 2026-01-02 00:00 JST is 2026-01-01 15:00 UTC.
  const jstMidnight = Date.UTC(2026, 0, 1, 15, 0, 0, 0);
  const justBefore = jstMidnight - 1;
  assert.equal(sameJstDay(justBefore, justBefore), true);
  assert.equal(sameJstDay(justBefore, jstMidnight), false);
  assert.equal(sameJstDay(jstMidnight, jstMidnight), true);
  assert.equal(sameJstDay(jstMidnight, jstMidnight + 24 * 60 * 60 * 1000 - 1), true);
  // 2026-01-01 14:59:59 UTC is 2026-01-01 23:59:59 JST: still the same day.
  assert.equal(sameJstDay(Date.UTC(2026, 0, 1, 14, 59, 59, 999), jstMidnight), false);
});

test('fresh marathon mission row starts at Progress 0 with the lowest threshold', () => {
  assert.deepEqual(freshMarathonMission('ms-test-a', 10, 1234), {
    __msg: USER_MISSION_MSG,
    MissionId: 'ms-test-a',
    CurrentThreshold: 10,
    Progress: 0,
    StatusType: 1,
    LastUpdateTime: 1234,
  });
});

const NOW = 1_700_000_000_000;

function missionRow(id: string, threshold: number, progress = 0): Record<string, unknown> {
  return {
    __msg: USER_MISSION_MSG,
    MissionId: id,
    CurrentThreshold: threshold,
    Progress: progress,
    StatusType: 1,
  };
}

test('1201 advances by the clear count', () => {
  const master = {
    MissionType: MissionType.MarathonQuestClearCount,
    TargetIds: [],
    Progresses: [{ Threshold: 5 }, { Threshold: 10 }],
  };
  const row = missionRow('ms-test-count', 5);

  let step = applyMissionProgress(row as never, master, MissionType.MarathonQuestClearCount, 3, false, [], NOW);
  assert.equal(row.Progress, 3);
  assert.equal(step.changed, true);
  assert.equal(step.newlyCompleted, false);

  step = applyMissionProgress(row as never, master, MissionType.MarathonQuestClearCount, 2, false, [], NOW);
  assert.equal(row.Progress, 5);
  assert.equal(step.changed, true);
  assert.equal(step.newlyCompleted, true);
});

test('1202 reach respects TargetIds and keeps the maximum progress', () => {
  const masterQuest1 = {
    MissionType: MissionType.MarathonQuestClearDifficulty,
    TargetIds: ['quest-1'],
    Progresses: [{ Threshold: 5 }, { Threshold: 10 }],
  };
  const masterQuest2 = {
    MissionType: MissionType.MarathonQuestClearDifficulty,
    TargetIds: ['quest-2'],
    Progresses: [{ Threshold: 5 }, { Threshold: 10 }],
  };
  const masterAny = {
    MissionType: MissionType.MarathonQuestClearDifficulty,
    TargetIds: [],
    Progresses: [{ Threshold: 5 }, { Threshold: 10 }],
  };
  const row1 = missionRow('ms-test-diff-1', 5);
  const row2 = missionRow('ms-test-diff-2', 5);
  const rowAny = missionRow('ms-test-diff-any', 5);

  const reach = (row: Record<string, unknown>, master: Record<string, unknown>, value: number) =>
    applyMissionProgress(
      row as never,
      master,
      MissionType.MarathonQuestClearDifficulty,
      value,
      true,
      ['quest-1'],
      NOW,
    );

  reach(row1, masterQuest1, 3);
  reach(row2, masterQuest2, 3);
  reach(rowAny, masterAny, 3);
  assert.equal(row1.Progress, 3);
  assert.equal(row2.Progress, 0);
  assert.equal(rowAny.Progress, 3);

  // A lower value never lowers progress.
  const unchanged = reach(row1, masterQuest1, 2);
  assert.equal(unchanged.changed, false);
  assert.equal(row1.Progress, 3);

  // A non-matching action target cannot advance a targeted mission.
  assert.equal(applyMissionProgress(row1 as never, masterQuest1, MissionType.MarathonQuestClearDifficulty, 9, true, [], NOW).changed, false);
  assert.equal(row1.Progress, 3);

  // The value is clamped to the highest master threshold.
  reach(row1, masterQuest1, 100);
  reach(rowAny, masterAny, 100);
  assert.equal(row1.Progress, 10);
  assert.equal(rowAny.Progress, 10);
});

function eventMissionMaster(id: string, overrides: Record<string, unknown> = {}): never {
  return {
    __msg: 'Solis.Common.Proto.MasterData.Mission',
    Id: id,
    MissionType: 1201,
    CategoryType: 2,
    TargetIds: [],
    Progresses: [{ Threshold: 1, RewardSetId: 'reward-test-1' }],
    ViewConditionId: 'view-test-1',
    Name: `name-${id}`,
    Order: 1,
    ...overrides,
  } as never;
}

function masterIds(rows: unknown[]): string[] {
  return rows.map((r) => String((r as { Id: string }).Id));
}

test('dedupe: missions differing only in category and date window collapse to the first', () => {
  const first = eventMissionMaster('ms-a', { CategoryType: 1, ViewConditionId: 'view-a', Name: 'name-a', Order: 1 });
  const second = eventMissionMaster('ms-b', { CategoryType: 3, ViewConditionId: 'view-b', Name: 'name-b', Order: 2 });
  assert.deepEqual(masterIds(dedupeEventMissions([first, second])), ['ms-a']);
});

test('dedupe: same type and targets with different thresholds are both kept', () => {
  const first = eventMissionMaster('ms-a', { Progresses: [{ Threshold: 1, RewardSetId: 'reward-test-1' }] });
  const second = eventMissionMaster('ms-b', { Progresses: [{ Threshold: 2, RewardSetId: 'reward-test-1' }] });
  assert.deepEqual(masterIds(dedupeEventMissions([first, second])), ['ms-a', 'ms-b']);
});

test('dedupe: same thresholds with different TargetIds are both kept', () => {
  const first = eventMissionMaster('ms-a', { TargetIds: ['target-test-1'] });
  const second = eventMissionMaster('ms-b', { TargetIds: ['target-test-2'] });
  assert.deepEqual(masterIds(dedupeEventMissions([first, second])), ['ms-a', 'ms-b']);
});

test('dedupe: keeps the master order and ignores TargetIds order', () => {
  const first = eventMissionMaster('ms-a', { TargetIds: ['target-test-2', 'target-test-1'] });
  const second = eventMissionMaster('ms-b', { MissionType: 1202 });
  const duplicate = eventMissionMaster('ms-c', { TargetIds: ['target-test-1', 'target-test-2'] });
  assert.deepEqual(masterIds(dedupeEventMissions([first, second, duplicate])), ['ms-a', 'ms-b']);
});
