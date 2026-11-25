// Race event plugin tests: validation of an imported draft, the "no board"
// error, placeholder warnings and compile. Pure: no database is required.
//
//   node --test src/services/race/plugin.test.ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { raceLessonRates } from '../../../../admin/src/pages/race/lessonRates.ts';
import { deriveRaceDraft, type RaceDraftLookups } from './importDraft.ts';
import {
  buildRaceBoardPreview,
  resetRaceBoardVenusQuestIdsForTests,
  setRaceBoardRewardPanelKeys,
  setRaceBoardVenusQuestIds,
  type RaceBoardDifficultySource,
  type RaceBoardPanelSource,
  type RaceBoardPanelRewardSource,
  type RaceBoardQuestSource,
  type RaceBoardSource,
} from './boardPreview.ts';
import { defaultRaceDraft, defaultRaceBotConfig, racePlugin } from './plugin.ts';
import { emptyRaceState } from './state.ts';
import {
  RACE_DEFAULT_GRADE_DIFFICULTY,
  RACE_DEFAULT_INITIAL_RACE_POINT_AMOUNT,
  RACE_DEFAULT_NPC_ROSTER_ID,
  type RaceBotConfig,
} from './types.ts';
import { buildRaceActivityLessonProgress, RACE_STEP_INTERVAL_MS } from './userRaceInfo.ts';

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

function suffixOf(raceId: string): string {
  return /(\d{2}-\d{4})$/.exec(raceId)?.[1] ?? '';
}

function lookupsFor(raceId: string): RaceDraftLookups {
  const prefix = `race-qt-${suffixOf(raceId)}-`;
  const asset = `event-${raceId}`;
  const panels = loadMaster('RacePanel');
  return {
    existingItemIds: loadMaster('Item').map((row) => String(row.Id ?? '')),
    emblemName: (loadMaster('Emblem').find((row) => row.AssetId === raceId)?.Name as string) ?? null,
    eventStoryId: (loadMaster('EventStory').find((row) => row.AssetId === asset)?.Id as string) ?? null,
    eventMissionName:
      (loadMaster('EventMission').find((row) => row.Id === asset)?.Name as string) ?? null,
    areaIds: [
      ...new Set(
        panels
          .filter((row) => String(row.RaceQuestId ?? '').startsWith(prefix))
          .map((row) => String(row.RaceAreaId ?? '')),
      ),
    ].sort(),
    areaQuestIds: loadMaster('RaceQuest')
      .filter((row) => String(row.Id ?? '').startsWith(prefix))
      .map((row) => String(row.Id ?? '')),
  };
}

testWithMaster('an imported race-26-0226 draft has no validation errors', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  const issues = racePlugin.validate(draft);
  assert.deepEqual(issues.filter((issue) => issue.severity === 'error'), []);
});

testWithMaster('validate fails for a race without board rows', () => {
  // No RacePanel row references a race-qt-22-0428-* quest, so the board is empty.
  const draft = deriveRaceDraft('race-22-0428', lookupsFor('race-22-0428'));
  assert.deepEqual(draft.areaIds, []);
  const errors = racePlugin.validate(draft).filter((issue) => issue.severity === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, 'areaIds');
  assert.match(errors[0].message, /has no board rows/);
});

testWithMaster('validate reports placeholder values as warnings, not errors', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  draft.name = draft.raceId;
  draft.eventMissionId = '';
  draft.eventStoryId = '';
  const issues = racePlugin.validate(draft);
  assert.deepEqual(issues.filter((issue) => issue.severity === 'error'), []);
  const paths = issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.path);
  assert.deepEqual(paths, ['eventMissionId', 'eventStoryId', 'name']);
});

