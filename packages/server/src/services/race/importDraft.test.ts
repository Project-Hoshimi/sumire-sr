// Race draft derivation tests. Pure unit tests: the master JSON ships with the
// server and the master-row lookups are plain values, so no database is needed.
//
//   node --test src/services/race/importDraft.test.ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { deriveRaceDraft, type RaceDraftLookups } from './importDraft.ts';
import {
  RACE_AREA_QUEST_REWARD_DEFAULTS,
  RACE_LIVE_BONUS_GROUP_ID,
  RACE_RANK_GRADE_DEFAULTS,
} from './types.ts';

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

const raceQuests = MISSING_MASTER ? [] : loadMaster('RaceQuest');
const racePanels = MISSING_MASTER ? [] : loadMaster('RacePanel');

/** Board areas of a race: distinct `RaceAreaId` of panels that name its panel quests. */
function boardAreas(raceId: string): string[] {
  const prefix = `race-qt-${/(\d{2}-\d{4})$/.exec(raceId)?.[1] ?? ''}-`;
  return [
    ...new Set(
      racePanels
        .filter((row) => String(row.RaceQuestId ?? '').startsWith(prefix))
        .map((row) => String(row.RaceAreaId ?? '')),
    ),
  ].sort();
}

function lookupsFor(raceId: string, overrides: Partial<RaceDraftLookups> = {}): RaceDraftLookups {
  const prefix = `race-qt-${/(\d{2}-\d{4})$/.exec(raceId)?.[1] ?? ''}-`;
  const asset = `event-${raceId}`;
  return {
    existingItemIds: loadMaster('Item').map((row) => String(row.Id ?? '')),
    emblemName: loadMaster('Emblem').find((row) => row.AssetId === raceId)?.Name as string | null ?? null,
    eventStoryId:
      (loadMaster('EventStory').find((row) => row.AssetId === asset)?.Id as string | undefined) ?? null,
    eventMissionName:
      (loadMaster('EventMission').find((row) => row.Id === asset)?.Name as string | undefined) ?? null,
    areaIds: boardAreas(raceId),
    areaQuestIds: raceQuests
      .filter((row) => String(row.Id ?? '').startsWith(prefix))
      .map((row) => String(row.Id ?? '')),
    ...overrides,
  };
}

testWithMaster('race-26-0226 derives 15 board areas', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.equal(draft.areaIds.length, 15);
  assert.equal(draft.areaIds[0], 'race-area-005-01');
  assert.equal(draft.areaIds[14], 'race-area-005-15');
});

testWithMaster('race-26-0226 derives the three race items and the event mission / story', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.equal(draft.racePointItemId, `item-race_point-${SUFFIX}`);
  assert.equal(draft.raceMedalItemId, `item-race_medal-${SUFFIX}`);
  assert.equal(draft.raceLiveBonusResetItemId, `item-race_reset-live-bonus-${SUFFIX}`);
  assert.equal(draft.eventMissionId, EVENT_ASSET);
  assert.equal(draft.eventStoryId, 'st-eve-2603-race');
  assert.equal(draft.assetId, EVENT_ASSET);
  assert.equal(draft.bannerAssetId, `img_banner_l_${EVENT_ASSET}`);
  assert.equal(draft.name, 'あなたに捧ぐWith your songs');
});

testWithMaster('race-26-0226 derives the pt / medal area quests', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.equal(draft.areaQuestIds.pt, `race-qt-${SUFFIX}-pt`);
  assert.equal(draft.areaQuestIds.medal, `race-qt-${SUFFIX}-medal`);
});

testWithMaster('derivation falls back to the authored defaults', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.equal(draft.livePanelDifficultyNumber, 1);
  assert.equal(draft.cardCoolTimeMinutes, 60);
  assert.equal(draft.requiredCardCoolTimeRacePointAmount, 100);
  assert.equal(draft.initialRacePointAmount, 3000);
  assert.equal(draft.raceLiveBonusGroupId, RACE_LIVE_BONUS_GROUP_ID);
  assert.equal(draft.rivals, 4);
  assert.deepEqual(draft.activityLesson, {
    racePointPerStepBase: 34,
    racePointPerStepPerTier: 4.5,
    raceMedalPerStepBase: 17,
    raceMedalPerStepPerTier: 3.3,
    maxHours: 36,
  });
  assert.deepEqual(draft.areaQuestReward, RACE_AREA_QUEST_REWARD_DEFAULTS);
  assert.deepEqual(
    draft.rankGrades.map((grade) => grade.id),
    RACE_RANK_GRADE_DEFAULTS.map((grade) => grade.id),
  );
  assert.deepEqual(
    draft.rankGrades.map((grade) => grade.hierarchyPointFrom),
    [0, 50, 120, 200, 300, 450, 600],
  );
});

testWithMaster('missing master rows are left empty for validation to report', () => {
  const draft = deriveRaceDraft('race-30-0101', lookupsFor('race-30-0101'));
  assert.equal(draft.racePointItemId, '');
  assert.equal(draft.raceMedalItemId, '');
  assert.equal(draft.raceLiveBonusResetItemId, '');
  assert.equal(draft.eventMissionId, '');
  assert.equal(draft.eventStoryId, '');
  assert.equal(draft.bannerAssetId, '');
  assert.equal(draft.name, 'race-30-0101');
  assert.equal(draft.areaIds.length, 0);
  assert.equal(draft.areaQuestIds.pt, '');
  assert.equal(draft.areaQuestIds.medal, '');
});
