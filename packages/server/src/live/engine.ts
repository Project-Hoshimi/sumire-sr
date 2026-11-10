// Ported from Solis internal/makino/live/engine.go.
//
// The simulation owns every piece of mutable state and its RNG. Each chart row
// is one event: beats score all five lanes, skill rows resolve the active or
// special chance for the lane, then cooldowns and statuses tick.

import {
  AttributeType,
  MoodType,
  MusicChartType,
  PhotoAbilityType,
  SkillCategoryType,
} from './enums.ts';
import { compileSkill, unsupported } from './compile.ts';
import type { SkillState } from './compile.ts';
import type { CardData, Input } from './input.ts';
import type { StatusInstance, StatusTotals } from './status.ts';
import type { StatusMigration } from './migration.ts';
import type {
  ComboAdvantage,
  LiveCardStatus,
  LiveCardStatusEffect,
  LiveDeckCard,
  LiveDeckCardSkill,
  LiveResult,
  LiveSkill,
  LiveSkillFailure,
  LiveStatusEffectReason,
  LiveUserInfo,
  LiveUserStatus,
  MusicChartPattern,
  QuestAudienceAdvantage,
  QuestStaminaConsumption,
} from './types.ts';
import { actorBefore } from './selectors.ts';
import { newRand } from './pcg.ts';
import type { Rand } from './pcg.ts';
import { n } from './util.ts';
import { beatScoreCoefficientPermil } from './beatCoefficient.ts';
import { descriptionMethods } from './descriptions.ts';
import { effectsMethods } from './effects.ts';
import { migrationMethods } from './migration.ts';
import { scoringMethods } from './scoring.ts';
import { selectorMethods } from './selectors.ts';
import { skillMethods } from './skills.ts';
import { statusMethods } from './status.ts';

export const maxChartEvents = 10000;
export const maxActorSkills = 64;
export const maxStatusInstances = 1024;

export interface Actor {
  index: number;
  position: number;
  side: number;
  card: LiveDeckCard;
  data: CardData;
  synthetic: boolean;
  stamina: number;
  score: number;
  consumed: number;
  activations: number;
  skills: SkillState[];
  effects: StatusInstance[];
  migrations: StatusMigration[];
  revision: number;
  cachedRevision: number;
  cached: LiveCardStatus | null;
  summary: Map<number, StatusTotals> | null;
  summaryRevision: number;
  effectRows: Map<number, LiveCardStatusEffect> | null;
  effectSnapshot: LiveCardStatusEffect[];
}

export interface SideState {
  info: LiveUserInfo;
  combo: number;
}

export interface ActiveCandidate {
  actor: Actor;
  skill: SkillState;
  authority: number;
}

export interface EventState {
  chart: MusicChartPattern | null;
  ordinal: number;
  winner: Actor | null;
  winningSkill: SkillState | null;
  critical: Map<number, boolean>;
  criticalRolls: Map<number, boolean>;
  candidates: ActiveCandidate[];
  recovered: Set<number>;
  activated: Map<number, number>;
  triggerActor: Actor | null;
  triggerActors: Actor[];
  activeResolved: boolean;
  budget: Set<number>;
}

export class Simulation {
  input: Input;
  result: LiveResult;
  rng: Rand;
  actors: Actor[] = [];
  passiveActors: Actor[] = [];
  byIndex = new Map<number, Actor>();
  sides: SideState[] = [];
  event: EventState;
  order = 0;
  occupancy = 0;
  beatPermil = 0;
  comboRows: ComboAdvantage[] = [];
  audienceRows: QuestAudienceAdvantage[] = [];
  staminaRows: QuestStaminaConsumption[] = [];
  err: Error | null = null;
  strengthTypes = new Set<number>();
  weaknessTypes = new Set<number>();
  reasons: Map<string, LiveStatusEffectReason> | null = null;
  readonly maxStatusInstances = maxStatusInstances;

  constructor(input: Input) {
    this.input = input;
    this.result = {};
    this.rng = newRand(input.Seed);
    this.event = emptyEvent();
  }
}