test('the schema marks master-derived fields read-only and tuning fields editable', () => {
  const fields = new Map(racePlugin.schema.fields.map((field) => [field.path, field]));
  for (const path of [
    'raceId',
    'name',
    'assetId',
    'bannerAssetId',
    'eventMissionId',
    'eventStoryId',
    'areaIds',
    'raceLiveBonusGroupId',
    'areaQuestIds.pt',
    'areaQuestIds.medal',
  ]) {
    assert.equal(fields.get(path)?.readOnly, true, `${path} should be read-only`);
  }
  for (const path of [
    'livePanelDifficultyNumber',
    'cardCoolTimeMinutes',
    'requiredCardCoolTimeRacePointAmount',
    'initialRacePointAmount',
    'rivals',
    'npcRosterId',
    'activityLesson.maxHours',
    'areaQuestReward.racePointPerTier',
  ]) {
    assert.notEqual(fields.get(path)?.readOnly, true, `${path} should be editable`);
  }
});

testWithMaster('validate requires rank grades to start at 0 and strictly ascend', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  draft.rankGrades[0].hierarchyPointFrom = 5;
  let errors = racePlugin.validate(draft).filter((issue) => issue.severity === 'error');
  assert.deepEqual(errors.map((issue) => issue.path), ['rankGrades.0.hierarchyPointFrom']);
  assert.match(errors[0].message, /first grade must start at 0/);

  const notAscending = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  notAscending.rankGrades[2].hierarchyPointFrom = 50;
  errors = racePlugin.validate(notAscending).filter((issue) => issue.severity === 'error');
  assert.deepEqual(errors.map((issue) => issue.path), ['rankGrades.2.hierarchyPointFrom']);
  assert.match(errors[0].message, /greater than the previous grade \(50\)/);

  const fractional = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  fractional.rankGrades[1].hierarchyPointFrom = 50.5;
  errors = racePlugin.validate(fractional).filter((issue) => issue.severity === 'error');
  assert.deepEqual(errors.map((issue) => issue.path), ['rankGrades.1.hierarchyPointFrom']);
  assert.match(errors[0].message, /whole number/);

  const unnamed = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  unnamed.rankGrades[1].id = '';
  errors = racePlugin.validate(unnamed).filter((issue) => issue.severity === 'error');
  assert.deepEqual(errors.map((issue) => issue.path), ['rankGrades.1.id']);
  assert.match(errors[0].message, /must not be empty/);
});

testWithMaster('validate rejects fractional or negative whole-number tuning fields', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  draft.cardCoolTimeMinutes = -1;
  draft.requiredCardCoolTimeRacePointAmount = 1.5;
  draft.areaQuestReward.racePointPerTier = 1.5;
  draft.areaQuestReward.raceMedalPerTier = -2;
  draft.activityLesson.maxHours = 1.5;
  const errors = racePlugin.validate(draft).filter((issue) => issue.severity === 'error');
  assert.deepEqual(
    errors.map((issue) => issue.path),
    [
      'cardCoolTimeMinutes',
      'requiredCardCoolTimeRacePointAmount',
      'activityLesson.maxHours',
      'areaQuestReward.racePointPerTier',
      'areaQuestReward.raceMedalPerTier',
    ],
  );
  assert.match(errors[0].message, /must not be negative/);
  assert.match(errors[1].message, /must be a whole number/);
  assert.match(errors[3].message, /must be a whole number/);
  assert.match(errors[4].message, /must not be negative/);
});

testWithMaster('rivals must be a whole number between 1 and 10', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  for (const [rivals, message] of [
    [0, /between 1 and 10/],
    [11, /between 1 and 10/],
    [2.5, /whole number/],
  ] as const) {
    draft.rivals = rivals;
    const errors = racePlugin.validate(draft).filter((issue) => issue.severity === 'error');
    assert.deepEqual(errors.map((issue) => issue.path), ['rivals']);
    assert.match(errors[0].message, message);
  }

  draft.rivals = 10;
  assert.deepEqual(
    racePlugin.validate(draft).filter((issue) => issue.severity === 'error'),
    [],
  );
});

testWithMaster('bots: an absent block parses to disabled bots with the defaults', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.equal(draft.bots, undefined);
  const parsed = racePlugin.parseDraft(JSON.parse(JSON.stringify(draft)) as Record<string, unknown>);
  assert.equal(parsed.bots?.enabled, false);
  assert.equal(parsed.bots?.count, 30);
  assert.equal(parsed.bots?.minPanelsPerDay, 20);
  assert.equal(parsed.bots?.maxPanelsPerDay, 120);
  assert.deepEqual(parsed.bots?.names, []);
  assert.deepEqual(
    racePlugin.validate(parsed).filter((issue) => issue.path.startsWith('bots')),
    [],
  );
  // A brand-new draft shows the same block.
  assert.equal(defaultRaceDraft(RACE_ID).bots?.enabled, false);
});

