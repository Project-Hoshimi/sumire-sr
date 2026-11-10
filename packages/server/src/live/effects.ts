// Ported from Solis internal/makino/live/effects.go.
//
// New effect families add one compiler rule and one executor; ordinary statuses
// and parameter variants share these handlers rather than one class per skill.

import {
  SkillCategoryType,
  SkillEfficacyType,
  SkillTriggerType,
  StatusEffectType,
} from './enums.ts';
import type { Actor, Simulation } from './engine.ts';
import type { EffectSpec, SkillState } from './compile.ts';
import { unsupported } from './compile.ts';
import type { LiveSkillDetail, LiveSkillDetailTargetCardInfo } from './types.ts';
import type { StatusInstance } from './status.ts';
import { hasPrefix, n } from './util.ts';
import { statusEfficacy } from './statusNames.ts';

type EffectHandler = (e: Simulation, source: Actor, target: Actor, skill: SkillState, spec: EffectSpec) => number;

function applyStatus(e: Simulation, source: Actor, target: Actor, skill: SkillState, spec: EffectSpec): number {
  e.addStatus(target, source, skill, spec);
  return 0;
}

function applyRecovery(e: Simulation, source: Actor, target: Actor, skill: SkillState, spec: EffectSpec): number {
  let value = spec.value;
  if (spec.operation === 'target_stamina_recovery') {
    value = e.scoreValue((n(target.card.Stamina) * value) / 1000);
  }
  value = e.scoreValue((value * e.recoveryWeight()) / 1000);
  e.changeStamina(target, value);
  return value;
}

function applyDrain(e: Simulation, source: Actor, target: Actor, skill: SkillState, spec: EffectSpec): number {
  e.changeStamina(target, -spec.value);
  return spec.value;
}

function applyCooldown(e: Simulation, source: Actor, target: Actor, skill: SkillState, spec: EffectSpec): number {
  for (const s of target.skills) {
    switch (spec.operation) {
      case 'cool_time_reduction':
      case 'live_ability_cool_time_reduction':
        s.cooldown = Math.max(0, s.cooldown - spec.value);
        break;
      case 'cool_time_increase':
        if (s.cooldown > 0) s.cooldown += spec.value;
        break;
      case 'passive_skill_cool_time_reset':
        if (n(s.definition.CategoryType) === SkillCategoryType.Passive) s.cooldown = 0;
        break;
      default:
        break;
    }
  }
  target.revision++;
  return spec.value;
}

function applyStatusMutation(e: Simulation, source: Actor, target: Actor, skill: SkillState, spec: EffectSpec): number {
  const longest = new Map<number, StatusInstance>();
  if (spec.operation === 'strength_effect_value_increase') {
    for (const s of target.effects) {
      if (e.isStrength(s.spec.status)) {
        const old = longest.get(s.spec.status);
        if (old === undefined || old.remaining < s.remaining) longest.set(s.spec.status, s);
      }
    }
  }
  const kept: StatusInstance[] = [];
  for (const s of target.effects) {
    let remove = false;
    switch (spec.operation) {
      case 'weakness_effect_recovery':
        remove = e.isWeakness(s.spec.status);
        break;
      case 'weakness_effect_inversion':
        if (e.isWeakness(s.spec.status)) {
          switch (s.spec.status) {
            case StatusEffectType.DanceDown:
              s.spec.status = StatusEffectType.DanceUp;
              s.spec.typ = SkillEfficacyType.DanceUp;
              break;
            case StatusEffectType.VocalDown:
              s.spec.status = StatusEffectType.VocalUp;
              s.spec.typ = SkillEfficacyType.VocalUp;
              break;
            case StatusEffectType.VisualDown:
              s.spec.status = StatusEffectType.VisualUp;
              s.spec.typ = SkillEfficacyType.VisualUp;
              break;
            case StatusEffectType.StaminaConsumptionIncrease:
              s.spec.status = StatusEffectType.StaminaConsumptionReduction;
              s.spec.typ = SkillEfficacyType.StaminaConsumptionReduction;
              break;
            case StatusEffectType.SkillImpossible:
              for (const sk of target.skills) {
                sk.cooldown = Math.max(0, sk.cooldown - s.remaining);
              }
              remove = true;
              break;
            default:
              remove = true;
              break;
          }
        }
        break;
      case 'strength_effect_count_increase':
        if (e.isStrength(s.spec.status)) s.remaining += spec.value;
        break;
      case 'strength_effect_value_increase':
        if (longest.get(s.spec.status) === s) s.grade += spec.value;
        break;
      case 'strength_effect_value_decrease':
        if (e.isStrength(s.spec.status)) {
          s.grade = Math.max(0, s.grade - spec.value);
          remove = s.grade === 0;
        }
        break;
      case 'strength_effect_erasing_all':
        remove = e.isStrength(s.spec.status);
        break;
      case 'strength_effect_erasing':
        remove = s.spec.status === spec.secondary;
        break;
      case 'status_effect_change':
        if (s.spec.status === spec.status) {
          s.spec.status = spec.secondary;
          s.spec.cap = spec.cap;
          s.spec.limitCap = spec.limitCap;
          s.spec.typ = statusEfficacy(spec.secondary);
        }
        break;
      default:
        break;
    }
    if (!remove) kept.push(s);
  }
  target.effects = kept;
  target.revision++;
  return spec.value;
}

