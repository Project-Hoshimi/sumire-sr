// Ported from Solis internal/makino/live/status.go.
//
// Status instances are additive per status type: grades sum, capped by the
// strongest definition applied, optionally widened by limit-break variants and
// narrowed by StrengthEffectGradeLimit.

import {
  AttributeType,
  PhotoAbilityType,
  SkillEfficacyType,
  StatusEffectType,
} from './enums.ts';
import type { Actor, Simulation } from './engine.ts';
import type { EffectSpec, SkillState } from './compile.ts';
import { relatedStatuses, statusEfficacy } from './statusNames.ts';
import type { LiveCardStatusEffect, LiveStatusEffectReason } from './types.ts';
import { n } from './util.ts';

export interface StatusInstance {
  spec: EffectSpec;
  grade: number;
  remaining: number;
  source: number;
  skill: number;
}

export interface StatusTotals {
  sum: number;
  cap: number;
  limit: number;
}

const limitStatuses = relatedStatuses('limit_break_');
const superStatuses = relatedStatuses('add_effect_value_');

/** Temporary user-selected balance rule pending an official BeatBoost capture. */
export const beatBoostPermilPerStage = 50;

export function statusCoefficient(status: number): number {
  switch (status) {
    case StatusEffectType.ScoreUp:
      return 25;
    case StatusEffectType.BeatBoost:
      return beatBoostPermilPerStage;
    case StatusEffectType.BeatScoreUp:
    case StatusEffectType.ComboScoreUp:
    case StatusEffectType.PassiveSkillScoreUp:
    case StatusEffectType.PassiveScoreMultiplierAdd:
      return 100;
    case StatusEffectType.SpecialSkillScoreUp:
      return 30;
    case StatusEffectType.VocalBoost:
    case StatusEffectType.DanceBoost:
    case StatusEffectType.VisualBoost:
      return 75;
    case StatusEffectType.SpecialScoreMultiplierAdd:
      return 400;
    case StatusEffectType.ActiveScoreMultiplierAdd:
      return 150;
    case StatusEffectType.StaminaContinuousRecovery:
    case StatusEffectType.StaminaContinuousConsumption:
      return 15;
    case StatusEffectType.ComboContinuation:
    case StatusEffectType.ActiveSkillChanceAssignment:
    case StatusEffectType.CoverWeaknessEffect:
    case StatusEffectType.WeaknessEffectReflection:
    case StatusEffectType.ScoreGetByStrengthEffectCountLimitUp:
    case StatusEffectType.SkillImpossible:
    case StatusEffectType.PassiveSkillImpossible:
      return 1;
    case StatusEffectType.AddEffectValueScoreUp:
    case StatusEffectType.AddEffectValueDanceUp:
    case StatusEffectType.AddEffectValueVocalUp:
    case StatusEffectType.AddEffectValueVisualUp:
    case StatusEffectType.AddEffectValueBeatScoreUp:
    case StatusEffectType.AddEffectValueActiveSkillScoreUp:
    case StatusEffectType.AddEffectValueCriticalBonusPermilUp:
    case StatusEffectType.AddEffectValueAudienceAmountIncrease:
    case StatusEffectType.AddEffectValueSpecialSkillScoreUp:
    case StatusEffectType.AddEffectValueSkillSuccessRateUp:
    case StatusEffectType.AddEffectValuePassiveSkillScoreUp:
    case StatusEffectType.AddEffectValueAudienceAmountReduction:
    case StatusEffectType.AddEffectValueTensionUp:
    case StatusEffectType.AddEffectValueDanceDown:
    case StatusEffectType.AddEffectValueVocalDown:
    case StatusEffectType.AddEffectValueVisualDown:
      return 25;
    default:
      return 50;
  }
}

/** Rebuilds a card's per-status totals when its revision changed. */
export function rebuildSummary(a: Actor): void {
  if (a.summary === null) a.summary = new Map();
  else a.summary.clear();
  for (const s of a.effects) {
    const t = a.summary.get(s.spec.status) ?? { sum: 0, cap: 0, limit: 0 };
    t.sum += s.grade;
    t.cap = Math.max(t.cap, s.spec.cap);
    t.limit = Math.max(t.limit, s.spec.limitCap);
    a.summary.set(s.spec.status, t);
  }
  a.summaryRevision = a.revision;
}