test('bots: authored values round-trip through parseDraft', () => {
  const parsed = racePlugin.parseDraft({
    raceId: RACE_ID,
    bots: {
      enabled: true,
      count: 5,
      minPanelsPerDay: 10,
      maxPanelsPerDay: 40,
      names: ['  Mika  ', 'ルナ', ''],
    },
  });
  assert.deepEqual(parsed.bots, {
    enabled: true,
    count: 5,
    minPanelsPerDay: 10,
    maxPanelsPerDay: 40,
    names: ['Mika', 'ルナ'],
  });
  // An absent or empty name list is kept empty: the bots are then named after idols.
  const blank = racePlugin.parseDraft({ raceId: RACE_ID, bots: { enabled: true, names: [] } });
  assert.deepEqual(blank.bots?.names, []);
});

testWithMaster('bots: out-of-range values are rejected', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  const cases: [Partial<RaceBotConfig>, string[], RegExp][] = [
    [{ count: 501 }, ['bots.count'], /between 0 and 500/],
    [{ count: -1 }, ['bots.count'], /between 0 and 500/],
    [{ count: 2.5 }, ['bots.count'], /whole number/],
    [{ minPanelsPerDay: -1 }, ['bots.minPanelsPerDay'], /not be negative/],
    [{ minPanelsPerDay: 200, maxPanelsPerDay: 100 }, ['bots.maxPanelsPerDay'], /at least the slowest pace/],
    [{ names: ['Mika', '   '] }, ['bots.names.1'], /not be empty/],
    [{ names: ['x'.repeat(21)] }, ['bots.names.0'], /at most 20 characters/],
    [{ names: Array.from({ length: 201 }, (_, index) => `bot-${index}`) }, ['bots.names'], /at most 200 names/],
  ];
  for (const [patch, paths, message] of cases) {
    draft.bots = { ...defaultRaceBotConfig(), enabled: true, ...patch };
    const errors = racePlugin.validate(draft).filter((issue) => issue.severity === 'error');
    assert.deepEqual(errors.map((issue) => issue.path), paths);
    assert.match(errors[0]!.message, message);
  }

  draft.bots = { ...defaultRaceBotConfig(), enabled: true, count: 0 };
  assert.deepEqual(
    racePlugin.validate(draft).filter((issue) => issue.severity === 'error'),
    [],
  );
});

testWithMaster('compile rejects a draft with errors and names the failing paths', () => {
  const draft = deriveRaceDraft('race-22-0428', lookupsFor('race-22-0428'));
  assert.throws(() => racePlugin.compile(draft), /areaIds: race race-22-0428 has no board rows/);
});

testWithMaster('compile returns the runtime config for a valid draft', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  const config = racePlugin.compile(draft);
  assert.equal(config.raceId, RACE_ID);
  assert.equal(config.areaIds.length, 15);
  assert.equal(config.rankGrades.length, 7);
});

testWithMaster('stateImpact is empty until the race has been published', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.deepEqual(racePlugin.stateImpact(undefined, draft), []);
  assert.deepEqual(racePlugin.stateImpact(draft, draft), []);
});

testWithMaster('stateImpact blocks changes that can strand players or regrade them', () => {
  const published = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  const draft = structuredClone(published);
  draft.areaIds = published.areaIds.slice(0, 14);
  draft.areaQuestIds = { ...published.areaQuestIds, pt: 'race-qt-99-9999-pt' };
  draft.livePanelDifficultyNumber = published.livePanelDifficultyNumber + 1;
  draft.raceLiveBonusGroupId = 'race_live_bonus_group-999';
  draft.rankGrades[1].hierarchyPointFrom += 1;

  const impacts = racePlugin.stateImpact(published, draft);
  const blocked = impacts.filter((impact) => impact.severity === 'block');
  assert.deepEqual(
    blocked.map((impact) => impact.code).sort(),
    [
      'area-board-changed',
      'area-quest-changed',
      'live-bonus-group-changed',
      'live-panel-difficulty-changed',
      'rank-grades-changed',
    ],
  );
  for (const impact of blocked) assert.equal(impact.requiresPlayerCheck, true);
});

