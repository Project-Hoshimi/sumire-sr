// Marathon event story and event mission builders. Pure unit tests; no database.
//
//   node --test src/services/marathon/eventInfo.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INITIAL_RAID_STAMINA,
  RAID_LIMIT_HOURS,
  RAID_REQUIRED_POINT_FRIEND_DISCOUNT_RATE_PERMIL,
  RAID_STAMINA_RECOVERY_MINUTES,
  buildEventMissionInfo,
  buildEventStoryInfo,
  buildLadderInfo,
  buildRaidMarathonInfoFields,
  buildRaidQuestInfo,
  dedupeEventMissions,
  freshMarathonMission,
  ladderPointItemIdCandidate,
  raidStaminaRecoveryItemIdCandidate,
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

const RAID_QUEST_MSG = 'Solis.Common.Proto.Api.MarathonRaidQuest';
const RAID_QUEST_DIFFICULTY_MSG = 'Solis.Common.Proto.Api.MarathonRaidQuestDifficulty';

test('raid quest: null or undefined row gives undefined', () => {
  assert.equal(buildRaidQuestInfo(null), undefined);
  assert.equal(buildRaidQuestInfo(undefined), undefined);
});

test('raid quest: every master field maps to the api field and difficulties are sorted', () => {
  const info = buildRaidQuestInfo({
    Id: 'marathon-raid-test-quest-raid',
    StageId: 'stage-live-dome-02-02',
    Name: '協力ライブ',
    Description: '協力ライブ',
    UnlockConditionId: 'unlock-test-1',
    UnlockDescription: 'No.4を1つでもクリアしましょう',
    MusicId: 'music-test-001',
    MusicChartPatternId: 'chart-test-001-001',
    Position1AttributeType: 1,
    Position2AttributeType: 2,
    Position3AttributeType: 3,
    Position4AttributeType: 4,
    Position5AttributeType: 5,
    ActiveSkillWeightPermil: 100,
    SpecialSkillWeightPermil: 200,
    SkillStaminaWeightPermil: 300,
    StaminaRecoveryWeightPermil: 400,
    BeatDanceWeightPermil: 200,
    BeatVocalWeightPermil: 400,
    BeatVisualWeightPermil: 400,
    QuestPressureId: 'quest_pressure-2',
    QuestCharacterAdvantageId: '',
    QuestAudienceAdvantageId: 'quest_audience_advantage_1',
    MoodType: 0,
    MaxCapacity: 40000,
    LiveBonusGroupId: 'live-bonus-group-test',
    Unlocked: true,
    Difficulties: [
      {
        RaidQuestId: 'marathon-raid-test-quest-raid',
        DifficultyNumber: 2,
        DifficultyLevel: 20,
        MentalThreshold: 10,
        ClearScore: '26100000',
        RequiredRaidStamina: 20,
        HostRewardId: 'rd-host',
        JoinRewardId: 'rd-join',
        MvpRewardId: 'rd-mvp',
        UnlockConditionId: 'unlock-test-2',
        RewardManagerExp: 0,
        RewardCardExp: 0,
        Cleared: false,
        Unlocked: true,
        LiveSkipType: 2,
      },
      {
        RaidQuestId: 'marathon-raid-test-quest-raid',
        DifficultyNumber: 1,
        DifficultyLevel: 10,
        MentalThreshold: 10,
        ClearScore: 100,
        RequiredRaidStamina: 10,
        HostRewardId: 'rd-host-1',
        JoinRewardId: 'rd-join-1',
        MvpRewardId: 'rd-mvp-1',
        UnlockConditionId: '',
        RewardManagerExp: 1,
        RewardCardExp: 2,
        Cleared: true,
        Unlocked: true,
        LiveSkipType: 2,
      },
    ],
  });

  assert.equal(info?.__msg, RAID_QUEST_MSG);
  assert.deepEqual(info, {
    __msg: RAID_QUEST_MSG,
    Id: 'marathon-raid-test-quest-raid',
    StageId: 'stage-live-dome-02-02',
    Name: '協力ライブ',
    Description: '協力ライブ',
    UnlockConditionId: 'unlock-test-1',
    UnlockDescription: 'No.4を1つでもクリアしましょう',
    MusicId: 'music-test-001',
    MusicChartPatternId: 'chart-test-001-001',
    Position1AttributeType: 1,
    Position2AttributeType: 2,
    Position3AttributeType: 3,
    Position4AttributeType: 4,
    Position5AttributeType: 5,
    ActiveSkillWeightPermil: 100,
    SpecialSkillWeightPermil: 200,
    SkillStaminaWeightPermil: 300,
    StaminaRecoveryWeightPermil: 400,
    BeatDanceWeightPermil: 200,
    BeatVocalWeightPermil: 400,
    BeatVisualWeightPermil: 400,
    QuestPressureId: 'quest_pressure-2',
    QuestCharacterAdvantageId: '',
    QuestAudienceAdvantageId: 'quest_audience_advantage_1',
    MoodType: 0,
    MaxCapacity: 40000,
    LiveBonusGroupId: 'live-bonus-group-test',
    Unlocked: true,
    Difficulties: [
      {
        __msg: RAID_QUEST_DIFFICULTY_MSG,
        RaidQuestId: 'marathon-raid-test-quest-raid',
        DifficultyNumber: 1,
        DifficultyLevel: 10,
        MentalThreshold: 10,
        ClearScore: 100,
        RequiredRaidStamina: 10,
        HostRewardId: 'rd-host-1',
        JoinRewardId: 'rd-join-1',
        MvpRewardId: 'rd-mvp-1',
        UnlockConditionId: '',
        RewardManagerExp: 1,
        RewardCardExp: 2,
        Cleared: true,
        Unlocked: true,
        LiveSkipType: 2,
      },
      {
        __msg: RAID_QUEST_DIFFICULTY_MSG,
        RaidQuestId: 'marathon-raid-test-quest-raid',
        DifficultyNumber: 2,
        DifficultyLevel: 20,
        MentalThreshold: 10,
        ClearScore: 26100000,
        RequiredRaidStamina: 20,
        HostRewardId: 'rd-host',
        JoinRewardId: 'rd-join',
        MvpRewardId: 'rd-mvp',
        UnlockConditionId: 'unlock-test-2',
        RewardManagerExp: 0,
        RewardCardExp: 0,
        Cleared: false,
        Unlocked: true,
        LiveSkipType: 2,
      },
    ],
  });
});

