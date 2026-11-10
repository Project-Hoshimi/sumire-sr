// Deterministic tests for the TypeScript port of the Solis live simulator.
//
// Run with `npm run test:live` (plain node, no test framework). Exits non-zero
// on the first failing assertion group.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AllocateAudience,
  ExtraCharacterIDs,
  NPCBalance,
  NPCRoster,
  PhotoTargetIndexes,
  ResolveCharacterAdvantage,
  RULESET_VERSION,
  beatScoreCoefficientPermil,
  newRand,
  simulate,
} from './index.ts';
import type { CardData, Input } from './input.ts';
import { AttributeType, CardType, MusicChartType, SkillCategoryType, SkillEfficacyType, SkillTargetType, SkillTriggerType, StatusEffectType } from './enums.ts';
import type {
  ComboAdvantage,
  LiveDeckCard,
  LiveResult,
  MusicChartPattern,
  Quest,
  QuestAudienceAdvantage,
  QuestPressure,
  QuestStaminaConsumption,
  Setting,
  Skill,
  SkillEfficacy,
  SkillTarget,
  SkillTrigger,
} from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const masterDir = join(here, '..', '..', '..', 'phaseA2', 'out', 'structured');

let failed = 0;
let passed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack ?? error.message : error);
  }
}

function readMaster<T>(name: string): T[] {
  return JSON.parse(readFileSync(join(masterDir, `${name}.json`), 'utf8')) as T[];
}

// --- RNG -------------------------------------------------------------------

test('pcg: identical seeds produce identical streams', () => {
  const left = newRand(12345n);
  const right = newRand(12345n);
  for (let i = 0; i < 16; i++) assert.equal(left.uint64(), right.uint64());
  const a = newRand(7n);
  const b = newRand(7n);
  for (let i = 0; i < 16; i++) assert.equal(a.float64(), b.float64());
});

test('pcg: different seeds diverge', () => {
  const a = newRand(1n);
  const b = newRand(2n);
  let same = 0;
  for (let i = 0; i < 8; i++) if (a.uint64() === b.uint64()) same++;
  assert.ok(same < 8);
});

test('pcg: float64 is in [0,1) and roughly uniform', () => {
  const r = newRand(99n);
  let sum = 0;
  const seen = new Set<number>();
  for (let i = 0; i < 5000; i++) {
    const v = r.float64();
    assert.ok(v >= 0 && v < 1, `float64 out of range: ${v}`);
    sum += v;
    seen.add(v);
  }
  const mean = sum / 5000;
  assert.ok(mean > 0.45 && mean < 0.55, `mean ${mean}`);
  assert.ok(seen.size > 4900, `distinct ${seen.size}`);
});

test('pcg: intN stays in range and handles edge sizes', () => {
  const r = newRand(2024n);
  const counts = new Map<number, number>();
  for (let i = 0; i < 4000; i++) {
    const v = r.intN(7);
    assert.ok(v >= 0 && v < 7, `intN(7)=${v}`);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  assert.equal(counts.size, 7);
  for (const [, c] of counts) assert.ok(c > 300, `bucket ${c}`);
  assert.equal(newRand(5n).intN(1), 0);
  assert.equal(newRand(5n).intN(2) & ~1, 0);
});

// --- fixture inputs ---------------------------------------------------------

const fighterSetting: Setting = {
  CardDefaultMental: 100,
  CardDefaultTechnique: 100,
  LiveLightFanAmountWeightPermil: 1000,
  LiveMiddleFanAmountWeightPermil: 1000,
  LiveHeavyFanAmountWeightPermil: 1000,
  LiveMinimumGuaranteedAudienceAmount: 0,
  LiveMaxParameterBonusPermil: 1000000,
  StatusEffectTypeStrengthList: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 1006],
  StatusEffectTypeWeaknessDownList: [1001, 1002, 1003],
  StatusEffectTypeWeaknessOtherList: [1004, 1005, 1007, 1008, 1009, 1010, 1011, 1012],
};

