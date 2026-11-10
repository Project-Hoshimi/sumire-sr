// Ported from Solis internal/makino/live/scoring.go.
//
// These equations are the server's authored composition: RNG ordering,
// attention redistribution and the unverified conditional coefficients follow
// the reference implementation rather than any official formula.

import {
  AttributeType,
  PhotoAbilityType,
  SkillCategoryType,
  StatusEffectType,
} from './enums.ts';
import type { Simulation, Actor } from './engine.ts';
import type { EffectSpec, SkillState } from './compile.ts';
import { n } from './util.ts';

/** Authored low-fan catch-up curve; neither coefficient is an official datum. */
export const lowFanPowerMaximumBonus = 0.8;
export const lowFanTargetCapacityMultiplier = 2;

export interface ConditionalCoefficient {
  coefficient: number;
  supported: boolean;
}

export function conditionalStatusCoefficient(status: number): ConditionalCoefficient {
  switch (status) {
    case StatusEffectType.TensionUp:
      return { coefficient: 0.16, supported: true };
    case StatusEffectType.CriticalRateUp:
      return { coefficient: 0.067, supported: true };
    case StatusEffectType.ActiveSkillScoreUp:
    case StatusEffectType.CriticalBonusPermilUp:
      return { coefficient: 0.063, supported: true };
    case StatusEffectType.AudienceAmountIncrease:
      return { coefficient: 0.07, supported: true };
    case StatusEffectType.DanceUp:
    case StatusEffectType.VocalUp:
    case StatusEffectType.VisualUp:
    case StatusEffectType.StaminaConsumptionReduction:
    case StatusEffectType.VocalBoost:
    case StatusEffectType.DanceBoost:
    case StatusEffectType.VisualBoost:
      return { coefficient: 0.06, supported: true };
    default:
      return { coefficient: 0, supported: false };
  }
}

export function characterScoreFactor(a: Actor): number {
  // An omitted adapter value is neutral, including synthetic stage actors.
  if (a.data.CharacterAdvantagePermil === 0) return 1;
  return a.data.CharacterAdvantagePermil / 1000;
}