test('raid quest: missing optional fields default to empty string, zero and false', () => {
  const info = buildRaidQuestInfo({ Id: 'marathon-raid-test-quest-raid' });
  const difficulties = info?.Difficulties as unknown[] | undefined;
  assert.equal(difficulties?.length ?? -1, 0);
  assert.equal(info?.Name, '');
  assert.equal(info?.MusicId, '');
  assert.equal(info?.MaxCapacity, 0);
  assert.equal(info?.Unlocked, false);
});

test('raid quest: 0/1 numbers from the structured JSON coerce to booleans', () => {
  const info = buildRaidQuestInfo({
    Id: 'marathon-raid-test-quest-raid',
    Unlocked: 1,
    Difficulties: [{ DifficultyNumber: 1, Cleared: 1, Unlocked: 0 }],
  });
  assert.equal(info?.Unlocked, true);
  const difficulty = info?.Difficulties?.[0] as Record<string, unknown> | undefined;
  assert.equal(difficulty?.Cleared, true);
  assert.equal(difficulty?.Unlocked, false);
});

const LADDER_INFO_MSG = 'Solis.Common.Proto.Api.LadderInfo';

test('ladder point item candidate: date suffix of the marathon id, empty without one', () => {
  assert.equal(ladderPointItemIdCandidate('mini-marathon-raid-23-1226'), 'item-ladder_pt_23-1226-raid');
  assert.equal(ladderPointItemIdCandidate('marathon-22-0526'), 'item-ladder_pt_22-0526-raid');
  assert.equal(ladderPointItemIdCandidate('no-suffix'), '');
});

test('raid stamina recovery item candidate: stem plus raid-stamina_recovery plus suffix', () => {
  assert.equal(
    raidStaminaRecoveryItemIdCandidate('mini-marathon-raid-23-1226'),
    'item-mini-marathon-raid_raid-stamina_recovery-23-1226',
  );
  assert.equal(raidStaminaRecoveryItemIdCandidate('no-suffix'), '');
});

const EVENT_MISSION_FOR_LADDER = {
  __msg: EVENT_MISSION_MSG,
  Id: 'event-ladder-test',
  Unlocked: true,
  UserMissions: [],
} as Record<string, unknown>;