const difficultyHigh: Quest = {
  Id: 'qt-test-001',
  MusicId: 'music-test-001',
  MusicChartPatternId: 'chart-test-001',
  DifficultyLevel: 40,
  MaxCapacity: 500,
  MentalThreshold: 3000,
  MoodType: 0,
  ClearScore: 10000,
  Position1AttributeType: AttributeType.Vocal,
  Position2AttributeType: AttributeType.Dance,
  Position3AttributeType: AttributeType.Visual,
  Position4AttributeType: AttributeType.Vocal,
  Position5AttributeType: AttributeType.Dance,
  ActiveSkillWeightPermil: 300,
  SpecialSkillWeightPermil: 300,
  SkillStaminaWeightPermil: 300,
  StaminaRecoveryWeightPermil: 1000,
  BeatDanceWeightPermil: 300,
  BeatVocalWeightPermil: 300,
  BeatVisualWeightPermil: 400,
  QuestPressureId: 'quest_pressure-0',
  QuestAudienceAdvantageId: 'quest_audience_advantage_1',
  QuestCharacterAdvantageId: '',
};

const pressure: QuestPressure = { Id: 'quest_pressure-0', Name: '小', WeightPermil: 1 };
const audienceRows: QuestAudienceAdvantage[] = [
  { Id: 'quest_audience_advantage_1', AudienceAmount: 10, AdvantagePermil: 1001 },
];
const comboRows: ComboAdvantage[] = [{ Id: 'combo_advantage_1', ComboCount: 10, AdvantagePermil: 1050 }];
const staminaRows: QuestStaminaConsumption[] = [
  { RemainStaminaRatioPercent: 5, SkillTargetParameterWeightPermil: 300 },
];

function testChart(): MusicChartPattern[] {
  const rows: MusicChartPattern[] = [];
  for (let n = 1; n <= 20; n++) {
    if (n === 5) {
      rows.push({ Id: 'chart-test-001', Number: 5, Type: MusicChartType.ActiveSkill, Position: 1 });
      continue;
    }
    rows.push({ Id: 'chart-test-001', Number: n, Type: MusicChartType.Beat });
  }
  rows.sort((left, right) => (left.Number ?? 0) - (right.Number ?? 0));
  return rows;
}

function testSkillMasters(): { skills: Map<string, Skill>; efficacies: Map<string, SkillEfficacy>; targets: Map<string, SkillTarget>; triggers: Map<string, SkillTrigger> } {
  const triggers = new Map<string, SkillTrigger>();
  const skills = new Map<string, Skill>();
  skills.set('sk-test-active', {
    Id: 'sk-test-active',
    Name: 'テストAスキル',
    CategoryType: SkillCategoryType.Active,
    Levels: [
      {
        Level: 1,
        Stamina: 0,
        StaminaPermil: 0,
        CoolTime: 0,
        LimitCount: 1,
        ProbabilityPermil: 1000,
        TriggerId: '',
        SkillDetails: [{ EfficacyId: 'ef-score_get-100-chart_dependence' }],
      },
    ],
  });
  skills.set('sk-test-passive', {
    Id: 'sk-test-passive',
    Name: 'テストPスキル',
    CategoryType: SkillCategoryType.Passive,
    Levels: [
      {
        Level: 1,
        Stamina: 0,
        StaminaPermil: 0,
        CoolTime: 0,
        LimitCount: 1,
        ProbabilityPermil: 1000,
        TriggerId: 'tg-live_start-1',
        SkillDetails: [{ EfficacyId: 'ef-score_up-target-self-5' }],
      },
    ],
  });
  const efficacies = new Map<string, SkillEfficacy>();
  efficacies.set('ef-score_get-100-chart_dependence', {
    Id: 'ef-score_get-100-chart_dependence',
    Name: 'スコア獲得',
    Type: SkillEfficacyType.ScoreGet,
    Grade: 0,
    MaxGrade: 0,
    SkillTargetId: 'target-self',
  });
  efficacies.set('ef-score_up-target-self-5', {
    Id: 'ef-score_up-target-self-5',
    Name: 'スコアアップ',
    Type: SkillEfficacyType.ScoreUp,
    Grade: 1,
    MaxGrade: 3,
    SkillTargetId: 'target-self',
  });
  const targets = new Map<string, SkillTarget>();
  targets.set('target-self', { Id: 'target-self', Type: SkillTargetType.Self });
  triggers.set('tg-live_start-1', { Id: 'tg-live_start-1', Type: SkillTriggerType.LiveStart });
  return { skills, efficacies, targets, triggers };
}