// Methods live in their own mixin modules and are attached below; this merge
// declares their signatures for callers inside the class and the mixins.
export interface Simulation {
  // status.ts
  rawGrade(a: Actor, status: number): StatusTotals;
  grade(a: Actor, status: number): number;
  effectValue(a: Actor, status: number): number;
  attribute(a: Actor, typ: number): number;
  statusSnapshots(a: Actor): LiveCardStatusEffect[];
  addStatus(target: Actor, source: Actor, skill: SkillState, spec: import('./compile.ts').EffectSpec): void;
  changeStamina(a: Actor, delta: number): number;
  tick(): void;
  // scoring.ts
  beatScore(a: Actor, critical: boolean): number;
  skillScore(a: Actor, s: SkillState, eff: import('./compile.ts').EffectSpec, critical: boolean): number;
  skillPower(a: Actor, s: SkillState, eff: import('./compile.ts').EffectSpec): number;
  successRate(a: Actor): number;
  criticalRate(a: Actor): number;
  criticalFactor(a: Actor, critical: boolean): number;
  jitter(): number;
  comboFactor(a: Actor): number;
  fanFactor(a: Actor): number;
  staminaCost(a: Actor, s: SkillState): number;
  authority(a: Actor, attribute: number): number;
  // selectors.ts
  coreFanRatio(a: Actor): number;
  hasWeakness(a: Actor): boolean;
  isWeakness(status: number): boolean;
  isStrength(status: number): boolean;
  matches(t: import('./compile.ts').TriggerSpec, source: Actor): import('./selectors.ts').MatchResult;
  matchTrigger(t: import('./compile.ts').TriggerSpec, source: Actor): { matched: boolean; actors: Actor[] };
  targets(t: import('./compile.ts').TargetSpec, source: Actor): Actor[];
  // skills.ts
  skillFailure(a: Actor, s: SkillState): number;
  candidate(a: Actor, category: number): { skill: SkillState | null; failure: LiveSkillFailure | null };
  selectActive(): LiveSkillFailure[];
  breakCombo(side: number): void;
  activeSkill(failures: LiveSkillFailure[]): LiveSkill;
  activate(a: Actor, s: SkillState, active: boolean, critical: boolean): LiveSkill;
  passives(phase: string): LiveSkill[];
  // effects.ts
  executeEffects(source: Actor, skill: SkillState, critical: boolean): { details: LiveSkill['Details']; total: number; matched: boolean };
  redirectWeakness(source: Actor, target: Actor | null, eff: import('./compile.ts').EffectSpec): Actor | null;
  recoveryWeight(): number;
  transferStatuses(source: Actor, targets: Actor[], skill: SkillState, spec: import('./compile.ts').EffectSpec): void;
  // migration.ts
  applyMigration(source: Actor, target: Actor, skill: SkillState, spec: import('./compile.ts').EffectSpec): number;
  restoreMigratedStatuses(a: Actor, category: number): void;
  migrationPreview(a: Actor, category: number): Actor;
  // descriptions.ts
  skillLabel(a: Actor, s: SkillState): string;
  failureDescriptions(rows: LiveSkillFailure[]): import('./types.ts').LiveLogDescription[];
  skillDescriptions(a: Actor, s: SkillState, result: LiveSkill): import('./types.ts').LiveLogDescription[];
}

Object.assign(
  Simulation.prototype,
  statusMethods(),
  scoringMethods(),
  selectorMethods(),
  skillMethods(),
  effectsMethods(),
  migrationMethods(),
  descriptionMethods(),
);

function emptyEvent(): EventState {
  return {
    chart: null,
    ordinal: 0,
    winner: null,
    winningSkill: null,
    critical: new Map(),
    criticalRolls: new Map(),
    candidates: [],
    recovered: new Set(),
    activated: new Map(),
    triggerActor: null,
    triggerActors: [],
    activeResolved: false,
    budget: new Set(),
  };
}

export function emptyCardData(): CardData {
  return {
    Bonuses: new Map(),
    StrengthModifiers: [],
    CharacterID: '',
    GroupID: '',
    Type: 0,
    Attribute: AttributeType.Unknown,
    LightFans: 0,
    MiddleFans: 0,
    HeavyFans: 0,
    CharacterAdvantagePermil: 0,
  };
}

/**
 * Performs no database or filesystem operations. Each invocation owns its RNG
 * and mutable state; a retry with the same input and seed is reproducible.
 */