test('ladder info: maps the marathon fields and reuses the event mission info', () => {
  const info = buildLadderInfo({
    marathonId: 'mini-marathon-raid-23-1226',
    name: 'ミニマラソン 協力ライブ',
    startTime: 1000,
    endTime: 2000,
    assetId: 'event-mini-marathon-raid-23-1226',
    ladderPointItemId: 'item-ladder_pt_23-1226-raid',
    eventMissionInfo: EVENT_MISSION_FOR_LADDER,
  });
  assert.deepEqual(info, {
    __msg: LADDER_INFO_MSG,
    Id: 'ladder-mini-marathon-raid-23-1226',
    Name: 'ミニマラソン 協力ライブ',
    StartTime: 1000,
    EndTime: 2000,
    MessageGroupId: '',
    CostumeIds: [],
    LadderPointItemId: 'item-ladder_pt_23-1226-raid',
    AssetId: 'event-mini-marathon-raid-23-1226',
    TopColorCode: '',
    BottomColorCode: '',
    BgmAssetId: '',
    BackgroundAssetId: '',
    EventMissionInfo: EVENT_MISSION_FOR_LADDER,
  });
  assert.equal(info.EventMissionInfo, EVENT_MISSION_FOR_LADDER);
});

test('ladder info: empty ladder point item and no event mission are omitted', () => {
  const info = buildLadderInfo({
    marathonId: 'mini-marathon-raid-23-1226',
    name: 'テスト',
    startTime: 0,
    endTime: 0,
    assetId: '',
    ladderPointItemId: '',
  });
  assert.equal(info.LadderPointItemId, '');
  assert.equal('EventMissionInfo' in info, false);
  assert.deepEqual(info.CostumeIds, []);
});

test('raid marathon fields: type 2 sets LadderInfo and the raid stamina placeholders', () => {
  const fields = buildRaidMarathonInfoFields({
    type: 2,
    marathonId: 'mini-marathon-raid-23-1226',
    name: 'ミニマラソン 協力ライブ',
    startTime: 1000,
    endTime: 2000,
    assetId: 'event-mini-marathon-raid-23-1226',
    eventMissionInfo: EVENT_MISSION_FOR_LADDER,
    ladderPointItemId: 'item-ladder_pt_23-1226-raid',
    raidStaminaRecoveryItemId: 'item-mini-marathon-raid_raid-stamina_recovery-23-1226',
  });
  assert.equal(fields.LadderInfo?.__msg, LADDER_INFO_MSG);
  assert.equal(fields.LadderInfo?.Id, 'ladder-mini-marathon-raid-23-1226');
  assert.equal((fields.LadderInfo?.EventMissionInfo as Record<string, unknown>), EVENT_MISSION_FOR_LADDER);
  assert.equal(fields.RaidStaminaRecoveryItemId, 'item-mini-marathon-raid_raid-stamina_recovery-23-1226');
  assert.equal(fields.InitialRaidStamina, INITIAL_RAID_STAMINA);
  assert.equal(fields.RaidStaminaRecoveryMinutes, RAID_STAMINA_RECOVERY_MINUTES);
  assert.equal(fields.RaidLimitHours, RAID_LIMIT_HOURS);
  assert.equal(fields.RaidRequiredPointFriendDiscountRatePermil, RAID_REQUIRED_POINT_FRIEND_DISCOUNT_RATE_PERMIL);
  assert.equal(fields.InitialRaidStamina, 3);
  assert.equal(fields.RaidStaminaRecoveryMinutes, 60);
  assert.equal(fields.RaidLimitHours, 1);
  assert.equal(fields.RaidRequiredPointFriendDiscountRatePermil, 0);
});

test('raid marathon fields: absent master items give empty item ids', () => {
  const fields = buildRaidMarathonInfoFields({
    type: 2,
    marathonId: 'mini-marathon-raid-23-1226',
    name: 'テスト',
    startTime: 0,
    endTime: 0,
    assetId: '',
    ladderPointItemId: '',
    raidStaminaRecoveryItemId: '',
  });
  assert.equal(fields.LadderInfo?.LadderPointItemId, '');
  assert.equal('RaidStaminaRecoveryItemId' in fields, false);
});

test('raid marathon fields: type 1 marathon gets no LadderInfo and no raid stamina fields', () => {
  const fields = buildRaidMarathonInfoFields({
    type: 1,
    marathonId: 'marathon-22-0526',
    name: 'マラソン',
    startTime: 0,
    endTime: 0,
    assetId: '',
    ladderPointItemId: '',
    raidStaminaRecoveryItemId: '',
  });
  assert.deepEqual(fields, {});
  assert.equal('LadderInfo' in fields, false);
  assert.equal('InitialRaidStamina' in fields, false);
  assert.equal('RaidStaminaRecoveryMinutes' in fields, false);
  assert.equal('RaidLimitHours' in fields, false);
  assert.equal('RaidRequiredPointFriendDiscountRatePermil' in fields, false);
  assert.equal('RaidStaminaRecoveryItemId' in fields, false);
});