export function statusMethods() {
  return {
    rawGrade(this: Simulation, a: Actor, status: number): StatusTotals {
      if (a.effects.length === 0) return { sum: 0, cap: 0, limit: 0 };
      if (a.summary === null || a.summaryRevision !== a.revision) rebuildSummary(a);
      return a.summary!.get(status) ?? { sum: 0, cap: 0, limit: 0 };
    },

    grade(this: Simulation, a: Actor, status: number): number {
      if (status === StatusEffectType.Unknown) return 0;
      const totals = this.rawGrade(a, status);
      let sum = totals.sum;
      let cap = totals.cap;
      const limit = totals.limit;
      if (cap === 0) return 0;
      const extension = limitStatuses.get(status);
      if (extension !== undefined) {
        const extra = this.rawGrade(a, extension);
        cap += Math.min(extra.sum, extra.cap);
        if (limit > 0) cap = Math.min(cap, limit);
      }
      if (this.isStrength(status)) {
        const limiting = this.rawGrade(a, StatusEffectType.StrengthEffectGradeLimit);
        // Each limiting stage removes 5% of the normally available stages.
        cap = Math.floor(cap * Math.max(0, 1 - 0.05 * Math.min(limiting.sum, limiting.cap)));
      }
      return Math.min(sum, cap);
    },

    effectValue(this: Simulation, a: Actor, status: number): number {
      const g = this.grade(a, status);
      if (g === 0) return 0;
      let value = g * statusCoefficient(status);
      const superStatus = superStatuses.get(status);
      if (superStatus !== undefined) {
        value += this.grade(a, superStatus) * statusCoefficient(superStatus);
      }
      return value;
    },

    attribute(this: Simulation, a: Actor, typ: number): number {
      let base = 0;
      let up: number = StatusEffectType.Unknown;
      let down: number = StatusEffectType.Unknown;
      let boost: number = StatusEffectType.Unknown;
      switch (typ) {
        case AttributeType.Dance:
          base = n(a.card.Dance);
          up = StatusEffectType.DanceUp;
          down = StatusEffectType.DanceDown;
          boost = StatusEffectType.DanceBoost;
          break;
        case AttributeType.Vocal:
          base = n(a.card.Vocal);
          up = StatusEffectType.VocalUp;
          down = StatusEffectType.VocalDown;
          boost = StatusEffectType.VocalBoost;
          break;
        case AttributeType.Visual:
          base = n(a.card.Visual);
          up = StatusEffectType.VisualUp;
          down = StatusEffectType.VisualDown;
          boost = StatusEffectType.VisualBoost;
          break;
        default:
          return 0;
      }
      let permil = 1000 + this.effectValue(a, up) - this.effectValue(a, down) + this.effectValue(a, boost);
      const limit = n(this.input.Setting.LiveMaxParameterBonusPermil);
      if (limit > 0) permil = Math.min(permil, 1000 + limit);
      return this.scoreValue((base * Math.max(0, permil)) / 1000);
    },

    statusSnapshots(this: Simulation, a: Actor): LiveCardStatusEffect[] {
      if (a.effects.length === 0) return [];
      const types: number[] = [];
      const seen = new Set<number>();
      for (const s of a.effects) {
        if (seen.has(s.spec.status)) continue;
        seen.add(s.spec.status);
        types.push(s.spec.status);
      }
      types.sort((left, right) => left - right);
      if (a.effectRows === null) a.effectRows = new Map();
      const out: LiveCardStatusEffect[] = [];
      for (const typ of types) {
        const g = this.grade(a, typ);
        const value = this.effectValue(a, typ);
        let efficacy: number = SkillEfficacyType.Unknown;
        let maxGrade = 0;
        let limitGrade = 0;
        let remaining = 0;
        const reasons: LiveStatusEffectReason[] = [];
        for (const s of a.effects) {
          if (s.spec.status !== typ) continue;
          efficacy = s.spec.typ;
          maxGrade = Math.max(maxGrade, s.spec.cap);
          limitGrade = Math.max(limitGrade, s.spec.limitCap);
          remaining = Math.max(remaining, s.remaining);
          const key = `${s.source}:${s.skill}`;
          if (this.reasons === null) this.reasons = new Map();
          let reason = this.reasons.get(key);
          if (reason === undefined) {
            reason = { CardIndex: s.source, SkillIndex: s.skill };
            this.reasons.set(key, reason);
          }
          if (!reasons.includes(reason)) reasons.push(reason);
        }
        let value2 = 0;
        if (typ === StatusEffectType.SkillSuccessRateUp) value2 = Math.trunc((g * 375) / 10);
        if (typ === StatusEffectType.TensionUp) value2 = g * 15;
        let row = a.effectRows.get(typ);
        let same =
          row !== undefined &&
          n(row.Grade) === g &&
          n(row.Value) === value &&
          n(row.Value2) === value2 &&
          n(row.SkillEfficacyType) === efficacy &&
          n(row.MaxGrade) === maxGrade &&
          n(row.LimitBreakMaxGrade) === limitGrade &&
          n(row.RemainEffectedChartCount) === remaining &&
          (row.StatusReasons?.length ?? 0) === reasons.length;
        if (same && row !== undefined) {
          const stored = row.StatusReasons ?? [];
          for (let i = 0; i < reasons.length; i++) {
            if (stored[i] !== reasons[i]) {
              same = false;
              break;
            }
          }
        }
        if (!same || row === undefined) {
          row = {
            StatusType: typ,
            Grade: g,
            Value: value,
            Value2: value2,
            SkillEfficacyType: efficacy,
            MaxGrade: maxGrade,
            LimitBreakMaxGrade: limitGrade,
            RemainEffectedChartCount: remaining,
            StatusReasons: reasons.slice(),
          };
          a.effectRows.set(typ, row);
        }
        out.push(row);
      }
      let same = out.length === a.effectSnapshot.length;
      if (same) {
        for (let i = 0; i < out.length; i++) {
          if (a.effectSnapshot[i] !== out[i]) {
            same = false;
            break;
          }
        }
      }
      if (!same) a.effectSnapshot = out.slice();
      return a.effectSnapshot;
    },

    addStatus(this: Simulation, target: Actor, source: Actor, skill: SkillState, spec: EffectSpec): void {
      if (target.effects.length + target.migrations.length >= this.maxStatusInstances) {
        this.err = new Error('too many concurrent live status instances');
        return;
      }
      let grade = spec.grade;
      let duration = spec.duration;
      if (this.isStrength(spec.status)) {
        // Photo bonuses affect matching status applications only. Received
        // modifiers belong to the recipient; applied modifiers to the caster.
        const apply = (modifiers: { Type: number; StatusTypes: number[]; Amount: number }[], received: boolean): void => {
          for (const modifier of modifiers) {
            let matches = modifier.StatusTypes.length === 0;
            for (const status of modifier.StatusTypes) {
              matches = matches || status === spec.status;
            }
            if (!matches) continue;
            switch (modifier.Type) {
              case PhotoAbilityType.ReceivedStrengthEffectValueIncrease:
                if (received) grade += modifier.Amount;
                break;
              case PhotoAbilityType.ReceivedStrengthEffectCountIncrease:
                if (received) duration += modifier.Amount;
                break;
              case PhotoAbilityType.AffectStrengthEffectValueIncrease:
                if (!received) grade += modifier.Amount;
                break;
              case PhotoAbilityType.AffectStrengthEffectCountIncrease:
                if (!received) duration += modifier.Amount;
                break;
              default:
                break;
            }
          }
        };
        apply(source.data.StrengthModifiers, false);
        apply(target.data.StrengthModifiers, true);
      }
      target.effects.push({ spec: { ...spec }, grade, remaining: duration, source: source.index, skill: n(skill.ref.Index) });
      target.revision++;
    },

    changeStamina(this: Simulation, a: Actor, delta: number): number {
      const before = a.stamina;
      if (delta >= 0) {
        a.stamina += Math.min(delta, n(a.card.Stamina) - a.stamina);
      } else {
        a.stamina = Math.max(0, a.stamina + delta);
      }
      const change = a.stamina - before;
      if (change < 0) a.consumed -= change;
      if (change > 0) this.event.recovered.add(a.index);
      if (change !== 0) a.revision++;
      return change;
    },

    tick(this: Simulation): void {
      for (const a of this.actors) {
        let changed = false;
        for (const s of a.skills) {
          if (s.cooldown > 0) {
            s.cooldown--;
            changed = true;
          }
        }
        // Periodic effects apply on their final active event, before expiry.
        if (!a.synthetic) {
          const recover = (this.effectValue(a, StatusEffectType.StaminaContinuousRecovery) * this.recoveryWeight()) / 1000;
          const drain = this.effectValue(a, StatusEffectType.StaminaContinuousConsumption);
          if (recover !== 0) this.changeStamina(a, recover);
          if (drain !== 0) this.changeStamina(a, -drain);
        }
        const kept: StatusInstance[] = [];
        for (const s of a.effects) {
          s.remaining--;
          changed = true;
          if (s.remaining > 0) kept.push(s);
        }
        a.effects = kept;
        if (changed) a.revision++;
      }
    },
  };
}