function testUser(side: number, audience: number): Input['Users'][number] {
  const cards: LiveDeckCard[] = [];
  for (let lane = 1; lane <= 5; lane++) {
    const index = side * 5 + lane;
    cards.push({
      Index: index,
      CardId: `card-test-${index}`,
      Stamina: 1000,
      Mental: 100,
      Technique: 100,
      Vocal: 10000,
      Dance: 9000,
      Visual: 8000,
      AudienceAmount: audience,
      EvolutionLevel: 0,
      Skills: index === 1
        ? [
            { Index: 1, SkillId: 'sk-test-active', SkillLevel: 1, PossessionType: 1 },
            { Index: 2, SkillId: 'sk-test-passive', SkillLevel: 1, PossessionType: 1 },
          ]
        : [],
    });
  }
  return {
    Index: side + 1,
    UserId: `user-test-${side + 1}`,
    Name: `テスト${side + 1}`,
    IsNpc: false,
    UserDeck: { DeckName: 'test', Cards: cards, BonusSkills: [] },
  };
}

function cardData(index: number): CardData {
  return {
    Bonuses: new Map(),
    StrengthModifiers: [],
    CharacterID: `chr-test-${index}`,
    GroupID: 'grp-test',
    Type: CardType.Appeal,
    Attribute: AttributeType.Vocal,
    LightFans: 1000,
    MiddleFans: 500,
    HeavyFans: 100,
    CharacterAdvantagePermil: 1000,
  };
}

function handFixture(seed: bigint): Input {
  const cards = new Map<number, CardData>();
  for (let index = 1; index <= 5; index++) cards.set(index, cardData(index));
  const masters = testSkillMasters();
  return {
    Quest: difficultyHigh,
    Setting: fighterSetting,
    Chart: testChart(),
    Pressure: pressure,
    AudienceAdvantages: audienceRows,
    ComboAdvantages: comboRows,
    StaminaConsumption: staminaRows,
    Users: [testUser(0, 100)],
    Cards: cards,
    Skills: masters.skills,
    Efficacies: masters.efficacies,
    Triggers: masters.triggers,
    Targets: masters.targets,
    Seed: seed,
  };
}

// --- simulation invariants --------------------------------------------------

