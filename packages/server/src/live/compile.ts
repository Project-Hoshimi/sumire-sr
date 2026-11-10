// Ported from Solis internal/makino/live/compile.go.
//
// Master definitions encode their parameters inside IDs (for example
// 'ef-score_get-800-chart_dependence' or 'tg-status-dance_up'). Compilation
// validates every definition the simulator will touch and fails loudly with the
// offending ID instead of silently approximating it.

import {
  MoodType,
  PhotoAbilityType,
  SkillCategoryType,
  SkillEfficacyType,
  SkillTargetType,
  SkillTriggerType,
  StatusEffectType,
  enumName,
} from './enums.ts';
import type { Input } from './input.ts';
import { conditionalStatusCoefficient } from './scoring.ts';
import { statusEfficacy, statusID, statusNames } from './statusNames.ts';
import type { LiveDeckCardSkill, Skill, SkillEfficacy, SkillLevel } from './types.ts';
import {
  hasPrefix,
  join,
  n,
  nonnegativeInt32,
  snakeName,
  split,
  splitN2,
  trimPrefix,
  trimSuffix,
} from './util.ts';

/** Identifies the exact definition that must be implemented. */
export class UnsupportedError extends Error {
  readonly definition: string;
  readonly reason: string;

  constructor(definition: string, reason: string) {
    super(`unsupported live definition ${JSON.stringify(definition)}: ${reason}`);
    this.name = 'UnsupportedError';
    this.definition = definition;
    this.reason = reason;
  }
}

export function unsupported(id: string, reason: string): UnsupportedError {
  return new UnsupportedError(id, reason);
}

export interface TriggerSpec {
  id: string;
  kind: number;
  value: number;
  status: number;
  characters: string[];
  text: string;
}

export interface TargetSpec {
  id: string;
  kind: number;
  opponent: boolean;
  count: number;
  value: number;
  status: number;
}

export interface EffectSpec {
  id: string;
  operation: string;
  typ: number;
  status: number;
  secondary: number;
  grade: number;
  cap: number;
  limitCap: number;
  duration: number;
  value: number;
  target: TargetSpec;
  trigger: TriggerSpec;
  conditional: TriggerSpec;
  conditionalPower: number;
  text: string;
}

export interface SkillState {
  ref: LiveDeckCardSkill;
  definition: Skill;
  level: SkillLevel;
  trigger: TriggerSpec;
  effects: EffectSpec[];
  cooldown: number;
  remaining: number;
  usedEvent: number;
  currentStaminaCost: number;
}

export function emptyTriggerSpec(): TriggerSpec {
  return { id: '', kind: SkillTriggerType.Unknown, value: 0, status: StatusEffectType.Unknown, characters: [], text: '' };
}

export function emptyTargetSpec(): TargetSpec {
  return { id: '', kind: SkillTargetType.Unknown, opponent: false, count: 5, value: 0, status: StatusEffectType.Unknown };
}

export function emptyEffectSpec(id: string): EffectSpec {
  return {
    id,
    operation: '',
    typ: SkillEfficacyType.Unknown,
    status: StatusEffectType.Unknown,
    secondary: StatusEffectType.Unknown,
    grade: 0,
    cap: 0,
    limitCap: 0,
    duration: 0,
    value: 0,
    target: emptyTargetSpec(),
    trigger: emptyTriggerSpec(),
    conditional: emptyTriggerSpec(),
    conditionalPower: 0,
    text: '',
  };
}

function nonnegativeInt(id: string, raw: string): number {
  const value = nonnegativeInt32(raw);
  if (value === undefined) throw unsupported(id, `invalid integer parameter ${raw}`);
  return value;
}

