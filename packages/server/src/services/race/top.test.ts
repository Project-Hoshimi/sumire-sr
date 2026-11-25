// Race:Top payload, Home banner block and initial-login flag. Pure builder
// tests: board counts and difficulty rows come from the shipped master JSON.
//
//   node --test src/services/race/top.test.ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { deriveRaceDraft, type RaceDraftLookups } from './importDraft.ts';
import { managerLevelSettingsSatisfied } from '../conditions.ts';
import { buildRaceInfo, buildRaceLiveQuestInfoFromRows, raceNpcRosterId } from './top.ts';
import { applyRaceInfosToHome, homeRaceInfo } from './home.ts';
import { emptyRaceState, markRaceInitialLogin, normalizeRaceState } from './state.ts';
import { tierUnlocked } from './tiers.ts';
import { RACE_DEFAULT_NPC_ROSTER_ID } from './types.ts';
import type { RaceState } from './state.ts';

interface Row {
  [key: string]: unknown;
}

/**
 * phaseA2/out/structured holds the generated game master data at the repository
 * root. The public export does not ship it, so master-driven tests skip there
 * instead of failing on a missing file.
 */
const MASTER_DIR = new URL('../../../../phaseA2/out/structured/', import.meta.url);
const MISSING_MASTER =
  !existsSync(new URL('RaceQuest.json', MASTER_DIR)) &&
  'phaseA2/out/structured is generated master data, not in this checkout';

function loadMaster(type: string): Row[] {
  return JSON.parse(readFileSync(new URL(`${type}.json`, MASTER_DIR), 'utf8')) as Row[];
}

/** Register a test whose fixture rows come from the generated master JSON. */
function testWithMaster(name: string, fn: () => void): void {
  test(name, { skip: MISSING_MASTER }, fn);
}

const RACE_ID = 'race-26-0226';
const SUFFIX = '26-0226';
const QUEST_PREFIX = `race-qt-${SUFFIX}-`;
const EVENT_ASSET = `event-${RACE_ID}`;
const WINDOW = {
  startTime: Date.UTC(2026, 2, 2, 5, 0, 0),
  endTime: Date.UTC(2026, 2, 16, 14, 59, 59),
  exchangeEndTime: Date.UTC(2026, 2, 18, 14, 59, 59),
};

function loadConfig() {
  const panels = loadMaster('RacePanel');
  const races = loadMaster('RaceQuest');
  const lookups: RaceDraftLookups = {
    existingItemIds: loadMaster('Item').map((row) => String(row.Id ?? '')),
    emblemName: (loadMaster('Emblem').find((row) => row.AssetId === RACE_ID)?.Name as string) ?? null,
    eventStoryId: (loadMaster('EventStory').find((row) => row.AssetId === EVENT_ASSET)?.Id as string) ?? null,
    eventMissionName:
      (loadMaster('EventMission').find((row) => row.Id === EVENT_ASSET)?.Name as string) ?? null,
    areaIds: [
      ...new Set(
        panels
          .filter((row) => String(row.RaceQuestId ?? '').startsWith(QUEST_PREFIX))
          .map((row) => String(row.RaceAreaId ?? '')),
      ),
    ].sort(),
    areaQuestIds: races
      .filter((row) => String(row.Id ?? '').startsWith(QUEST_PREFIX))
      .map((row) => String(row.Id ?? '')),
  };
  return { config: deriveRaceDraft(RACE_ID, lookups), panels };
}

function panelCounts(panels: readonly Row[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of panels) {
    const areaId = String(row.RaceAreaId ?? '');
    if (!areaId.startsWith('race-area-005-')) continue;
    counts.set(areaId, (counts.get(areaId) ?? 0) + 1);
  }
  return counts;
}

function clearedState(raceQuestId: string, clear: number): RaceState {
  const state = emptyRaceState();
  state.areaQuestClear[raceQuestId] = clear;
  return state;
}