testWithMaster('stateImpact warns only for pure tuning changes', () => {
  const published = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  const draft = structuredClone(published);
  draft.cardCoolTimeMinutes += 5;
  draft.requiredCardCoolTimeRacePointAmount += 100;
  draft.initialRacePointAmount += 1000;
  draft.rivals = published.rivals - 1;
  draft.activityLesson.racePointPerStepBase += 1;
  draft.areaQuestReward.racePointPerTier += 500;
  draft.panelRewards = { [`${published.areaIds[0]}:3`]: ['rd_auto;item;item-card_enhance;5'] };

  const impacts = racePlugin.stateImpact(published, draft);
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].code, 'race-tuning-changed');
  assert.equal(impacts[0].severity, 'warn');
  assert.equal(impacts[0].requiresPlayerCheck, false);
  assert.match(impacts[0].message, /card cool time/);
  assert.match(impacts[0].message, /activity lesson rates/);
  assert.match(impacts[0].message, /area quest rewards/);
  assert.match(impacts[0].message, /board panel rewards/);
});

testWithMaster('stateImpact warns when grade labels change without thresholds moving', () => {
  const published = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  const draft = structuredClone(published);
  draft.rankGrades[0].name = 'Bronze (renamed)';
  const impacts = racePlugin.stateImpact(published, draft);
  assert.deepEqual(
    impacts.map((impact) => [impact.code, impact.severity]),
    [['rank-grade-labels-changed', 'warn']],
  );
});

testWithMaster('stateImpact only warns when the grade difficulty mapping changes', () => {
  const published = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  const draft = structuredClone(published);
  draft.gradeDifficulty.platinum = 4;
  const impacts = racePlugin.stateImpact(published, draft);
  assert.deepEqual(
    impacts.map((impact) => [impact.code, impact.severity, impact.requiresPlayerCheck]),
    [['grade-difficulty-changed', 'warn', false]],
  );
  assert.match(impacts[0].message, /already opened the race keep their frozen difficulty/);
  assert.match(impacts[0].message, /only new players use the new mapping/);
});

testWithMaster('a derived draft ships the default grade difficulty mapping', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.deepEqual(draft.gradeDifficulty, RACE_DEFAULT_GRADE_DIFFICULTY);
  // A draft without the field is backfilled with the same defaults.
  assert.deepEqual(racePlugin.parseDraft({ raceId: RACE_ID }).gradeDifficulty, RACE_DEFAULT_GRADE_DIFFICULTY);
  assert.deepEqual(
    racePlugin.parseDraft({ raceId: RACE_ID, gradeDifficulty: { big4: 3, challenger: 'x' } }).gradeDifficulty,
    { ...RACE_DEFAULT_GRADE_DIFFICULTY, big4: 3 },
  );
});

testWithMaster('grade difficulty leaves must be whole numbers between 1 and 7', () => {
  const base = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  for (const [key, value, message] of [
    ['platinum', 2.5, /whole number/],
    ['diamond', 0, /between 1 and 7/],
    ['big4', 8, /between 1 and 7/],
    ['challenger', -1, /between 1 and 7/],
  ] as const) {
    const draft = structuredClone(base);
    draft.gradeDifficulty[key] = value;
    const errors = racePlugin.validate(draft).filter((issue) => issue.severity === 'error');
    assert.deepEqual(errors.map((issue) => issue.path), [`gradeDifficulty.${key}`]);
    assert.match(errors[0].message, message);
  }
  assert.deepEqual(
    racePlugin.validate(base).filter((issue) => issue.severity === 'error'),
    [],
  );
});