export function simulate(input: Input): LiveResult {
  const e = newSimulation(input);
  e.event = emptyEvent();
  e.result.ActivatedPassiveSkills = e.passives('start');
  e.result.PreChart = { CardStatuses: e.cardSnapshots(), UserStatuses: e.userSnapshots() };
  const chart = input.Chart.slice();
  e.result.Charts = [];
  // Stable: equal numbers are rejected below, so ties only pick the message.
  chart.sort((left, right) => n(left.Number) - n(right.Number));
  let previous = -1;
  for (const step of chart) {
    if (n(step.Type) === MusicChartType.Unknown) continue;
    if (n(step.Number) <= previous) throw new Error('live chart numbers must be unique and increasing');
    previous = n(step.Number);
    e.event.chart = step;
    e.event.ordinal++;
    e.event.winner = null;
    e.event.winningSkill = null;
    e.event.triggerActor = null;
    e.event.triggerActors = [];
    e.event.candidates = [];
    e.event.activeResolved = false;
    e.event.critical.clear();
    e.event.criticalRolls.clear();
    e.event.recovered.clear();
    e.event.activated.clear();
    e.event.budget.clear();
    const row: import('./types.ts').LiveChart = { Number: n(step.Number), ChartType: n(step.Type) };
    let failures: LiveSkillFailure[] = [];
    if (n(step.Type) !== MusicChartType.Beat) {
      row.AttributeType = e.laneAttribute(n(step.Position));
      failures = e.selectActive();
    }
    // Critical-trigger passives observe the same preselected roll that the
    // ensuing beat/skill uses; logging never consumes random numbers.
    if (n(step.Type) === MusicChartType.Beat) {
      for (const a of e.actors) {
        if (!a.synthetic) e.event.critical.set(a.index, e.rng.float64() < e.criticalRate(a));
      }
    } else {
      for (const candidate of e.event.candidates) {
        const a = candidate.actor;
        const roll = e.rng.float64() < e.criticalRate(a);
        e.event.criticalRolls.set(a.index, roll);
        const winner = e.event.winner as Actor | null;
        if (winner !== null && winner.index === a.index) e.event.critical.set(a.index, roll);
      }
    }
    row.ActivatedPassiveSkills = (row.ActivatedPassiveSkills ?? []).concat(e.passives('early'));
    if (n(step.Type) === MusicChartType.Beat) {
      for (const a of e.actors) {
        if (a.synthetic) continue;
        const critical = e.event.critical.get(a.index) === true;
        const score = e.beatScore(a, critical);
        e.addScore(a, score);
        if (critical) e.sides[a.side].info.UserResult!.CriticalCount = n(e.sides[a.side].info.UserResult!.CriticalCount) + 1;
        row.Beats = (row.Beats ?? []).concat([{ Order: e.nextOrder(), CardIndex: a.index, Score: score, IsCritical: critical }]);
      }
      for (const s of e.sides) e.incrementCombo(s);
    } else {
      row.ActivatedSkill = e.activeSkill(failures);
    }
    e.event.activeResolved = true;
    e.tick();
    row.ActivatedPassiveSkills = (row.ActivatedPassiveSkills ?? []).concat(e.passives('late'));
    if (e.err !== null) throw e.err;
    row.CardStatuses = e.cardSnapshots();
    row.UserStatuses = e.userSnapshots();
    e.result.Charts!.push(row);
  }
  if ((e.result.Charts?.length ?? 0) === 0) throw new Error('live has no playable chart events');
  for (const a of e.actors) {
    if (!a.synthetic) {
      const result = e.sides[a.side].info.UserResult!;
      result.CardResults = (result.CardResults ?? []).concat([{ CardId: a.card.CardId, TotalScore: a.score }]);
    }
  }
  if (e.sides.length === 2) {
    e.result.Cleared = n(e.sides[0].info.UserResult!.Score) > n(e.sides[1].info.UserResult!.Score);
  } else {
    e.result.Cleared = n(e.sides[0].info.UserResult!.Score) >= n(input.Quest.ClearScore);
  }
  e.result.IsDisplayDetailAvailable = true;
  return e.result;
}