function checkInvariants(result: LiveResult, input: Input): void {
  const expectedCharts = input.Chart.filter((row) => (row.Type ?? 0) !== MusicChartType.Unknown).length;
  assert.equal(result.Charts?.length ?? 0, expectedCharts, 'chart count');
  const chartByNumber = new Map<number, MusicChartPattern>();
  for (const row of input.Chart) chartByNumber.set(row.Number ?? 0, row);
  const playable = (result.Charts ?? []).length;
  assert.ok(playable > 0, 'no charts');
  assert.equal(result.UserInfos?.length, input.Users.length);
  assert.equal(result.UserInfos?.[0]?.Index, 1);
  const cardCount = (result.UserInfos?.[0]?.UserDeck?.Cards?.length ?? 0);
  assert.equal(cardCount, 5);

  let lastOrder = -1;
  let beatRows = 0;
  for (const chart of result.Charts ?? []) {
    const source = chartByNumber.get(chart.Number ?? 0);
    if ((source?.Type ?? 0) === MusicChartType.Beat) {
      const beats = chart.Beats ?? [];
      assert.equal(beats.length, input.Users.length * 5, 'beats per chart = 5 per unit');
      beatRows += beats.length;
      for (const beat of beats) {
        assert.ok((beat.Order ?? 0) > lastOrder, 'beat order increases');
        lastOrder = beat.Order ?? 0;
        assert.ok((beat.Score ?? 0) >= 0, 'negative beat score');
      }
    } else {
      assert.equal(chart.AttributeType, input.Quest[`Position${source?.Position ?? 0}AttributeType` as keyof Quest] ?? 0);
    }
  }
  assert.ok(beatRows > 0);

  for (const user of result.UserInfos ?? []) {
    const result_ = user.UserResult ?? {};
    const cards = user.UserDeck?.Cards ?? [];
    const cardTotal = (result_.CardResults ?? []).reduce((sum, row) => sum + (row.TotalScore ?? 0), 0);
    assert.equal(result_.Score, cardTotal, 'user score = sum of card scores');
    assert.equal((result_.CardResults ?? []).length, 5);
    for (const card of cards) {
      assert.ok((card.Stamina ?? 0) >= 0, 'negative stamina');
      assert.ok((card.Stamina ?? 0) <= (card.StartStamina ?? 0), 'stamina above start');
    }
  }

  const audience = (result.UserInfos ?? []).reduce(
    (sum, user) => sum + (user.UserDeck?.Cards ?? []).reduce((inner, card) => inner + (card.AudienceAmount ?? 0), 0),
    0,
  );
  assert.equal(result.TotalAudienceAmount, audience, 'total audience');
  assert.ok(audience <= (input.Quest.MaxCapacity ?? 0), 'audience exceeds capacity');

  if (input.Users.length === 1) {
    const score = result.UserInfos?.[0]?.UserResult?.Score ?? 0;
    assert.equal(result.Cleared, score >= (input.Quest.ClearScore ?? 0), 'cleared flag');
  }
  assert.equal(result.IsDisplayDetailAvailable, true);
}

test('simulate: same seed produces an identical result', () => {
  const left = simulate(handFixture(123456789n));
  const right = simulate(handFixture(123456789n));
  assert.deepEqual(left, right);
});

test('simulate: different seeds produce different results', () => {
  const left = JSON.stringify(simulate(handFixture(1n)));
  const right = JSON.stringify(simulate(handFixture(2n)));
  assert.notEqual(left, right);
});

test('simulate: hand fixture satisfies structural invariants', () => {
  const input = handFixture(42n);
  const result = simulate(input);
  checkInvariants(result, input);
  assert.equal(RULESET_VERSION, 'live-v5');
});

test('simulate: skills record activations and never consume RNG when logged', () => {
  const input = handFixture(7n);
  const result = simulate(input);
  const skillCharts = (result.Charts ?? []).filter((chart) => chart.ActivatedSkill !== undefined && chart.ActivatedSkill !== null);
  assert.equal(skillCharts.length, 1, 'one active skill chart');
  const activation = skillCharts[0].ActivatedSkill!;
  assert.ok(activation.SkillIndex !== undefined);
  if (activation.Activated === true) {
    assert.ok((activation.Descriptions?.length ?? 0) > 0, 'activated skill has descriptions');
  } else {
    assert.ok((activation.Failures?.length ?? 0) > 0, 'failed skill has failures');
  }
  const passives = (result.ActivatedPassiveSkills ?? []).length;
  assert.ok(passives >= 0);
});

test('simulate: rejects inputs missing numeric tables', () => {
  const input = handFixture(1n);
  input.AudienceAdvantages = [];
  assert.throws(() => simulate(input), /numeric tables/);
});

// --- preparation ------------------------------------------------------------

test('npc balance: anchor and floor follow the authored curve', () => {
  const atAnchor: Quest = { ...difficultyHigh, DifficultyLevel: 320, MentalThreshold: 3000 };
  const anchor = NPCBalance(atAnchor, fighterSetting);
  assert.equal(anchor.Primary, 350 + 310000);
  assert.equal(anchor.Stamina, 10000);
  assert.equal(anchor.Mental, 30 + 7700 + 100);
  assert.equal(anchor.Technique, 30 + 8700 + 100);
  assert.equal(anchor.Version, 'npc-balance-v1');
  const atStart = NPCBalance({ ...difficultyHigh, DifficultyLevel: 33 }, fighterSetting);
  assert.equal(atStart.Primary, 350);
  const floor = NPCBalance({ ...difficultyHigh, DifficultyLevel: 33, MentalThreshold: 10000 }, fighterSetting);
  assert.ok(floor.Mental >= Math.ceil((10000 * 900) / 1000));
  const higher = NPCBalance({ ...difficultyHigh, DifficultyLevel: 400 }, fighterSetting);
  assert.ok(higher.Primary > anchor.Primary);
});

