// Ported from Solis internal/makino/live/skills.go.
//
// Active/special chances are resolved in lane order for both sides, then the
// higher authority acts first. Losing authority spends no stamina, cooldown or
// remaining uses.

import {
  MusicChartType,
  SkillCategoryType,
  SkillFailureType,
  SkillTriggerType,
  StatusEffectType,
} from './enums.ts';
import type { Actor, Simulation } from './engine.ts';
import type { SkillState } from './compile.ts';
import type { LiveLogDescription, LiveSkill, LiveSkillFailure } from './types.ts';
import { cooldownBonusForSlot } from './compile.ts';
import { n } from './util.ts';

export function skillFailureRow(index: number, reason: number): LiveSkillFailure {
  return { CardIndex: index, Type: reason, EachFailureTypes: [reason] };
}

export function isBeforeTrigger(kind: number): boolean {
  switch (kind) {
    case SkillTriggerType.BeforeActiveSkillBySomeone:
    case SkillTriggerType.BeforeSpecialSkillBySomeone:
    case SkillTriggerType.BeforeCritical:
    case SkillTriggerType.BeforeCriticalBySomeone:
    case SkillTriggerType.BeforeSpecialSkill:
      return true;
    default:
      return false;
  }
}

export function skillMethods() {
  return {
    skillFailure(this: Simulation, a: Actor, s: SkillState): number {
      if (n(s.definition.CategoryType) === SkillCategoryType.Passive && this.grade(a, StatusEffectType.PassiveSkillImpossible) > 0) {
        return SkillFailureType.InSkillImpossibleEffect;
      }
      if (n(s.definition.CategoryType) !== SkillCategoryType.Passive && this.grade(a, StatusEffectType.SkillImpossible) > 0) {
        return SkillFailureType.InSkillImpossibleEffect;
      }
      if (n(s.level.LimitCount) > 0 && s.remaining <= 0) return SkillFailureType.NoRemainingCount;
      if (s.cooldown > 0) return SkillFailureType.InCoolTime;
      if (!a.synthetic && a.stamina < this.staminaCost(a, s)) return SkillFailureType.StaminaShortage;
      return SkillFailureType.Unknown;
    },

    candidate(this: Simulation, a: Actor, category: number): { skill: SkillState | null; failure: LiveSkillFailure | null } {
      const each: number[] = [];
      for (const s of a.skills) {
        if (n(s.definition.CategoryType) !== category) continue;
        const reason = this.skillFailure(a, s);
        if (reason === SkillFailureType.Unknown) return { skill: s, failure: null };
        each.push(reason);
      }
      if (each.length === 0) return { skill: null, failure: skillFailureRow(a.index, SkillFailureType.CategoryMismatch) };
      return { skill: null, failure: { CardIndex: a.index, Type: each[0], EachFailureTypes: each } };
    },

    /** Lane opportunities for one chart row; returns only pre-selection failures. */
    selectActive(this: Simulation): LiveSkillFailure[] {
      let category: number = SkillCategoryType.Active;
      if (n(this.event.chart!.Type) === MusicChartType.SpecialSkill) category = SkillCategoryType.Special;
      const failures: LiveSkillFailure[] = [];
      this.event.candidates = [];
      const attribute = this.laneAttribute(n(this.event.chart!.Position));
      for (let side = 0; side < this.sides.length; side++) {
        let a = this.byIndex.get(side * 5 + n(this.event.chart!.Position));
        if (a === undefined) continue;
        // Inspect eligibility without giving a real opportunity to the source
        // or rejected alternatives. Only the final recipient restores.
        const preview = this.migrationPreview(a, category);
        if (category === SkillCategoryType.Active && this.grade(preview, StatusEffectType.ActiveSkillChanceAssignment) > 0) {
          const replacements: Actor[] = [];
          for (const other of this.actors) {
            if (!other.synthetic && other.side === side && other !== a) replacements.push(other);
          }
          // Round6 (notably run075, chart82): compare the attribute required by
          // this chance, not each recipient's own lane or battle authority.
          // Equal values retain ascending official lane order.
          replacements.sort((left, right) => {
            const lv = this.attribute(left, attribute);
            const rv = this.attribute(right, attribute);
            if (lv > rv) return -1;
            if (lv < rv) return 1;
            return left.position - right.position;
          });
          for (const other of replacements) {
            if (this.candidate(this.migrationPreview(other, category), category).skill !== null) {
              a = other;
              break;
            }
          }
        }
        // The user's clarified rule treats a transferred anchor as belonging to
        // the recipient all along; the source does not restore. Do not
        // recursively transfer a recipient's chance if it has assignment too.
        this.restoreMigratedStatuses(a, category);
        const picked = this.candidate(a, category);
        if (picked.skill === null) {
          if (picked.failure !== null) failures.push(picked.failure);
          continue;
        }
        // Migration follows the recipient, but the opportunity retains its
        // original required attribute for scoring and battle authority.
        this.event.candidates.push({ actor: a, skill: picked.skill, authority: this.authority(a, attribute) });
      }
      // Freeze authority before early passives. Exact ties retain the
      // attacking side (candidates stay in ascending lane order).
      if (this.event.candidates.length === 2 && this.event.candidates[1].authority > this.event.candidates[0].authority) {
        const first = this.event.candidates[0];
        this.event.candidates[0] = this.event.candidates[1];
        this.event.candidates[1] = first;
      }
      if (this.event.candidates.length > 0) {
        this.event.winner = this.event.candidates[0].actor;
        this.event.winningSkill = this.event.candidates[0].skill;
      }
      return failures;
    },

    breakCombo(this: Simulation, side: number): void {
      for (const a of this.actors) {
        if (!a.synthetic && a.side === side && this.grade(a, StatusEffectType.ComboContinuation) > 0) return;
      }
      this.sides[side].combo = 0;
    },

    activeSkill(this: Simulation, failures: LiveSkillFailure[]): LiveSkill {
      let attempted: LiveSkill | null = null;
      const failedDescriptions: LiveLogDescription[] = [];
      for (let i = 0; i < this.event.candidates.length; i++) {
        const candidate = this.event.candidates[i];
        const a = candidate.actor;
        const s = candidate.skill;
        this.event.winner = a;
        this.event.winningSkill = s;
        this.event.critical.set(a.index, this.event.criticalRolls.get(a.index) === true);
        const reason = this.skillFailure(a, s);
        if (reason !== SkillFailureType.Unknown) {
          failures.push(skillFailureRow(a.index, reason));
          this.breakCombo(a.side);
          this.event.critical.set(a.index, false);
          continue;
        }
        this.event.triggerActor = a;
        this.event.triggerActors = [a];
        const out = this.activate(a, s, true, this.event.critical.get(a.index) === true);
        attempted = out;
        if (out.Activated !== true) {
          failures.push(...(out.Failures ?? []));
          failedDescriptions.push(...(out.Descriptions ?? []));
          this.breakCombo(a.side);
          this.event.critical.set(a.index, false);
          continue;
        }
        // A lower-authority opposing candidate may activate if the first
        // attempt fails. Losing authority itself spends no stamina, cooldown or
        // uses.
        for (const loser of this.event.candidates.slice(i + 1)) {
          failures.push(skillFailureRow(loser.actor.index, SkillFailureType.OpponentActivation));
        }
        out.Failures = (out.Failures ?? []).concat(failures);
        out.Descriptions = this.failureDescriptions(failures).concat(out.Descriptions ?? []);
        this.incrementCombo(this.sides[a.side]);
        const result = this.sides[a.side].info.UserResult!;
        result.HitCount = n(result.HitCount) + 1;
        if (out.IsCritical === true) result.CriticalCount = n(result.CriticalCount) + 1;
        out.CardStatuses = this.cardSnapshots();
        out.UserStatuses = this.userSnapshots();
        return out;
      }
      const out: LiveSkill = { Order: this.nextOrder(), Failures: failures, IsComboBreak: true, Descriptions: failedDescriptions };
      // Single-side misses keep their attempted actor for the failure
      // animation; a battle with no winner uses the index-zero sentinel.
      if (this.sides.length === 1 && attempted !== null) {
        out.CardIndex = attempted.CardIndex;
        out.SkillIndex = attempted.SkillIndex;
      }
      for (let side = 0; side < this.sides.length; side++) this.breakCombo(side);
      this.event.winner = null;
      this.event.winningSkill = null;
      if ((out.Descriptions?.length ?? 0) === 0) out.Descriptions = this.failureDescriptions(failures);
      out.CardStatuses = this.cardSnapshots();
      out.UserStatuses = this.userSnapshots();
      return out;
    },

    activate(this: Simulation, a: Actor, s: SkillState, active: boolean, critical: boolean): LiveSkill {
      const out: LiveSkill = { Order: this.nextOrder(), CardIndex: a.index, SkillIndex: n(s.ref.Index) };
      s.usedEvent = this.event.ordinal;
      s.currentStaminaCost = 0;
      if (!active && this.rng.intN(1000) >= n(s.level.ProbabilityPermil)) {
        out.Descriptions = this.skillDescriptions(a, s, out);
        return out;
      }
      // User-confirmed: failed skills consume no stamina, cooldown or uses.
      if (active && this.rng.float64() >= Math.min(1, Math.max(0, this.successRate(a)))) {
        out.Failures = [skillFailureRow(a.index, SkillFailureType.Miss)];
        const result = this.sides[a.side].info.UserResult!;
        result.MissCount = n(result.MissCount) + 1;
        out.Descriptions = this.skillDescriptions(a, s, out);
        return out;
      }
      const beforeStamina = a.stamina;
      const beforeConsumed = a.consumed;
      const beforeCooldown = s.cooldown;
      const beforeRemaining = s.remaining;
      let cost = 0;
      if (!a.synthetic) {
        cost = this.staminaCost(a, s);
        this.changeStamina(a, -cost);
      }
      s.currentStaminaCost = cost;
      // Successful self-target cooldown effects must see this activation's new
      // cooldown. These provisional resources are restored if no detail executes.
      if (n(s.level.LimitCount) > 0) s.remaining--;
      const ctReduction = a.data.Bonuses.get(cooldownBonusForSlot(n(s.ref.Index))) ?? 0;
      s.cooldown = Math.max(0, n(s.level.CoolTime) - ctReduction);
      a.revision++;
      const executed = this.executeEffects(a, s, critical);
      out.Details = executed.details;
      out.Score = executed.total;
      if (!executed.matched) {
        // Detail predicates observe post-cost stamina. No effects were applied
        // if every predicate failed, so undo only this provisional debit.
        a.stamina = beforeStamina;
        a.consumed = beforeConsumed;
        s.cooldown = beforeCooldown;
        s.remaining = beforeRemaining;
        a.revision++;
        s.currentStaminaCost = 0;
        out.Failures = [skillFailureRow(a.index, SkillFailureType.AllSkillEfficacyTriggerFail)];
        out.Descriptions = this.skillDescriptions(a, s, out);
        return out;
      }
      out.Stamina = cost;
      out.Activated = true;
      out.IsCritical = critical;
      a.activations++;
      if (active) this.event.activated.set(a.index, n(s.definition.CategoryType));
      if (n(out.Score) > 0) this.addScore(a, n(out.Score));
      out.Descriptions = this.skillDescriptions(a, s, out);
      return out;
    },

    passives(this: Simulation, phase: string): LiveSkill[] {
      const out: LiveSkill[] = [];
      for (const a of this.passiveActors) {
        for (const s of a.skills) {
          if (n(s.definition.CategoryType) !== SkillCategoryType.Passive || s.usedEvent === this.event.ordinal) continue;
          const before = isBeforeTrigger(s.trigger.kind);
          if (phase === 'start' && s.trigger.kind !== SkillTriggerType.LiveStart) continue;
          if (phase !== 'start' && s.trigger.kind === SkillTriggerType.LiveStart) continue;
          if (phase === 'early' && s.trigger.kind !== SkillTriggerType.Unknown && !before) continue;
          if (phase === 'late' && before) continue;
          let quota = a.index * 10000 + n(s.ref.PossessionType);
          if (a.synthetic) quota = a.index * 10000 + n(s.ref.Index);
          if (this.event.budget.has(quota)) continue;
          const matches = this.matches(s.trigger, a);
          const reason = this.skillFailure(a, s);
          if (!matches.matched || reason !== SkillFailureType.Unknown) {
            if (phase === 'late' || before || phase === 'start') {
              const row: LiveSkill = { Order: this.nextOrder(), CardIndex: a.index, SkillIndex: n(s.ref.Index) };
              if (matches.matched) {
                row.Descriptions = this.failureDescriptions([skillFailureRow(a.index, reason)]);
              } else {
                row.Descriptions = [{ Message: this.skillLabel(a, s) + ': 発動条件未成立（消費なし）' }];
              }
              out.push(row);
              s.usedEvent = this.event.ordinal;
            }
            continue;
          }
          const bound = this.matchTrigger(s.trigger, a);
          this.event.triggerActors = bound.actors;
          this.event.triggerActor = null;
          if (bound.actors.length > 0) this.event.triggerActor = bound.actors[0];
          const skill = this.activate(a, s, false, false);
          if (skill.Activated === true) {
            this.event.budget.add(quota);
            skill.CardStatuses = this.cardSnapshots();
            skill.UserStatuses = this.userSnapshots();
          }
          out.push(skill);
        }
      }
      return out;
    },
  };
}