export function newSimulation(input: Input): Simulation {
  if (input === null || input === undefined || input.Quest === null || input.Quest === undefined || input.Setting === null || input.Setting === undefined || input.Pressure === null || input.Pressure === undefined) {
    throw new Error('live input is incomplete');
  }
  if (n(input.Quest.DifficultyLevel) <= 0 || n(input.Quest.MaxCapacity) <= 0 || n(input.Quest.MentalThreshold) <= 0 || n(input.Pressure.WeightPermil) <= 0) {
    throw new Error('invalid live difficulty, capacity or pressure');
  }
  if (n(input.BeatScoreCoefficientPermil) < 0 || n(input.BeatScoreCoefficientPermil) > 4000) {
    throw new Error('invalid live beat score coefficient');
  }
  if (input.Users.length < 1 || input.Users.length > 2 || input.Chart.length === 0 || input.Chart.length > maxChartEvents) {
    throw new Error('invalid live unit/chart size');
  }
  if (input.AudienceAdvantages.length === 0 || input.ComboAdvantages.length === 0 || input.StaminaConsumption.length === 0) {
    throw new Error('live numeric tables are missing');
  }
  const e = new Simulation(input);
  for (const t of input.Setting.StatusEffectTypeStrengthList ?? []) e.strengthTypes.add(t);
  for (const t of input.Setting.StatusEffectTypeWeaknessDownList ?? []) e.weaknessTypes.add(t);
  for (const t of input.Setting.StatusEffectTypeWeaknessOtherList ?? []) e.weaknessTypes.add(t);
  e.comboRows = input.ComboAdvantages.slice();
  e.comboRows.sort((left, right) => n(left.ComboCount) - n(right.ComboCount));
  e.audienceRows = input.AudienceAdvantages.slice();
  e.audienceRows.sort((left, right) => n(left.AudienceAmount) - n(right.AudienceAmount));
  e.staminaRows = input.StaminaConsumption.slice();
  e.staminaRows.sort((left, right) => n(left.RemainStaminaRatioPercent) - n(right.RemainStaminaRatioPercent));
  for (let side = 0; side < input.Users.length; side++) {
    const source = input.Users[side];
    if (source === null || source === undefined || source.UserDeck === null || source.UserDeck === undefined || (source.UserDeck.Cards?.length ?? 0) !== 5) {
      throw new Error('a live unit must contain five cards');
    }
    const u: LiveUserInfo = structuredClone(source);
    u.Index = side + 1;
    u.UserResult = {};
    e.sides.push({ info: u, combo: 0 });
    e.result.UserInfos = (e.result.UserInfos ?? []).concat([u]);
    for (const c of u.UserDeck!.Cards!) {
      if (c === null || c === undefined || n(c.Index) < side * 5 + 1 || n(c.Index) > side * 5 + 5 || e.byIndex.get(n(c.Index)) !== undefined) {
        throw new Error('invalid or duplicate live card index');
      }
      if ((c.CardId ?? '') === '' || n(c.Stamina) <= 0 || n(c.Mental) < 0 || n(c.Technique) < 0 || n(c.Vocal) < 0 || n(c.Dance) < 0 || n(c.Visual) < 0 || n(c.AudienceAmount) < 0) {
        throw new Error(`invalid prepared live card ${JSON.stringify(c.CardId ?? '')}`);
      }
      // Exact protobuf integer scores are bounded below int64's limit. This
      // also keeps floating-point score evaluation in its useful domain.
      for (const v of [c.Stamina, c.Vocal, c.Dance, c.Visual, c.Mental, c.Technique]) {
        if (n(v) > 1_000_000_000_000) throw new Error('live card attribute exceeds supported range');
      }
      const a: Actor = {
        index: n(c.Index),
        position: ((n(c.Index) - 1) % 5) + 1,
        side,
        card: c,
        data: input.Cards.get(n(c.Index)) ?? emptyCardData(),
        synthetic: false,
        stamina: n(c.Stamina),
        score: 0,
        consumed: 0,
        activations: 0,
        skills: [],
        effects: [],
        migrations: [],
        revision: 1,
        cachedRevision: 0,
        cached: null,
        summary: null,
        summaryRevision: 0,
        effectRows: null,
        effectSnapshot: [],
      };
      c.StartStamina = n(c.Stamina);
      if (a.data.CharacterID === '') {
        throw new Error(`live scoring character identity missing for card ${JSON.stringify(c.CardId ?? '')}`);
      }
      if (n(a.data.CharacterAdvantagePermil) < 0) {
        throw new Error(`negative live character advantage for card ${JSON.stringify(c.CardId ?? '')}`);
      }
      for (const [typ, value] of a.data.Bonuses) {
        if (value < 0) throw unsupported(c.CardId ?? '', 'negative live equipment bonus');
        validateBonusType(c.CardId ?? '', typ, value);
      }
      e.addActor(a, c.Skills ?? []);
      if (n(e.result.TotalAudienceAmount) + n(c.AudienceAmount) > n(input.Quest.MaxCapacity)) {
        throw new Error('audience exceeds venue capacity');
      }
      e.result.TotalAudienceAmount = n(e.result.TotalAudienceAmount) + n(c.AudienceAmount);
    }
    if ((u.UserDeck!.BonusSkills?.length ?? 0) > 0) {
      const a: Actor = {
        index: 999 + side,
        side,
        position: 1,
        synthetic: true,
        card: {},
        data: emptyCardData(),
        stamina: 0,
        score: 0,
        consumed: 0,
        activations: 0,
        skills: [],
        effects: [],
        migrations: [],
        revision: 1,
        cachedRevision: 0,
        cached: null,
        summary: null,
        summaryRevision: 0,
        effectRows: null,
        effectSnapshot: [],
      };
      e.addActor(a, u.UserDeck!.BonusSkills!);
    }
  }
  for (const step of input.Chart) {
    if (step === null || step === undefined || n(step.Number) < 0) {
      throw new Error('invalid master live chart row');
    }
    switch (n(step.Type)) {
      case MusicChartType.Unknown:
      case MusicChartType.Beat:
        break;
      case MusicChartType.ActiveSkill:
      case MusicChartType.SpecialSkill:
        if (n(step.Position) < 1 || n(step.Position) > 5) throw new Error('invalid skill chance position');
        break;
      default:
        throw new Error(`unsupported master live chart type ${n(step.Type)}`);
    }
  }
  e.beatPermil = n(input.BeatScoreCoefficientPermil);
  if (e.beatPermil === 0) {
    e.beatPermil = beatScoreCoefficientPermil(input.Quest.MusicId ?? '', null, input.Chart);
  }
  e.occupancy = n(e.result.TotalAudienceAmount) / n(input.Quest.MaxCapacity);
  e.actors.sort((left, right) => left.index - right.index);
  e.passiveActors = e.actors.slice();
  e.passiveActors.sort((left, right) => {
    if (left.synthetic !== right.synthetic) return left.synthetic ? 1 : -1;
    if (n(left.card.Mental) !== n(right.card.Mental)) return n(right.card.Mental) - n(left.card.Mental);
    return actorBefore(left, right) ? -1 : actorBefore(right, left) ? 1 : 0;
  });
  return e;
}