test('npc roster: five unique lanes and fresh objects', () => {
  const roster = NPCRoster('qt-main-1-007-04');
  assert.equal(roster.CardInfos?.length, 5);
  const positions = new Set((roster.CardInfos ?? []).map((card) => card.Position));
  assert.equal(positions.size, 5);
  assert.ok((roster.Name ?? '') !== '');
  assert.notEqual(NPCRoster('qt-main-1-007-04'), roster);
  assert.throws(() => NPCRoster('qt-does-not-exist'));
});

test('audience: proportional seats respect capacity and minimum', () => {
  const cards = [cardData(1), cardData(2), cardData(3), cardData(4), cardData(5)];
  const seats = AllocateAudience(cards, 1000, fighterSetting);
  assert.equal(seats.length, 5);
  assert.equal(seats.reduce((a, b) => a + b, 0), 1000);
  const small = AllocateAudience(cards, 4, { ...fighterSetting, LiveMinimumGuaranteedAudienceAmount: 3 });
  assert.equal(small.reduce((a, b) => a + b, 0), 4);
  for (const seat of small) assert.ok(seat >= 0);
  const empty = AllocateAudience(cards.map((c) => ({ ...c, LightFans: 0, MiddleFans: 0, HeavyFans: 0 })), 100, fighterSetting);
  assert.deepEqual(empty, [0, 0, 0, 0, 0]);
});