testWithMaster('Race:Top raceAreaInfos carry the board panel counts in area order', () => {
  const { config, panels } = loadConfig();
  const info = buildRaceInfo(config, WINDOW, panelCounts(panels), {
    eventStoryInfo: null,
    eventMissionInfo: null,
  });
  const areas = info.RaceAreaInfos as Decoded[];
  assert.equal(areas.length, 15);
  assert.deepEqual(
    areas.map((area) => area.Order),
    Array.from({ length: 15 }, (_, index) => index + 1),
  );
  assert.equal(areas[0].RaceAreaId, 'race-area-005-01');
  assert.equal(areas[0].PanelCount, 50);
  assert.equal(areas[13].PanelCount, 50);
  assert.equal(areas[14].RaceAreaId, 'race-area-005-15');
  assert.equal(areas[14].PanelCount, 75);
});

testWithMaster('Race:Top raceInfo carries 7 rank grades and the race items', () => {
  const { config, panels } = loadConfig();
  const info = buildRaceInfo(config, WINDOW, panelCounts(panels), {
    eventStoryInfo: null,
    eventMissionInfo: null,
  });
  assert.equal(info.Id, RACE_ID);
  assert.equal(info.RacePointItemId, `item-race_point-${SUFFIX}`);
  assert.equal(info.RaceMedalItemId, `item-race_medal-${SUFFIX}`);
  assert.equal(info.RaceLiveBonusResetItemId, `item-race_reset-live-bonus-${SUFFIX}`);
  assert.equal(info.LivePanelDifficultyNumber, 1);
  assert.equal(info.CardCoolTimeMinutes, 60);
  assert.equal(info.RaceLiveBonusGroupId, 'race_live_bonus_group-001');
  assert.equal(info.StartTime, WINDOW.startTime);
  assert.equal(info.AggregateEndTime, WINDOW.endTime);
  const grades = info.RaceRankGradeInfos as Decoded[];
  assert.equal(grades.length, 7);
  assert.deepEqual(
    grades.map((grade) => grade.Id),
    [
      'race_rank_grade-bronze',
      'race_rank_grade-silver',
      'race_rank_grade-gold',
      'race_rank_grade-platinum',
      'race_rank_grade-diamond1',
      'race_rank_grade-diamond2',
      'race_rank_grade-challenger',
    ],
  );
  assert.equal(grades[0].Name, 'ブロンズ');
  assert.equal(grades[6].HierarchyPointFrom, 600);
});

testWithMaster('live quest info lists every pt difficulty tier with clear / unlock state', () => {
  const ptQuestId = `${QUEST_PREFIX}pt`;
  const rows = loadMaster('RaceQuestDifficulty').filter(
    (row) => row.RaceQuestId === ptQuestId,
  ) as unknown as Decoded[];

  const fresh = buildRaceLiveQuestInfoFromRows(ptQuestId, rows, emptyRaceState());
  assert.equal(fresh.RaceQuestId, ptQuestId);
  // Master pt / medal tiers start at difficulty number 2, so a fresh player's
  // clear level must be reported as the level just below the first tier: the
  // client resolves the quest icon with FindByKey(RaceQuestId, NextLevel) and
  // crashes on a level no tier defines (0).
  assert.equal(fresh.CurrentClearDifficultyNumber, 1);
  assert.equal(fresh.BeforeClearDifficultyNumber, 1);
  // Mirror of the client's icon level resolution in
  // RaceMainItemQuestButton.SetRaceLiveQuestInfo: bump by one when that tier
  // exists, then the difficulty row must exist in the client master.
  const tierNumbers = rows.map((row) => row.DifficultyNumber as number);
  const iconLevel = (info: Decoded): number => {
    const level = info.CurrentClearDifficultyNumber as number;
    return tierNumbers.includes(level + 1) ? level + 1 : level;
  };
  assert.equal(tierNumbers.includes(iconLevel(fresh)), true);
  assert.equal(iconLevel(fresh), 2);
  const freshTiers = fresh.DifficultyLevelInfos as Decoded[];
  assert.equal(freshTiers.length, 54);
  // Master pt / medal tiers start at difficulty number 2, so only the lowest
  // existing tier is unlocked for a fresh player (architect decision A).
  assert.deepEqual(
    freshTiers.filter((tier) => tier.Unlocked).map((tier) => tier.RaceLiveQuestDifficultyNumber),
    [2],
  );
  assert.equal(freshTiers.filter((tier) => tier.Cleared).length, 0);

  const state = clearedState(ptQuestId, 5);
  state.areaQuestHighScore[ptQuestId] = { '2': 70000 };
  const cleared = buildRaceLiveQuestInfoFromRows(ptQuestId, rows, state);
  assert.equal(cleared.CurrentClearDifficultyNumber, 5);
  assert.equal(tierNumbers.includes(iconLevel(cleared)), true);
  assert.equal(iconLevel(cleared), 6);
  const maxed = buildRaceLiveQuestInfoFromRows(ptQuestId, rows, clearedState(ptQuestId, 55));
  assert.equal(maxed.CurrentClearDifficultyNumber, 55);
  assert.equal(tierNumbers.includes(iconLevel(maxed)), true);
  const tiers = cleared.DifficultyLevelInfos as Decoded[];
  assert.deepEqual(
    tiers.filter((tier) => tier.Cleared).map((tier) => tier.RaceLiveQuestDifficultyNumber),
    [2, 3, 4, 5],
  );
  assert.deepEqual(
    tiers.filter((tier) => tier.Unlocked && !tier.Cleared).map((tier) => tier.RaceLiveQuestDifficultyNumber),
    [6],
  );
  assert.equal(tiers[0].HighestScore, 70000);
});