// Actor registration lives next to the input validation that uses it.
function addActor(this: Simulation, a: Actor, refs: LiveDeckCardSkill[]): void {
  if (refs.length > maxActorSkills) throw new Error('too many live skills');
  const seen = new Set<number>();
  for (const ref of refs) {
    if (ref === null || ref === undefined || seen.has(n(ref.Index))) {
      throw new Error('nil or duplicate live skill index');
    }
    seen.add(n(ref.Index));
    const s = compileSkill(this.input, ref);
    if (a.synthetic && n(s.definition.CategoryType) !== SkillCategoryType.Passive) {
      throw unsupported(ref.SkillId ?? '', 'stage bonus is not passive');
    }
    a.skills.push(s);
  }
  this.actors.push(a);
  this.byIndex.set(a.index, a);
}

function nextOrder(this: Simulation): number {
  this.order++;
  return this.order;
}

function incrementCombo(this: Simulation, s: SideState): void {
  s.combo++;
  if (s.combo > n(s.info.UserResult!.MaxComboCount)) s.info.UserResult!.MaxComboCount = s.combo;
}

function addScore(this: Simulation, a: Actor, value: number): void {
  if (value < 0 || a.score > Number.MAX_SAFE_INTEGER - value || n(this.sides[a.side].info.UserResult!.Score) > Number.MAX_SAFE_INTEGER - value) {
    this.err = new Error('live score overflow');
    return;
  }
  a.score += value;
  this.sides[a.side].info.UserResult!.Score = n(this.sides[a.side].info.UserResult!.Score) + value;
}

function scoreValue(this: Simulation, v: number): number {
  if (Number.isNaN(v) || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER / 4) {
    this.err = new Error('invalid live score calculation');
    return 0;
  }
  return Math.floor(v);
}

function userSnapshots(this: Simulation): LiveUserStatus[] {
  const out: LiveUserStatus[] = [];
  for (const s of this.sides) {
    out.push({ UserIndex: n(s.info.Index), CurrentComboCount: s.combo, TotalScore: n(s.info.UserResult!.Score) });
  }
  return out;
}