test('character advantage and photo targets resolve as documented', () => {
  const data = cardData(1);
  assert.equal(ResolveCharacterAdvantage(data, null), 1000);
  assert.equal(
    ResolveCharacterAdvantage(data, { Id: 'adv', CharacterIds: [data.CharacterID], AdvantagePermil: 1200 }),
    1200,
  );
  assert.equal(
    ResolveCharacterAdvantage(data, { Id: 'adv', CharacterGroupId: 'grp-other', AdvantagePermil: 1200 }),
    1000,
  );
  const cards = [1, 2, 3, 4, 5].map((index) => ({ Index: index }));
  const map = new Map<number, CardData>();
  for (const index of [1, 2, 3, 4, 5]) map.set(index, cardData(index));
  assert.deepEqual(PhotoTargetIndexes(cards, map, 3, { Id: 't', Type: 1 }), [3]);
  assert.equal(PhotoTargetIndexes(cards, map, 3, { Id: 't', Type: 2 }).length, 5);
  assert.deepEqual(PhotoTargetIndexes(cards, map, 3, { Id: 't', Type: 4 }), [1, 5]);
  assert.deepEqual(PhotoTargetIndexes(cards, map, 3, { Id: 't', Type: 3 }), [1]);
  assert.deepEqual(PhotoTargetIndexes(cards, map, 3, null), [3]);
  assert.deepEqual(ExtraCharacterIDs(5, ['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'd', 'e']), ['f']);
  assert.deepEqual(ExtraCharacterIDs(5, ['a'], ['a', 'b', 'c', 'd', 'e']), []);
  assert.throws(() => ExtraCharacterIDs(7, ['a'], ['a', 'b', 'c', 'd', 'e']));
});

test('beat coefficient: rounding and capture override', () => {
  const beats = (count: number): MusicChartPattern[] => {
    const rows: MusicChartPattern[] = [];
    for (let n = 1; n <= count; n++) rows.push({ Id: 'c', Number: n, Type: MusicChartType.Beat });
    return rows;
  };
  assert.equal(beatScoreCoefficientPermil('music-hsm-001', beats(99), beats(99)), 57);
  assert.equal(beatScoreCoefficientPermil('music-other', beats(99), beats(99)), 80);
  assert.equal(beatScoreCoefficientPermil('music-other', [], []), 0);
  assert.equal(beatScoreCoefficientPermil('music-other', [{ Id: 'c', Number: 1, Type: MusicChartType.ActiveSkill }], beats(49)), 160);
});

// --- real master data -------------------------------------------------------

function realFixture(seed: bigint): { input: Input; questID: string } | null {
  let quests: Quest[];
  try {
    quests = readMaster<Quest>('Quest');
  } catch {
    return null;
  }
  const quest = quests
    .filter((row) => (row.AreaId ?? '').startsWith('area-main') && (row.MusicChartPatternId ?? '') !== '')
    .sort((left, right) => (left.Order ?? 0) - (right.Order ?? 0))[0];
  if (quest === undefined) return null;
  const charts = readMaster<MusicChartPattern>('MusicChartPattern').filter((row) => row.Id === quest.MusicChartPatternId);
  if (charts.length === 0) return null;
  const settings = readMaster<Setting>('Setting');
  const setting = settings[0];
  const pressures = readMaster<QuestPressure>('QuestPressure');
  const audience = readMaster<QuestAudienceAdvantage>('QuestAudienceAdvantage').sort(
    (left, right) => (left.AudienceAmount ?? 0) - (right.AudienceAmount ?? 0),
  );
  const combos = readMaster<ComboAdvantage>('ComboAdvantage').sort(
    (left, right) => (left.ComboCount ?? 0) - (right.ComboCount ?? 0),
  );
  const stamina = readMaster<QuestStaminaConsumption>('QuestStaminaConsumption').sort(
    (left, right) => (left.RemainStaminaRatioPercent ?? 0) - (right.RemainStaminaRatioPercent ?? 0),
  );
  const cards = [1, 2, 3, 4, 5].map((index) => cardData(index));
  const house = AllocateAudience(cards, quest.MaxCapacity ?? 0, setting);
  const users: Input['Users'] = [
    {
      Index: 1,
      UserId: 'user-real',
      Name: 'テスト',
      IsNpc: false,
      UserDeck: {
        DeckName: 'real',
        BonusSkills: [],
        Cards: house.map((amount, lane) => ({
          Index: lane + 1,
          CardId: `card-test-${lane + 1}`,
          Stamina: 1000,
          Mental: 100,
          Technique: 100,
          Vocal: 10000,
          Dance: 9000,
          Visual: 8000,
          AudienceAmount: amount,
          Skills: [],
        })),
      },
    },
  ];
  const cardMap = new Map<number, CardData>();
  cards.forEach((data, lane) => cardMap.set(lane + 1, data));
  const input: Input = {
    Quest: quest,
    Setting: setting,
    Chart: charts,
    Pressure: pressures[0],
    AudienceAdvantages: audience,
    ComboAdvantages: combos,
    StaminaConsumption: stamina,
    Users: users,
    Cards: cardMap,
    Skills: new Map(),
    Efficacies: new Map(),
    Triggers: new Map(),
    Targets: new Map(),
    Seed: seed,
  };
  return { input, questID: quest.Id ?? '' };
}

test('simulate: real main quest chart matches its pattern', () => {
  const fixture = realFixture(20240101n);
  if (fixture === null) {
    console.log('     (skipped: phaseA2/out/structured master JSON not available)');
    return;
  }
  const result = simulate(fixture.input);
  checkInvariants(result, fixture.input);
  const beats = fixture.input.Chart.filter((row) => row.Type === MusicChartType.Beat).length;
  const chartBeats = (result.Charts ?? []).filter((chart) => chart.ChartType === MusicChartType.Beat).length;
  assert.equal(chartBeats, beats, `chart ${fixture.questID} beat rule count`);
  const firstNumber = Math.min(...fixture.input.Chart.filter((row) => (row.Type ?? 0) !== MusicChartType.Unknown).map((row) => row.Number ?? 0));
  assert.equal(result.Charts?.[0]?.Number, firstNumber);
});

test('simulate: real quest is deterministic across runs', () => {
  const left = realFixture(31337n);
  const right = realFixture(31337n);
  if (left === null || right === null) return;
  assert.deepEqual(simulate(left.input), simulate(right.input));
});

// --- summary ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