testWithMaster('live quest info is built for the medal area quest too', () => {
  const medalQuestId = `${QUEST_PREFIX}medal`;
  const rows = loadMaster('RaceQuestDifficulty').filter(
    (row) => row.RaceQuestId === medalQuestId,
  ) as unknown as Decoded[];
  const info = buildRaceLiveQuestInfoFromRows(medalQuestId, rows, emptyRaceState());
  assert.equal(info.RaceQuestId, medalQuestId);
  assert.equal((info.DifficultyLevelInfos as Decoded[]).length, 54);
});

testWithMaster('versus area-quest tiers carry the race NPC roster opponent', () => {
  const medalQuestId = `${QUEST_PREFIX}medal`;
  const rows = loadMaster('RaceQuestDifficulty').filter(
    (row) => row.RaceQuestId === medalQuestId,
  ) as unknown as Decoded[];
  const info = buildRaceLiveQuestInfoFromRows(
    medalQuestId,
    rows,
    emptyRaceState(),
    RACE_DEFAULT_NPC_ROSTER_ID,
  );
  const tiers = info.DifficultyLevelInfos as Decoded[];
  // Every medal tier is a versus stage (no authored ClearScore), so each one
  // previews the roster the live actually plays, scaled to its difficulty level.
  tiers.forEach((tier, index) => {
    const level = Number(rows[index].DifficultyLevel);
    const opponent = tier.OpponentInfo as Decoded;
    assert.equal(opponent.Name, '対戦アイドル');
    assert.equal(opponent.ManagerLevel, level);
    const cards = opponent.CardInfos as Decoded[];
    assert.equal(cards.length, 5);
    assert.equal(cards[0].Level, level);
  });
  const first = tiers[0].OpponentInfo as Decoded;
  assert.equal(first.ManagerLevel, 10);
  assert.equal((first.CardInfos as Decoded[])[0].CardId, 'card-skr-05-idol-00');
  assert.equal((first.CardInfos as Decoded[])[0].Level, 10);
});

testWithMaster('score area-quest tiers keep their opponent info empty like marathon solos', () => {
  // pt tiers are authored with a `ClearScore`, so the live is a score battle and
  // marathon deliberately leaves the opponent preview empty for those stages.
  const ptQuestId = `${QUEST_PREFIX}pt`;
  const rows = loadMaster('RaceQuestDifficulty').filter(
    (row) => row.RaceQuestId === ptQuestId,
  ) as unknown as Decoded[];
  assert.notEqual(Number(rows[0].ClearScore ?? 0), 0);
  const info = buildRaceLiveQuestInfoFromRows(
    ptQuestId,
    rows,
    emptyRaceState(),
    RACE_DEFAULT_NPC_ROSTER_ID,
  );
  for (const tier of info.DifficultyLevelInfos as Decoded[]) {
    assert.deepEqual(tier.OpponentInfo, { __msg: 'Solis.Common.Proto.Api.QuestOpponentInfo' });
  }
});

testWithMaster('raceNpcRosterId prefers the per-quest override', () => {
  const { config } = loadConfig();
  assert.equal(raceNpcRosterId(config, config.areaQuestIds.medal), RACE_DEFAULT_NPC_ROSTER_ID);
  assert.equal(
    raceNpcRosterId({ ...config, npcRosterByQuest: { [config.areaQuestIds.medal]: 'qt-main-1-015-06' } }, config.areaQuestIds.medal),
    'qt-main-1-015-06',
  );
});