test('the admin lesson preview mirror matches the server formula', () => {
  const config = defaultRaceDraft(RACE_ID);
  for (const tier of [1, 2, 10, 54, 55]) {
    const rates = raceLessonRates(config.activityLesson, tier);
    const state = emptyRaceState();
    state.lastActivityReceiveMs = 1_700_000_000_000;
    const progress = buildRaceActivityLessonProgress(config, state, { pt: tier, medal: tier });
    assert.equal(
      rates.racePointPerStep,
      Number(progress.StepRewardRacePoint),
      `race points per step at tier ${tier}`,
    );
    assert.equal(
      rates.raceMedalPerStep,
      Number(progress.StepRewardRaceMedal),
      `race medals per step at tier ${tier}`,
    );
    const serverMaxSteps = Math.floor(
      (Number(progress.MaxRewardTime) - Number(progress.LastReceiveTime)) / RACE_STEP_INTERVAL_MS,
    );
    assert.equal(rates.maxSteps, serverMaxSteps, `max steps at tier ${tier}`);
    assert.equal(rates.racePointAtMax, rates.racePointPerStep * serverMaxSteps);
    assert.equal(rates.raceMedalAtMax, rates.raceMedalPerStep * serverMaxSteps);
  }
});

testWithMaster('a derived draft ships the default versus NPC roster', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.equal(draft.npcRosterId, RACE_DEFAULT_NPC_ROSTER_ID);
  assert.deepEqual(draft.npcRosterByQuest, {});
  // Board panel rewards are authored, never imported: master stays the source.
  assert.deepEqual(draft.panelRewards, {});
  // A draft without the field falls back to the same default.
  assert.equal(racePlugin.parseDraft({ raceId: RACE_ID }).npcRosterId, RACE_DEFAULT_NPC_ROSTER_ID);
  assert.deepEqual(racePlugin.parseDraft({ raceId: RACE_ID }).panelRewards, {});
});

testWithMaster('a derived draft ships the default starting race points', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.equal(draft.initialRacePointAmount, RACE_DEFAULT_INITIAL_RACE_POINT_AMOUNT);
  // Older drafts and hand-written configs fall back to the same default.
  assert.equal(
    racePlugin.parseDraft({ raceId: RACE_ID }).initialRacePointAmount,
    RACE_DEFAULT_INITIAL_RACE_POINT_AMOUNT,
  );
  assert.equal(racePlugin.parseDraft({ raceId: RACE_ID, initialRacePointAmount: 750 }).initialRacePointAmount, 750);
});

testWithMaster('a derived draft ships the default activity-lesson rates', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.deepEqual(draft.activityLesson, {
    racePointPerStepBase: 34,
    racePointPerStepPerTier: 4.5,
    raceMedalPerStepBase: 17,
    raceMedalPerStepPerTier: 3.3,
    maxHours: 36,
  });
  // Older drafts lack `racePointPerStepBase` / `raceMedalPerStepBase`; parsing
  // backfills both and keeps the authored per-tier rates (fractional included).
  const legacy = racePlugin.parseDraft({
    raceId: RACE_ID,
    activityLesson: { racePointPerStepPerTier: 2.5, raceMedalPerStepPerTier: 1, maxHours: 6 },
  });
  assert.deepEqual(legacy.activityLesson, {
    racePointPerStepBase: 34,
    racePointPerStepPerTier: 2.5,
    raceMedalPerStepBase: 17,
    raceMedalPerStepPerTier: 1,
    maxHours: 6,
  });
  assert.deepEqual(racePlugin.parseDraft({ raceId: RACE_ID }).activityLesson, {
    racePointPerStepBase: 34,
    racePointPerStepPerTier: 4.5,
    raceMedalPerStepBase: 17,
    raceMedalPerStepPerTier: 3.3,
    maxHours: 36,
  });
});

testWithMaster('validate accepts fractional activity-lesson rates and rejects negative ones', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  assert.equal(draft.activityLesson.racePointPerStepPerTier, 4.5);
  assert.deepEqual(
    racePlugin.validate(draft).filter((issue) => issue.severity === 'error'),
    [],
  );

  draft.activityLesson.racePointPerStepBase = -1;
  draft.activityLesson.racePointPerStepPerTier = -0.5;
  draft.activityLesson.raceMedalPerStepBase = -2;
  draft.activityLesson.raceMedalPerStepPerTier = -0.25;
  const errors = racePlugin.validate(draft).filter((issue) => issue.severity === 'error');
  assert.deepEqual(
    errors.map((issue) => issue.path),
    [
      'activityLesson.racePointPerStepBase',
      'activityLesson.racePointPerStepPerTier',
      'activityLesson.raceMedalPerStepBase',
      'activityLesson.raceMedalPerStepPerTier',
    ],
  );
  for (const issue of errors) assert.match(issue.message, /must not be negative/);
});