export function compileTrigger(input: Input, id: string): TriggerSpec {
  const t = emptyTriggerSpec();
  t.id = id;
  if (id === '') return t;
  const m = input.Triggers.get(id);
  if (m === undefined || m === null) throw unsupported(id, 'missing trigger master');
  t.kind = n(m.Type);
  t.characters = m.CharacterIds ?? [];
  const raw = trimPrefix(id, 'tg-');
  const parts = split(raw, '-');
  const last = parts[parts.length - 1];
  const lastNumber = () => {
    t.value = nonnegativeInt(id, last);
  };
  switch (t.kind) {
    case SkillTriggerType.Beat:
    case SkillTriggerType.LiveStart:
    case SkillTriggerType.BeforeActiveSkillBySomeone:
    case SkillTriggerType.BeforeSpecialSkillBySomeone:
    case SkillTriggerType.BeforeCritical:
    case SkillTriggerType.BeforeCriticalBySomeone:
    case SkillTriggerType.Critical:
    case SkillTriggerType.Center:
    case SkillTriggerType.StatusGroup:
    case SkillTriggerType.SomeoneStatusGroup:
    case SkillTriggerType.PositionAttributeVocal:
    case SkillTriggerType.PositionAttributeDance:
    case SkillTriggerType.PositionAttributeVisual:
    case SkillTriggerType.SomeoneRecovered:
    case SkillTriggerType.MostLeft:
    case SkillTriggerType.MostRight:
    case SkillTriggerType.BeforeSpecialSkill:
    case SkillTriggerType.AfterActiveSkillByOpponentSomeone:
      break;
    case SkillTriggerType.Combo:
    case SkillTriggerType.MoreThanCharacterCount:
    case SkillTriggerType.StaminaLower:
    case SkillTriggerType.StaminaHigher:
    case SkillTriggerType.SomeoneStaminaLower:
    case SkillTriggerType.FanEngageHigher:
    case SkillTriggerType.ComboLessEqual:
      lastNumber();
      if (t.kind === SkillTriggerType.MoreThanCharacterCount && t.characters.length === 0) {
        throw unsupported(id, 'character-count trigger has no character set');
      }
      break;
    case SkillTriggerType.Status:
    case SkillTriggerType.SomeoneStatus:
      if (parts.length !== 2) throw unsupported(id, 'status trigger shape');
      t.status = statusID(parts[1]);
      break;
    case SkillTriggerType.MoodType: {
      t.text = trimPrefix(raw, 'mood_type-');
      let found = false;
      for (const name of Object.keys(MoodType)) {
        if (snakeName(name) === t.text) found = true;
      }
      if (!found) throw unsupported(id, 'unknown mood');
      break;
    }
    case SkillTriggerType.Music:
      t.text = trimPrefix(raw, 'music-');
      break;
    case SkillTriggerType.SomeoneStatusEffectGradeHigher:
      lastNumber();
      t.status = statusID(trimSuffix(trimPrefix(raw, 'someone_status_effect_grade_higher_'), '-' + last));
      break;
    default:
      throw unsupported(id, `trigger type ${enumName(SkillTriggerType, t.kind) ?? String(t.kind)}`);
  }
  return t;
}