function cardSnapshots(this: Simulation): LiveCardStatus[] {
  const out: LiveCardStatus[] = [];
  for (const a of this.actors) {
    if (a.synthetic) continue;
    if (a.cached === null || a.cachedRevision !== a.revision) {
      const s: LiveCardStatus = {
        CardIndex: a.index,
        Stamina: a.stamina,
        Vocal: this.attribute(a, AttributeType.Vocal),
        Dance: this.attribute(a, AttributeType.Dance),
        Visual: this.attribute(a, AttributeType.Visual),
        Effects: this.statusSnapshots(a),
      };
      for (const skill of a.skills) {
        s.SkillStatuses = (s.SkillStatuses ?? []).concat([{ SkillIndex: n(skill.ref.Index), RemainCount: skill.remaining, CoolTime: skill.cooldown }]);
      }
      a.cached = s;
      a.cachedRevision = a.revision;
    }
    // Cached entries are immutable. Reuse across snapshots rather than
    // copying unchanged card/skill/effect state for every passive evaluation.
    out.push(a.cached);
  }
  return out;
}

function laneAttribute(this: Simulation, position: number): number {
  switch (position) {
    case 1:
      return n(this.input.Quest.Position1AttributeType);
    case 2:
      return n(this.input.Quest.Position2AttributeType);
    case 3:
      return n(this.input.Quest.Position3AttributeType);
    case 4:
      return n(this.input.Quest.Position4AttributeType);
    case 5:
      return n(this.input.Quest.Position5AttributeType);
    default:
      return AttributeType.Unknown;
  }
}

export interface EngineMethods {
  addActor(a: Actor, refs: LiveDeckCardSkill[]): void;
  nextOrder(): number;
  incrementCombo(s: SideState): void;
  addScore(a: Actor, value: number): void;
  scoreValue(v: number): number;
  userSnapshots(): LiveUserStatus[];
  cardSnapshots(): LiveCardStatus[];
  laneAttribute(position: number): number;
  moodName(): string;
}

// Merge the engine-local helpers into the Simulation type.
export interface Simulation extends EngineMethods {}

function moodName(this: Simulation): string {
  return moodEnumName(n(this.input.Quest.MoodType));
}

Object.assign(Simulation.prototype, {
  nextOrder,
  incrementCombo,
  addScore,
  scoreValue,
  userSnapshots,
  cardSnapshots,
  laneAttribute,
  moodName,
  addActor,
});

function moodEnumName(value: number): string {
  for (const [name, v] of Object.entries(MoodType)) {
    if (v === value) return `MoodType_${name}`;
  }
  return `MoodType(${value})`;
}

export function validateBonusType(cardID: string, typ: number, value: number): void {
  switch (typ) {
    case PhotoAbilityType.DanceAdd:
    case PhotoAbilityType.DanceMultiply:
    case PhotoAbilityType.VocalAdd:
    case PhotoAbilityType.VocalMultiply:
    case PhotoAbilityType.VisualAdd:
    case PhotoAbilityType.VisualMultiply:
    case PhotoAbilityType.StaminaAdd:
    case PhotoAbilityType.StaminaMultiply:
    case PhotoAbilityType.MentalAdd:
    case PhotoAbilityType.MentalMultiply:
    case PhotoAbilityType.TechniqueAdd:
    case PhotoAbilityType.TechniqueMultiply:
    case PhotoAbilityType.ManagerExp:
    case PhotoAbilityType.Gold:
    case PhotoAbilityType.CardExp:
    case PhotoAbilityType.BeatScoreAdd:
    case PhotoAbilityType.BeatScoreMultiply:
    case PhotoAbilityType.ActiveSkillScoreAdd:
    case PhotoAbilityType.ActiveSkillScoreMultiply:
    case PhotoAbilityType.SpecialSkillScoreAdd:
    case PhotoAbilityType.SpecialSkillScoreMultiply:
    case PhotoAbilityType.CriticalScoreMultiply:
    case PhotoAbilityType.AudienceAmountUp:
    case PhotoAbilityType.CoolTimeReductionSkill1:
    case PhotoAbilityType.CoolTimeReductionSkill2:
    case PhotoAbilityType.CoolTimeReductionSkill3:
      return;
    case PhotoAbilityType.ReceivedStrengthEffectValueIncrease:
    case PhotoAbilityType.ReceivedStrengthEffectCountIncrease:
    case PhotoAbilityType.AffectStrengthEffectValueIncrease:
    case PhotoAbilityType.AffectStrengthEffectCountIncrease:
      if (value !== 0) {
        throw unsupported(cardID, 'status-specific photo effects must use typed StrengthModifiers');
      }
      return;
    case PhotoAbilityType.Unknown:
    case PhotoAbilityType.PassiveSkill:
      if (value === 0) return;
      break;
    default:
      break;
  }
  throw unsupported(cardID, 'unrecognized or unprepared photo bonus ' + String(typ));
}