testWithMaster('validate checks the starting race points', () => {
  const negative = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  negative.initialRacePointAmount = -1;
  const errors = racePlugin.validate(negative).filter((issue) => issue.severity === 'error');
  assert.deepEqual(errors.map((issue) => issue.path), ['initialRacePointAmount']);
  assert.match(errors[0].message, /must not be negative/);

  // Zero is legal but leaves a new player stuck until the lesson pays out.
  const zero = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  zero.initialRacePointAmount = 0;
  const issues = racePlugin.validate(zero);
  assert.deepEqual(issues.filter((issue) => issue.severity === 'error'), []);
  assert.deepEqual(
    issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.path),
    ['initialRacePointAmount'],
  );
});

testWithMaster('validate rejects an unknown versus NPC roster', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  draft.npcRosterId = 'no-such-roster';
  draft.npcRosterByQuest = { 'race-qt-26-0226-medal': 'also-missing' };
  const errors = racePlugin.validate(draft).filter((issue) => issue.severity === 'error');
  assert.equal(errors.length, 2);
  const paths = errors.map((issue) => issue.path).sort();
  assert.deepEqual(paths, ['npcRosterByQuest.race-qt-26-0226-medal', 'npcRosterId']);
  assert.ok(errors.some((issue) => /names unknown roster "no-such-roster"/.test(issue.message)));
  assert.ok(errors.some((issue) => /names unknown roster "also-missing"/.test(issue.message)));
});

testWithMaster('validate checks board reward overrides against the reward panels', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  const preview = buildRaceBoardPreview(boardSource(RACE_ID));
  const panels = preview.areas.flatMap((area) =>
    area.panels.map((panel) => ({ areaId: area.areaId, panel })),
  );
  const rewardPanel = panels.find((entry) => entry.panel.type === 2);
  const storyPanel = panels.find((entry) => entry.panel.type === 4);
  assert.ok(rewardPanel !== undefined && storyPanel !== undefined);

  setRaceBoardRewardPanelKeys(
    RACE_ID,
    panels
      .filter((entry) => entry.panel.type === 2)
      .map((entry) => `${entry.areaId}:${entry.panel.number}`),
  );
  try {
    // A reward panel of one of the race's areas passes.
    const rewardKey = `${rewardPanel.areaId}:${rewardPanel.panel.number}`;
    draft.panelRewards = { [rewardKey]: ['rd_auto;item;item-card_enhance;5'] };
    assert.deepEqual(
      racePlugin.validate(draft).filter((issue) => issue.severity === 'error'),
      [],
    );

    const storyKey = `${storyPanel.areaId}:${storyPanel.panel.number}`;
    const emptyRefKey = `${draft.areaIds[0]}:3`;
    draft.panelRewards = {
      [storyKey]: ['rd-race-reward-1'],
      'no-panel-number': ['rd-race-reward-1'],
      'race-area-99-99:3': ['rd-race-reward-1'],
      [emptyRefKey]: [''],
    };
    const errors = racePlugin.validate(draft).filter((issue) => issue.severity === 'error');
    assert.deepEqual(
      errors.map((issue) => issue.path).sort(),
      [
        'panelRewards.no-panel-number',
        'panelRewards.race-area-99-99:3',
        `panelRewards.${emptyRefKey}.0`,
        `panelRewards.${storyKey}`,
      ].sort(),
    );
    assert.ok(errors.some((issue) => /not a reward \(type 2\) panel/.test(issue.message)));
    assert.ok(errors.some((issue) => /must be "<areaId>:<panelNumber>"/.test(issue.message)));
    assert.ok(errors.some((issue) => /is not one of race .* board areas/.test(issue.message)));
    assert.ok(
      errors.some((issue) => /must be a reward id or an inline rd_auto reference/.test(issue.message)),
    );
  } finally {
    resetRaceBoardVenusQuestIdsForTests();
  }
});