testWithMaster('Home gets HomeRaceInfo rows when a race is open', () => {
  const { config } = loadConfig();
  const decoded: Decoded = { __msg: 'Solis.Common.Proto.Api.HomeEnterResponse' };
  applyRaceInfosToHome(decoded, [{ config, window: WINDOW }]);
  const eventInfo = decoded.EventInfo as Decoded;
  assert.equal(eventInfo.__msg, 'Solis.Common.Proto.Api.HomeEventInfo');
  const infos = eventInfo.RaceInfos as Decoded[];
  assert.equal(infos.length, 1);
  const [home] = infos;
  assert.equal(home.__msg, 'Solis.Common.Proto.Api.HomeRaceInfo');
  assert.equal(home.Id, RACE_ID);
  assert.equal(home.Name, 'あなたに捧ぐWith your songs');
  assert.equal(home.AssetId, EVENT_ASSET);
  // The banner follows marathon's `img_banner_l_<eventMissionId>` convention;
  // the EventStory asset id is not an image name the client can load.
  assert.equal(home.BannerAssetId, `img_banner_l_${EVENT_ASSET}`);
  assert.equal(home.StartTime, WINDOW.startTime);
  assert.equal(home.EndTime, WINDOW.endTime);
  assert.equal(home.AggregateEndTime, WINDOW.endTime);
  assert.equal(home.ExchangeEndTime, WINDOW.exchangeEndTime);
  assert.equal(home.Order, 1);
  assert.equal(home.UnlockConditionId, '');
  assert.equal(home.IsUnlocked, true);
  assert.equal(home.EventMissionId, EVENT_ASSET);
  assert.equal(home.IsLessenRewardMax, false);
});

test('Home is left untouched when no race is open', () => {
  const decoded: Decoded = { __msg: 'Solis.Common.Proto.Api.HomeEnterResponse' };
  applyRaceInfosToHome(decoded, []);
  assert.equal(decoded.EventInfo, undefined);
});

testWithMaster('homeRaceInfo keeps the existing HomeEventInfo block', () => {
  const { config } = loadConfig();
  const decoded: Decoded = {
    __msg: 'Solis.Common.Proto.Api.HomeEnterResponse',
    EventInfo: { __msg: 'Solis.Common.Proto.Api.HomeEventInfo', MarathonInfos: [{ Id: 'marathon-1' }] },
  };
  applyRaceInfosToHome(decoded, [{ config, window: WINDOW }]);
  const eventInfo = decoded.EventInfo as Decoded;
  assert.deepEqual(eventInfo.MarathonInfos, [{ Id: 'marathon-1' }]);
  assert.equal((eventInfo.RaceInfos as Decoded[]).length, 1);
  assert.equal(homeRaceInfo(config, WINDOW).Id, RACE_ID);
});

test('IsInitialLogin is true once, then false, and survives persistence', () => {
  const state = emptyRaceState();
  assert.equal(markRaceInitialLogin(state), true);
  assert.equal(markRaceInitialLogin(state), false);
  // The singleton is stored as JSON, so the flag must round-trip through it.
  const restored = normalizeRaceState(JSON.parse(JSON.stringify(state)) as Decoded);
  assert.equal(restored.initialized, true);
  assert.equal(markRaceInitialLogin(restored), false);
});

test('the activity lesson clock starts with the state, not with the first claim', () => {
  const state = emptyRaceState();
  assert.equal(state.lastActivityReceiveMs, 0);
  const now = Date.UTC(2026, 2, 2, 5, 0, 0);
  assert.equal(markRaceInitialLogin(state, now), true);
  // Set on the very first visit, so the lesson accrues while the player is on
  // the board instead of waiting for Race:ReceiveActivityLesson.
  assert.equal(state.lastActivityReceiveMs, now);
  // Later visits keep the running clock.
  assert.equal(markRaceInitialLogin(state, now + 1_000), false);
  assert.equal(state.lastActivityReceiveMs, now);
  // A legacy save without a clock gets one started.
  const legacy = { ...emptyRaceState(), initialized: true };
  assert.equal(markRaceInitialLogin(legacy, now), false);
  assert.equal(legacy.lastActivityReceiveMs, now);
});