const effectHandlers = new Map<string, EffectHandler>([
  ['status', applyStatus],
  ['fix_stamina_recovery', applyRecovery],
  ['target_stamina_recovery', applyRecovery],
  ['stamina_consumption', applyDrain],
  ['weakness_effect_recovery', applyStatusMutation],
  ['weakness_effect_inversion', applyStatusMutation],
  ['strength_effect_count_increase', applyStatusMutation],
  ['strength_effect_value_increase', applyStatusMutation],
  ['strength_effect_value_decrease', applyStatusMutation],
  ['strength_effect_erasing', applyStatusMutation],
  ['strength_effect_erasing_all', applyStatusMutation],
  ['status_effect_change', applyStatusMutation],
  ['cool_time_reduction', applyCooldown],
  ['cool_time_increase', applyCooldown],
  ['passive_skill_cool_time_reset', applyCooldown],
  ['live_ability_cool_time_reduction', applyCooldown],
  ['strength_effect_migration_before_active_skill', (e, source, target, skill, spec) => e.applyMigration(source, target, skill, spec)],
  ['strength_effect_migration_before_special_skill', (e, source, target, skill, spec) => e.applyMigration(source, target, skill, spec)],
]);

export function effectsMethods() {
  return {
    recoveryWeight(this: Simulation): number {
      const v = n(this.input.Quest.StaminaRecoveryWeightPermil);
      if (v === 0) return 1000;
      return v;
    },

    executeEffects(this: Simulation, source: Actor, skill: SkillState, critical: boolean): { details: LiveSkillDetail[]; total: number; matched: boolean } {
      const details: LiveSkillDetail[] = [];
      let total = 0;
      let matched = false;
      const triggerActor = this.event.triggerActor;
      const triggerActors = this.event.triggerActors;
      for (let i = 0; i < skill.effects.length; i++) {
        const eff = skill.effects[i];
        const bound = this.matchTrigger(eff.trigger, source);
        if (!bound.matched) continue;
        matched = true;
        this.event.triggerActor = triggerActor;
        this.event.triggerActors = triggerActors;
        if (eff.trigger.kind !== SkillTriggerType.Unknown) {
          this.event.triggerActors = bound.actors;
          this.event.triggerActor = bound.actors.length > 0 ? bound.actors[0] : null;
        }
        const detail: LiveSkillDetail = { EfficacyIndex: i + 1, StatusType: eff.status, EffectiveChartCount: eff.duration };
        if (hasPrefix(eff.operation, 'score_get')) {
          const value = this.skillScore(source, skill, eff, critical);
          detail.Value = value;
          if (value > 0 && total > Number.MAX_SAFE_INTEGER - value) {
            this.err = new Error('live skill score overflow');
          } else {
            total += value;
          }
        } else if (eff.typ === SkillEfficacyType.StrengthEffectAssignment || eff.typ === SkillEfficacyType.StrengthEffectAssignmentAll) {
          // Transfer is one operation over the complete target set. Executing
          // it per target would consume the source before the second recipient.
          const targets = this.targets(eff.target, source);
          this.transferStatuses(source, targets, skill, eff);
          for (const target of targets) {
            detail.TargetCardIndexes = (detail.TargetCardIndexes ?? []).concat([target.index]);
            detail.TargetCardInfos = (detail.TargetCardInfos ?? []).concat([{ TargetCardIndex: target.index }]);
          }
        } else {
          const handler = effectHandlers.get(eff.operation);
          if (handler === undefined) {
            this.err = unsupported(eff.id, 'no effect executor');
            return { details: [], total: 0, matched: false };
          }
          const seen = new Set<number>();
          let targets = this.targets(eff.target, source);
          if (eff.operation === 'live_ability_cool_time_reduction') {
            targets = [];
            for (const a of this.actors) {
              if (a.synthetic && a.side === source.side) targets.push(a);
            }
          }
          for (const candidate of targets) {
            const target = this.redirectWeakness(source, candidate, eff);
            if (target === null || seen.has(target.index)) continue;
            seen.add(target.index);
            const value = handler(this, source, target, skill, eff);
            detail.TargetCardIndexes = (detail.TargetCardIndexes ?? []).concat([target.index]);
            const info: LiveSkillDetailTargetCardInfo = { TargetCardIndex: target.index, Value: value };
            detail.TargetCardInfos = (detail.TargetCardInfos ?? []).concat([info]);
            if (eff.operation !== 'status') detail.Value = value;
          }
        }
        details.push(detail);
      }
      this.event.triggerActor = triggerActor;
      this.event.triggerActors = triggerActors;
      return { details, total, matched };
    },

    redirectWeakness(this: Simulation, source: Actor, target: Actor | null, eff: EffectSpec): Actor | null {
      const weak =
        this.isWeakness(eff.status) ||
        eff.operation === 'stamina_consumption' ||
        eff.operation === 'cool_time_increase' ||
        eff.operation === 'strength_effect_value_decrease' ||
        hasPrefix(eff.operation, 'strength_effect_erasing');
      if (!weak) return target;
      // Inferred precedence: cover, then one reflection, then timed-debuff
      // prevention. Redirect at most once to avoid reflect/cover recursion cycles.
      if (target !== null && source.side !== target.side) {
        for (const other of this.actors) {
          if (!other.synthetic && other.side === target.side && other !== target && this.grade(other, StatusEffectType.CoverWeaknessEffect) > 0) {
            target = other;
            break;
          }
        }
        if (target !== null && this.grade(target, StatusEffectType.WeaknessEffectReflection) > 0) {
          target = source;
        }
      }
      if (target !== null && eff.operation === 'status' && this.isWeakness(eff.status) && this.grade(target, StatusEffectType.WeaknessEffectPrevention) > 0) {
        return null;
      }
      return target;
    },

    transferStatuses(this: Simulation, source: Actor, targets: Actor[], skill: SkillState, spec: EffectSpec): void {
      if (targets.length === 0) return;
      const selected = (s: StatusInstance): boolean =>
        this.isStrength(s.spec.status) &&
        (spec.typ === SkillEfficacyType.StrengthEffectAssignmentAll || s.spec.status === spec.secondary);
      const moved: StatusInstance[] = [];
      for (const s of source.effects) {
        if (selected(s)) moved.push(s);
      }
      if (moved.length === 0) return;
      let keepSource = false;
      for (const target of targets) {
        if (target === source) {
          // A self-only transfer remains a no-op. When the source is one of
          // several recipients, retain its original instance just once.
          keepSource = true;
          continue;
        }
        if (target.effects.length + target.migrations.length + moved.length > this.maxStatusInstances) {
          this.err = new Error('too many transferred live statuses');
          return;
        }
      }
      // Validate every recipient before modifying any actor. A rejected fan-out
      // must not partially consume the source or update earlier recipients.
      for (const target of targets) {
        if (target === source) continue;
        for (const s of moved) {
          // Stages and lifetime already include photo modifiers; preserve them
          // without applying modifiers again. Each recipient needs its own
          // mutable instance for expiry, conversion and migration.
          const copy: StatusInstance = { ...s, spec: { ...s.spec } };
          copy.source = source.index;
          copy.skill = n(skill.ref.Index);
          target.effects.push(copy);
        }
        target.revision++;
      }
      if (!keepSource) {
        const kept: StatusInstance[] = [];
        for (const s of source.effects) {
          if (!selected(s)) kept.push(s);
        }
        source.effects = kept;
        source.revision++;
      }
    },
  };
}