/** Board rows of `raceId` as the lookup loader hands them to the builder. */
function boardSource(raceId: string): RaceBoardSource {
  const draft = deriveRaceDraft(raceId, lookupsFor(raceId));
  const panels = loadMaster('RacePanel').filter((row) =>
    draft.areaIds.includes(String(row.RaceAreaId ?? '')),
  );
  const rewardIds = new Set(
    panels.map((row) => String(row.RacePanelRewardId ?? '')).filter((id) => id !== ''),
  );
  const venusQuestIds = new Set(
    panels
      .filter((row) => Number(row.Type ?? 0) === 3)
      .map((row) => String(row.RaceQuestId ?? '')),
  );
  const story = loadMaster('EventStory').find((row) => row.AssetId === `event-${raceId}`);
  return {
    raceId,
    areaIds: draft.areaIds,
    panels: panels as unknown as RaceBoardPanelSource[],
    quests: loadMaster('RaceQuest').filter((row) =>
      venusQuestIds.has(String(row.Id ?? '')),
    ) as unknown as RaceBoardQuestSource[],
    difficulties: loadMaster('RaceQuestDifficulty').filter((row) =>
      venusQuestIds.has(String(row.RaceQuestId ?? '')),
    ) as unknown as RaceBoardDifficultySource[],
    panelRewards: loadMaster('RacePanelReward').filter(
      (row) => row.RaceId === raceId && rewardIds.has(String(row.Id ?? '')),
    ) as unknown as RaceBoardPanelRewardSource[],
    eventStoryId: String(story?.Id ?? '') || null,
    difficultyNumber: draft.livePanelDifficultyNumber,
  };
}

testWithMaster('board preview lists the draft areas with their panels in order', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  const source = boardSource(RACE_ID);
  const preview = buildRaceBoardPreview(source);

  assert.equal(preview.raceId, RACE_ID);
  assert.deepEqual(preview.areas.map((area) => area.areaId), draft.areaIds);
  assert.equal(preview.eventStoryId, source.eventStoryId);

  const master = loadMaster('RacePanel');
  for (const [index, area] of preview.areas.entries()) {
    const rows = master
      .filter((row) => row.RaceAreaId === area.areaId)
      .sort((left, right) => Number(left.Number) - Number(right.Number));
    assert.equal(area.index, index);
    assert.equal(area.panelCount, rows.length);
    assert.deepEqual(
      area.panels.map((panel) => panel.number),
      rows.map((row) => Number(row.Number)),
    );
    assert.equal(
      area.totalRacePointCost,
      rows.reduce((sum, row) => sum + Number(row.RequiredRacePointAmount ?? 0), 0),
    );
  }
});