export function compileTarget(input: Input, id: string): TargetSpec {
  const t = emptyTargetSpec();
  t.id = id;
  t.count = 5;
  if (id === '') {
    t.kind = SkillTargetType.Self;
    t.count = 1;
    return t;
  }
  const m = input.Targets.get(id);
  if (m === undefined || m === null) throw unsupported(id, 'missing target master');
  t.kind = n(m.Type);
  t.opponent = m.IsOpponent === true;
  const parts = split(id, '-');
  const last = () => {
    t.count = nonnegativeInt(id, parts[parts.length - 1]);
  };
  switch (t.kind) {
    case SkillTargetType.Self:
    case SkillTargetType.Center:
    case SkillTargetType.Trigger:
    case SkillTargetType.OpponentCenter:
    case SkillTargetType.OpponentSamePosition:
      t.count = 1;
      if (t.kind === SkillTargetType.Trigger && parts.length > 2) last();
      break;
    case SkillTargetType.All:
    case SkillTargetType.Neighbor:
    case SkillTargetType.OpponentAll:
      break;
    case SkillTargetType.DanceHigher:
    case SkillTargetType.VocalHigher:
    case SkillTargetType.VisualHigher:
    case SkillTargetType.StaminaHigher:
    case SkillTargetType.StaminaLower:
    case SkillTargetType.Vocal:
    case SkillTargetType.Dance:
    case SkillTargetType.Visual:
    case SkillTargetType.PositionAttributeVocal:
    case SkillTargetType.PositionAttributeDance:
    case SkillTargetType.PositionAttributeVisual:
    case SkillTargetType.OpponentVocal:
    case SkillTargetType.OpponentDance:
    case SkillTargetType.OpponentVisual:
    case SkillTargetType.OpponentPositionAttributeDance:
      last();
      break;
    case SkillTargetType.Status:
      if (parts.length !== 4) throw unsupported(id, 'status target shape');
      t.status = statusID(parts[2]);
      last();
      break;
    case SkillTargetType.CardType:
    case SkillTargetType.OpponentCardType:
    case SkillTargetType.StaminaMoreThanEqual:
    case SkillTargetType.OpponentStaminaLessThanEqual: {
      if (parts.length !== 4) throw unsupported(id, 'parameterized target shape');
      const v = nonnegativeInt(id, parts[2]);
      const w = nonnegativeInt(id, parts[3]);
      if (t.kind === SkillTargetType.CardType || t.kind === SkillTargetType.OpponentCardType) {
        t.value = v;
        t.count = w;
      } else {
        t.count = v;
        t.value = w;
      }
      break;
    }
    default:
      throw unsupported(id, `target type ${enumName(SkillTargetType, t.kind) ?? String(t.kind)}`);
  }
  if (t.count < 1 || t.count > 5) throw unsupported(id, 'target count outside unit size');
  return t;
}