export function scoringMethods() {
  return {
    beatScore(this: Simulation, a: Actor, critical: boolean): number {
      const q = this.input.Quest;
      // Floor each weighted attribute separately: capture060/chart203
      // distinguishes this from flooring their sum.
      const weighted =
        Math.floor((this.attribute(a, AttributeType.Vocal) * n(q.BeatVocalWeightPermil)) / 1000) +
        Math.floor((this.attribute(a, AttributeType.Dance) * n(q.BeatDanceWeightPermil)) / 1000) +
        Math.floor((this.attribute(a, AttributeType.Visual) * n(q.BeatVisualWeightPermil)) / 1000);
      const base = (weighted * this.beatPermil) / 1000;
      const bonus =
        1 +
        (this.effectValue(a, StatusEffectType.ScoreUp) +
          this.effectValue(a, StatusEffectType.BeatScoreUp) +
          this.effectValue(a, StatusEffectType.BeatBoost) +
          (a.data.Bonuses.get(PhotoAbilityType.BeatScoreMultiply) ?? 0)) /
          1000;
      const value =
        base *
          bonus *
          this.comboFactor(a) *
          this.fanFactor(a) *
          this.criticalFactor(a, critical) *
          characterScoreFactor(a) *
          this.jitter() +
        (a.data.Bonuses.get(PhotoAbilityType.BeatScoreAdd) ?? 0);
      return this.scoreValue(value);
    },

    skillScore(this: Simulation, a: Actor, s: SkillState, eff: EffectSpec, critical: boolean): number {
      let power = this.skillPower(a, s, eff);
      if (this.err !== null) return 0;
      const category = n(s.definition.CategoryType);
      let stage = 1;
      let bonus =
        1 +
        (this.effectValue(a, StatusEffectType.ScoreUp) + this.effectValue(a, StatusEffectType.TensionUp)) / 1000;
      let fixed = 0;
      switch (category) {
        case SkillCategoryType.Active:
          stage = n(this.input.Quest.ActiveSkillWeightPermil) / 1000;
          bonus +=
            (this.effectValue(a, StatusEffectType.ActiveSkillScoreUp) +
              (a.data.Bonuses.get(PhotoAbilityType.ActiveSkillScoreMultiply) ?? 0)) /
            1000;
          fixed = a.data.Bonuses.get(PhotoAbilityType.ActiveSkillScoreAdd) ?? 0;
          power += this.effectValue(a, StatusEffectType.ActiveScoreMultiplierAdd) / 1000;
          break;
        case SkillCategoryType.Special:
          stage = n(this.input.Quest.SpecialSkillWeightPermil) / 1000;
          bonus +=
            (this.effectValue(a, StatusEffectType.SpecialSkillScoreUp) +
              (a.data.Bonuses.get(PhotoAbilityType.SpecialSkillScoreMultiply) ?? 0)) /
            1000;
          fixed = a.data.Bonuses.get(PhotoAbilityType.SpecialSkillScoreAdd) ?? 0;
          power += this.effectValue(a, StatusEffectType.SpecialScoreMultiplierAdd) / 1000;
          break;
        case SkillCategoryType.Passive:
          // Current official help includes tension for P skills.
          bonus += this.effectValue(a, StatusEffectType.PassiveSkillScoreUp) / 1000;
          power += this.effectValue(a, StatusEffectType.PassiveScoreMultiplierAdd) / 1000;
          break;
        default:
          break;
      }
      let attribute = this.laneAttribute(a.position);
      if (category !== SkillCategoryType.Passive && this.event.chart !== null) {
        // Reassignment changes who owns the opportunity, not its attribute.
        attribute = this.laneAttribute(n(this.event.chart.Position));
      }
      let base = this.attribute(a, attribute);
      let audienceCombo = this.comboFactor(a) * this.fanFactor(a);
      if (eff.operation === 'score_get_by_score_ratio') {
        base = 0;
        for (const target of this.targets(eff.target, a)) {
          base += target.score;
        }
        // Cumulative-score skills exclude both multipliers.
        audienceCombo = 1;
      }
      return this.scoreValue(
        base * power * bonus * audienceCombo * stage * this.criticalFactor(a, critical) * characterScoreFactor(a) * this.jitter() + fixed,
      );
    },

    skillPower(this: Simulation, a: Actor, s: SkillState, eff: EffectSpec): number {
      let factor = 1;
      let ratio = 0;
      if (n(a.card.Stamina) > 0) {
        ratio = Math.max(0, Math.min(1, a.stamina / n(a.card.Stamina)));
      }
      const combo = this.sides[a.side].combo;
      switch (eff.operation) {
        case 'score_get':
        case 'score_get_by_score_ratio':
          break;
        case 'score_get_by_status_effect_type_grade': {
          const coefficient = conditionalStatusCoefficient(eff.secondary);
          if (!coefficient.supported) {
            this.err = new Error(`unsupported live definition ${JSON.stringify(eff.id)}: conditional status power coefficient is unknown`);
            return 0;
          }
          factor += coefficient.coefficient * this.grade(a, eff.secondary);
          break;
        }
        case 'score_get_by_strength_effect_count': {
          const seen = new Set<number>();
          for (const v of a.effects) {
            if (this.isStrength(v.spec.status) && this.grade(a, v.spec.status) > 0) {
              seen.add(v.spec.status);
            }
          }
          const limit = 9 + this.effectValue(a, StatusEffectType.ScoreGetByStrengthEffectCountLimitUp);
          factor += 0.14 * Math.min(seen.size, limit);
          break;
        }
        case 'score_get_by_more_stamina':
          factor += 0.8 * ratio * ratio;
          break;
        case 'score_get_by_less_stamina':
          factor += 0.8 * (1 - ratio) * (1 - ratio);
          break;
        case 'score_get_by_more_combo_count':
          factor += combo / 110;
          break;
        case 'score_get_by_less_combo_count': {
          const v = Math.max(150 - combo, 0) / 150;
          factor += 2 * v * v;
          break;
        }
        case 'score_get_by_more_fan_engage': {
          const v = this.coreFanRatio(a);
          factor += 1.8 * v * v;
          break;
        }
        case 'score_get_by_less_fan_amount': {
          // Maximum +80% at zero total fans, falling to zero extra power at
          // twice the venue capacity. Uses character fan buckets, never
          // attention-adjusted seats.
          if (a.data.LightFans < 0 || a.data.MiddleFans < 0 || a.data.HeavyFans < 0) {
            this.err = new Error(`unsupported live definition ${JSON.stringify(eff.id)}: negative character fan count`);
            return 0;
          }
          const total = a.data.LightFans + a.data.MiddleFans + a.data.HeavyFans;
          const fraction = Math.min(1, Math.max(0, total / (lowFanTargetCapacityMultiplier * n(this.input.Quest.MaxCapacity))));
          factor += lowFanPowerMaximumBonus * (1 - fraction) * (1 - fraction);
          break;
        }
        case 'score_get_by_skill_activation_count':
          factor += 0.097 * a.activations;
          break;
        case 'score_get_by_more_stamina_use':
          factor += 0.00011 * a.consumed;
          break;
        case 'score_get_and_stamina_consumption_by_more_stamina_use':
          // +log10(current skill stamina / 900), clamped to +100% at 9000.
          if (s.currentStaminaCost > 900) {
            factor += Math.min(1, Math.log10(s.currentStaminaCost / 900));
          }
          break;
        case 'score_get_by_skill_success_rate_up': {
          const rate = Math.floor(Math.min(Math.max(this.successRate(a), 0), 2) * 1000) / 1000;
          factor += 0.48 * rate;
          break;
        }
        case 'score_get_by_character_count': {
          let count = 0;
          for (const other of this.actors) {
            if (!other.synthetic && other.side === a.side && other.data.GroupID === eff.text) count++;
          }
          factor += 0.25 * Math.min(count, 4);
          break;
        }
        case 'score_get_by_trigger': {
          const matched = this.matches(eff.conditional, a).matched;
          if (matched) return eff.conditionalPower / 1000;
          return eff.value / 1000;
        }
        default:
          this.err = new Error(`unsupported live definition ${JSON.stringify(eff.id)}: conditional score formula is not supported`);
          return 0;
      }
      // Values are permil, so flooring here truncates power to 0.1 percentage point.
      return this.scoreValue(eff.value * factor) / 1000;
    },

    successRate(this: Simulation, a: Actor): number {
      if (a.synthetic) return 1;
      // Excess mental before tension is retained intentionally.
      const base =
        (1000 * n(a.card.Mental) * this.occupancy) / n(this.input.Quest.MentalThreshold) / n(this.input.Pressure.WeightPermil);
      return Math.max(
        0,
        base + this.effectValue(a, StatusEffectType.SkillSuccessRateUp) / 1000 - (this.effectValue(a, StatusEffectType.TensionUp) * 0.3) / 1000,
      );
    },

    criticalRate(this: Simulation, a: Actor): number {
      if (a.synthetic) return 0;
      let base = n(a.card.Technique) / 1000 / n(this.input.Quest.DifficultyLevel);
      if (this.input.DisableBaseCriticalRate === true) base = 0;
      return Math.min(1, Math.max(0, base + this.effectValue(a, StatusEffectType.CriticalRateUp) / 1000));
    },

    criticalFactor(this: Simulation, a: Actor, critical: boolean): number {
      if (!critical) return 1;
      return (
        1.5 +
        (this.effectValue(a, StatusEffectType.CriticalBonusPermilUp) + (a.data.Bonuses.get(PhotoAbilityType.CriticalScoreMultiply) ?? 0)) / 1000
      );
    },

    jitter(this: Simulation): number {
      return (950 + this.rng.intN(101)) / 1000;
    },

    comboFactor(this: Simulation, a: Actor): number {
      const combo = this.sides[a.side].combo;
      let bonus = 0;
      for (const row of this.comboRows) {
        if (n(row.ComboCount) > combo) break;
        bonus = Math.max(0, n(row.AdvantagePermil) - 1000);
      }
      return 1 + (bonus / 1000) * (1 + this.effectValue(a, StatusEffectType.ComboScoreUp) / 1000);
    },

    fanFactor(this: Simulation, a: Actor): number {
      // Attention/stealth redistribute a side's existing audience proportionally.
      const weight = (x: Actor): number =>
        Math.max(
          0,
          1 +
            (this.effectValue(x, StatusEffectType.AudienceAmountIncrease) - this.effectValue(x, StatusEffectType.AudienceAmountReduction)) / 1000,
        );
      let total = 0;
      let weighted = 0;
      for (const other of this.actors) {
        if (!other.synthetic && other.side === a.side) {
          total += n(other.card.AudienceAmount);
          weighted += n(other.card.AudienceAmount) * weight(other);
        }
      }
      let attendance = n(a.card.AudienceAmount);
      if (weighted > 0) {
        attendance = (attendance * weight(a) * total) / weighted;
      }
      // Conservative lower-row lookup, clamped above the last master breakpoint.
      let advantage = 1000;
      let low = 0;
      let high = this.audienceRows.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (n(this.audienceRows[mid].AudienceAmount) > attendance) high = mid;
        else low = mid + 1;
      }
      if (low > 0) advantage = n(this.audienceRows[low - 1].AdvantagePermil);
      return advantage / 1000;
    },

    staminaCost(this: Simulation, a: Actor, s: SkillState): number {
      const base = n(s.level.Stamina) + (n(a.card.Stamina) * n(s.level.StaminaPermil)) / 1000;
      // Boost's added cost is independent of its attribute effect.
      const boost =
        (this.grade(a, StatusEffectType.VocalBoost) + this.grade(a, StatusEffectType.DanceBoost) + this.grade(a, StatusEffectType.VisualBoost)) *
        0.01;
      const factor = Math.max(
        0,
        1 +
          (this.effectValue(a, StatusEffectType.StaminaConsumptionIncrease) - this.effectValue(a, StatusEffectType.StaminaConsumptionReduction)) / 1000 +
          boost,
      );
      return this.scoreValue(((base * n(this.input.Quest.SkillStaminaWeightPermil)) / 1000) * factor);
    },

    authority(this: Simulation, a: Actor, attribute: number): number {
      if (a.synthetic || n(a.card.Stamina) <= 0) return 0;
      let staminaFactor = 1000;
      if (a.stamina <= 0) {
        staminaFactor = 250;
      } else {
        for (const row of this.staminaRows) {
          if (a.stamina * 100 <= n(a.card.Stamina) * n(row.RemainStaminaRatioPercent)) {
            staminaFactor = n(row.SkillTargetParameterWeightPermil);
            break;
          }
        }
      }
      // Workbook: floor(3.75% per success-up stage to a 0.1% boundary).
      const successAdjustment = Math.floor(this.effectValue(a, StatusEffectType.SkillSuccessRateUp) * 0.75);
      return this.scoreValue((this.attribute(a, attribute) * (staminaFactor + successAdjustment)) / 1000);
    },
  };
}