testWithMaster('board preview labels panel types and resolves rewards, story and VENUS data', () => {
  const preview = buildRaceBoardPreview(boardSource(RACE_ID));
  const panels = preview.areas.flatMap((area) => area.panels);
  const rewardPanels = panels.filter((panel) => panel.type === 2);
  const storyPanels = panels.filter((panel) => panel.type === 4);
  const venusPanels = panels.filter((panel) => panel.type === 3);
  const emptyPanels = panels.filter((panel) => panel.type === 1);

  assert.ok(rewardPanels.length > 0 && storyPanels.length > 0 && venusPanels.length > 0);
  assert.ok(emptyPanels.length > 0);
  assert.equal(emptyPanels[0].typeLabel, 'Empty');
  assert.equal(rewardPanels[0].typeLabel, 'Reward');
  assert.equal(venusPanels[0].typeLabel, 'VENUS');
  assert.equal(storyPanels[0].typeLabel, 'Story');

  // Story panels carry the event story id and their episode.
  assert.equal(storyPanels[0].storyEpisode, 1);
  assert.equal(storyPanels[0].storyId, preview.eventStoryId);

  // Reward panels carry their race's `RacePanelReward.RewardId`; the builder
  // never fills the resolved contents (the lookup route does that).
  const rewardRows = loadMaster('RacePanelReward').filter((row) => row.RaceId === RACE_ID);
  for (const panel of rewardPanels.slice(0, 5)) {
    assert.equal(typeof panel.rewardId, 'string');
    const row = rewardRows.find((candidate) => String(candidate.Id ?? '') === panel.rewardId);
    assert.ok(row === undefined || String(row.RewardId ?? '') === panel.rewardId);
    assert.equal(panel.reward, null);
  }
  assert.ok(
    rewardPanels.some((panel) => typeof panel.rewardId === 'string' && panel.rewardId !== ''),
  );

  // VENUS panels resolve the quest and the configured difficulty tier.
  const quests = loadMaster('RaceQuest');
  const difficulties = loadMaster('RaceQuestDifficulty');
  const venus = venusPanels.find((panel) => panel.venus !== null);
  if (venus === undefined || venus.venus === null) {
    assert.fail('expected a VENUS panel with difficulty data');
  }
  const venusData = venus.venus;
  const quest = quests.find((row) => row.Id === venusData.questId);
  assert.equal(venusData.questName, quest?.Name ?? null);
  assert.equal(venusData.difficultyNumber, 1);
  const tier = difficulties.find(
    (row) => row.RaceQuestId === venusData.questId && row.DifficultyNumber === 1,
  );
  assert.equal(venusData.difficultyFound, tier !== undefined);
  assert.equal(venusData.clearScore, tier === undefined ? null : Number(tier.ClearScore));
  assert.equal(
    venusData.difficultyLevel,
    tier === undefined ? null : Number(tier.DifficultyLevel),
  );
});

testWithMaster('validate warns about roster overrides that are not VENUS panel quests', () => {
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  const preview = buildRaceBoardPreview(boardSource(RACE_ID));
  const venusQuestId = preview.areas
    .flatMap((area) => area.panels)
    .find((panel) => panel.venus !== null)?.venus?.questId;
  assert.ok(venusQuestId !== undefined);

  setRaceBoardVenusQuestIds(
    RACE_ID,
    preview.areas.flatMap((area) =>
      area.panels.flatMap((panel) => (panel.venus === null ? [] : [panel.venus.questId])),
    ),
  );
  try {
    draft.npcRosterByQuest = {
      [venusQuestId]: RACE_DEFAULT_NPC_ROSTER_ID,
      [draft.areaQuestIds.medal]: RACE_DEFAULT_NPC_ROSTER_ID,
      'race-qt-26-0226-not-a-panel': RACE_DEFAULT_NPC_ROSTER_ID,
    };
    const issues = racePlugin.validate(draft);
    assert.deepEqual(issues.filter((issue) => issue.severity === 'error'), []);
    const warnings = issues.filter(
      (issue) =>
        issue.severity === 'warning' && issue.path.startsWith('npcRosterByQuest.'),
    );
    assert.deepEqual(
      warnings.map((issue) => issue.path).sort(),
      [`npcRosterByQuest.${draft.areaQuestIds.medal}`, 'npcRosterByQuest.race-qt-26-0226-not-a-panel'].sort(),
    );
    assert.ok(warnings.some((issue) => /not a VENUS \(type 3\) panel quest/.test(issue.message)));
  } finally {
    resetRaceBoardVenusQuestIdsForTests();
  }
});

testWithMaster('validate warns about non-VENUS roster keys when no board was loaded', () => {
  resetRaceBoardVenusQuestIdsForTests();
  const draft = deriveRaceDraft(RACE_ID, lookupsFor(RACE_ID));
  draft.npcRosterByQuest = {
    [draft.areaQuestIds.pt]: RACE_DEFAULT_NPC_ROSTER_ID,
    ['race-qt-99-0000-other']: RACE_DEFAULT_NPC_ROSTER_ID,
  };
  const warnings = racePlugin
    .validate(draft)
    .filter((issue) => issue.severity === 'warning' && issue.path.startsWith('npcRosterByQuest.'));
  assert.deepEqual(
    warnings.map((issue) => issue.path).sort(),
    [`npcRosterByQuest.${draft.areaQuestIds.pt}`, 'npcRosterByQuest.race-qt-99-0000-other'].sort(),
  );
});