export function compileEffect(input: Input, id: string, triggerID: string): EffectSpec {
  const e = emptyEffectSpec(id);
  const m = input.Efficacies.get(id);
  if (m === undefined || m === null) throw unsupported(id, 'missing efficacy master');
  e.typ = n(m.Type);
  e.grade = n(m.Grade);
  e.cap = n(m.MaxGrade);
  e.limitCap = n(m.LimitBreakMaxGrade);
  e.trigger = compileTrigger(input, triggerID);
  const targetID = m.SkillTargetId ?? '';
  e.target = compileTarget(input, targetID);
  const body = trimPrefix(id, 'ef-');
  const parts = split(body, '-');
  e.operation = parts[0];
  const status = statusNames.get(e.operation);
  if (status !== undefined && status !== StatusEffectType.Unknown) {
    e.status = status;
    if (targetID === '') throw unsupported(id, 'status effect without target');
    const targetParts = splitN2(body, targetID);
    if (targetParts.length !== 2) throw unsupported(id, 'target ID absent from efficacy encoding');
    const duration = trimPrefix(targetParts[1], '-');
    e.duration = nonnegativeInt(id, duration);
    if (e.duration < 1) throw unsupported(id, 'nonpositive status duration');
    if (e.grade === 0) e.grade = 1;
    if (e.cap === 0) e.cap = e.grade;
    e.operation = 'status';
    return e;
  }
  switch (e.operation) {
    case 'score_get':
    case 'score_get_by_less_fan_amount':
    case 'score_get_by_more_fan_engage':
    case 'score_get_by_more_stamina':
    case 'score_get_by_less_stamina':
    case 'score_get_by_more_combo_count':
    case 'score_get_by_strength_effect_count':
    case 'score_get_by_less_combo_count':
    case 'score_get_by_skill_activation_count':
    case 'score_get_by_more_stamina_use':
    case 'score_get_by_skill_success_rate_up':
    case 'score_get_and_stamina_consumption_by_more_stamina_use':
      if (parts.length !== 3 || parts[2] !== 'chart_dependence') {
        throw unsupported(id, 'score parameter shape');
      }
      e.value = nonnegativeInt(id, parts[1]);
      break;
    case 'score_get_by_status_effect_type_grade':
    case 'score_get_by_character_count':
      if (parts.length !== 4 || parts[3] !== 'chart_dependence') {
        throw unsupported(id, 'conditional score shape');
      }
      e.text = parts[1];
      e.value = nonnegativeInt(id, parts[2]);
      if (e.operation === 'score_get_by_status_effect_type_grade') {
        e.secondary = statusID(e.text);
        if (!conditionalStatusCoefficient(e.secondary).supported) {
          throw unsupported(id, 'conditional status power coefficient is unknown');
        }
      }
      break;
    case 'score_get_by_trigger': {
      // ef-score_get_by_trigger-BASE-tg-...-BOOST-chart_dependence.
      if (parts.length < 6 || parts[parts.length - 1] !== 'chart_dependence') {
        throw unsupported(id, 'trigger score shape');
      }
      e.value = nonnegativeInt(id, parts[1]);
      e.conditionalPower = nonnegativeInt(id, parts[parts.length - 2]);
      e.conditional = compileTrigger(input, join(parts.slice(2, parts.length - 2), '-'));
      break;
    }
    case 'fix_stamina_recovery':
    case 'target_stamina_recovery':
    case 'stamina_consumption':
    case 'strength_effect_count_increase':
    case 'strength_effect_value_increase':
    case 'strength_effect_value_decrease':
    case 'cool_time_reduction':
    case 'cool_time_increase':
    case 'score_get_by_score_ratio':
      if (parts.length < 3) throw unsupported(id, 'effect value missing');
      e.value = nonnegativeInt(id, parts[1]);
      break;
    case 'live_ability_cool_time_reduction':
      if (parts.length !== 2) throw unsupported(id, 'live bonus cooldown shape');
      e.value = nonnegativeInt(id, parts[1]);
      break;
    case 'weakness_effect_recovery':
    case 'weakness_effect_inversion':
    case 'strength_effect_erasing_all':
    case 'strength_effect_assignment_all':
    case 'passive_skill_cool_time_reset':
      break;
    case 'strength_effect_migration_before_active_skill':
    case 'strength_effect_migration_before_special_skill':
      if (targetID === '') throw unsupported(id, 'migration effect without target');
      break;
    case 'strength_effect_erasing':
    case 'strength_effect_assignment':
      if (parts.length < 3) throw unsupported(id, 'effect status missing');
      e.secondary = statusID(parts[1]);
      break;
    case 'status_effect_change': {
      if (targetID === '') throw unsupported(id, 'change effect without target');
      const targetParts = splitN2(body, targetID);
      if (targetParts.length !== 2) throw unsupported(id, 'target ID absent from change encoding');
      const rest = split(trimPrefix(targetParts[1], '-'), '-');
      if (rest.length !== 2) throw unsupported(id, 'status change shape');
      e.status = statusID(rest[0]);
      e.secondary = statusID(rest[1]);
      // The conversion definition has no caps. They belong to the destination
      // status, whose normal efficacy is in the master set.
      const destination = statusEfficacy(e.secondary);
      for (const row of input.Efficacies.values()) {
        if (n(row.Type) === destination) {
          e.cap = Math.max(e.cap, n(row.MaxGrade));
          e.limitCap = Math.max(e.limitCap, n(row.LimitBreakMaxGrade));
        }
      }
      if (e.cap === 0) throw unsupported(id, 'missing destination status caps');
      break;
    }
    case 'score_get_by_strength_effect_count_limit_increase':
      e.operation = 'status';
      e.status = StatusEffectType.ScoreGetByStrengthEffectCountLimitUp;
      if (parts.length < 5) throw unsupported(id, 'buff-kind cap shape');
      e.value = nonnegativeInt(id, parts[1]);
      e.grade = e.value;
      e.cap = e.grade;
      e.duration = nonnegativeInt(id, parts[parts.length - 1]);
      break;
    default:
      throw unsupported(id, `efficacy family ${e.operation}`);
  }
  return e;
}

/**
 * Lets adapters resolve destination status caps without duplicating the encoded
 * master-ID parser or loading all efficacies.
 */