test('tier unlock follows the existing tiers, not a flat +1 (gapped tiers 2, 4, 6)', () => {
  const rows = [2, 4, 6].map((DifficultyNumber) => ({ DifficultyNumber })) as unknown as Decoded[];
  // Fresh: only the lowest tier.
  assert.equal(tierUnlocked(rows, 0, 2), true);
  assert.equal(tierUnlocked(rows, 0, 4), false);
  assert.equal(tierUnlocked(rows, 0, 6), false);
  // Cleared 2: the next existing tier (4) unlocks, 6 stays locked.
  assert.equal(tierUnlocked(rows, 2, 4), true);
  assert.equal(tierUnlocked(rows, 2, 6), false);
  // Tier 3 does not exist for this quest, so it is never unlocked.
  for (const cleared of [0, 2, 4, 6]) assert.equal(tierUnlocked(rows, cleared, 3), false);
});

testWithMaster('the pt tier-3 unlock condition is satisfied from manager level 35', () => {
  const ptQuestId = `${QUEST_PREFIX}pt`;
  const rows = loadMaster('RaceQuestDifficulty').filter(
    (row) => row.RaceQuestId === ptQuestId,
  ) as unknown as Decoded[];
  const tier3 = rows.find((row) => Number(row.DifficultyNumber) === 3);
  const conditionId = String(tier3?.UnlockConditionId ?? '');
  assert.equal(conditionId, 'cd-race-qt-26-0226-pt-003');
  const condition = loadMaster('Condition').find((row) => row.Id === conditionId);
  assert.ok(condition, 'master data must ship the tier-3 unlock condition');

  // The condition is [{}, {ManagerLevel: {LevelGte: 35}}]: the empty setting is
  // the previous-clear rule, the ManagerLevel one the level gate.
  assert.equal(managerLevelSettingsSatisfied(condition.Settings, 34), false);
  assert.equal(managerLevelSettingsSatisfied(condition.Settings, 35), true);

  // Tier 3 is locked for a fresh player without the condition...
  assert.equal(tierUnlocked(rows, 0, 3), false);
  assert.equal(tierUnlocked(rows, 0, 3, { managerLevelConditions: new Set() }), false);
  // ...and opens once the manager level satisfies it.
  assert.equal(tierUnlocked(rows, 0, 3, { managerLevelConditions: new Set([conditionId]) }), true);
  // The level unlock does not cascade to tier 4 (its condition id differs).
  assert.equal(tierUnlocked(rows, 0, 4, { managerLevelConditions: new Set([conditionId]) }), false);
  // Previous-clear still unlocks tier 3 without any condition.
  assert.equal(tierUnlocked(rows, 2, 3), true);

  // The same set reaches the RaceLiveQuestInfo builder.
  const info = buildRaceLiveQuestInfoFromRows(
    ptQuestId,
    rows,
    emptyRaceState(),
    undefined,
    new Set([conditionId]),
  );
  const unlocked = (info.DifficultyLevelInfos as Decoded[])
    .filter((tier) => tier.Unlocked)
    .map((tier) => tier.RaceLiveQuestDifficultyNumber);
  assert.deepEqual(unlocked, [2, 3]);
});

test('manager level settings unlock only when the level gate is the only setting kind', () => {
  assert.equal(managerLevelSettingsSatisfied([{}, { ManagerLevel: { LevelGte: 35 } }], 34), false);
  assert.equal(managerLevelSettingsSatisfied([{}, { ManagerLevel: { LevelGte: 35 } }], 35), true);
  assert.equal(managerLevelSettingsSatisfied([{}], 200), false);
  assert.equal(managerLevelSettingsSatisfied([], 200), false);
  assert.equal(managerLevelSettingsSatisfied([{ ClearArea: { AreaId: 'race-area-005-01' } }], 200), false);
  assert.equal(
    managerLevelSettingsSatisfied(
      [{ ManagerLevel: { LevelGte: 35 }, ClearArea: { AreaId: 'race-area-005-01' } }],
      200,
    ),
    false,
  );
  assert.equal(managerLevelSettingsSatisfied([{ ManagerLevel: { LevelLte: 20 } }], 21), false);
  assert.equal(managerLevelSettingsSatisfied([{ ManagerLevel: { LevelLte: 20 } }], 20), true);
});