export function conversionStatusEfficacyType(row: SkillEfficacy): {
  typ: number;
  matched: boolean;
  error?: UnsupportedError;
} {
  if (row === null || n(row.Type) !== SkillEfficacyType.StatusEffectChange) {
    return { typ: SkillEfficacyType.Unknown, matched: false };
  }
  const targetID = row.SkillTargetId ?? '';
  const id = row.Id ?? '';
  const prefix = 'ef-status_effect_change-' + targetID + '-';
  if (targetID === '' || !hasPrefix(id, prefix)) {
    return { typ: SkillEfficacyType.Unknown, matched: true, error: unsupported(id, 'status change shape') };
  }
  const parts = split(trimPrefix(id, prefix), '-');
  if (parts.length !== 2) {
    return { typ: SkillEfficacyType.Unknown, matched: true, error: unsupported(id, 'status change shape') };
  }
  let status: number;
  try {
    status = statusID(parts[1]);
  } catch {
    return { typ: SkillEfficacyType.Unknown, matched: true, error: unsupported(id, 'unknown status name') };
  }
  const typ = statusEfficacy(status);
  if (typ === SkillEfficacyType.Unknown) {
    return { typ, matched: true, error: unsupported(id, 'unknown destination efficacy') };
  }
  return { typ, matched: true };
}

export function compileSkill(input: Input, ref: LiveDeckCardSkill): SkillState {
  if (ref === null || ref === undefined || n(ref.Index) < 1 || n(ref.SkillLevel) < 1) {
    throw unsupported('skill', 'invalid learned skill reference');
  }
  const skillID = ref.SkillId ?? '';
  const m = input.Skills.get(skillID);
  if (m === undefined || m === null) throw unsupported(skillID, 'missing skill master');
  const category = n(m.CategoryType);
  if (category !== SkillCategoryType.Special && category !== SkillCategoryType.Active && category !== SkillCategoryType.Passive) {
    throw unsupported(skillID, 'unknown skill category');
  }
  const levelNo = n(ref.SkillLevel);
  let level: SkillLevel | undefined;
  for (const row of m.Levels ?? []) {
    if (row !== null && n(row.Level) === levelNo) {
      level = row;
      break;
    }
  }
  if (level === undefined) throw unsupported(skillID, 'missing learned level');
  if (n(level.Stamina) < 0 || n(level.StaminaPermil) < 0 || n(level.CoolTime) < 0 || n(level.LimitCount) < 0 || n(level.ProbabilityPermil) < 0 || n(level.ProbabilityPermil) > 1000) {
    throw unsupported(skillID, 'invalid skill costs or probability');
  }
  const trigger = compileTrigger(input, level.TriggerId ?? '');
  const s: SkillState = {
    ref,
    definition: m,
    level,
    trigger,
    effects: [],
    cooldown: 0,
    remaining: n(level.LimitCount),
    usedEvent: -1,
    currentStaminaCost: 0,
  };
  const details = level.SkillDetails ?? [];
  const rewritten = ref.RewrittenEfficacyIds ?? [];
  for (let i = 0; i < details.length; i++) {
    const detail = details[i];
    if (detail === null || detail === undefined) throw unsupported(skillID, 'nil skill detail');
    let id = detail.EfficacyId ?? '';
    if (i < rewritten.length && rewritten[i] !== '' && rewritten[i] !== null && rewritten[i] !== undefined) {
      id = rewritten[i];
    }
    s.effects.push(compileEffect(input, id, detail.TriggerId ?? ''));
  }
  if (s.effects.length === 0) throw unsupported(skillID, 'skill has no effects');
  return s;
}

/** go: enum String() for a raw enum value, used in compile error text. */
export function skillTriggerLabel(value: number): string {
  return enumName(SkillTriggerType, value) ?? String(value);
}

/** go: PhotoAbilityType for a cooldown-reduction slot (0 when not 1..3). */
export function cooldownBonusForSlot(slot: number): number {
  switch (slot) {
    case 1:
      return PhotoAbilityType.CoolTimeReductionSkill1;
    case 2:
      return PhotoAbilityType.CoolTimeReductionSkill2;
    case 3:
      return PhotoAbilityType.CoolTimeReductionSkill3;
    default:
      return PhotoAbilityType.Unknown;
  }
}
