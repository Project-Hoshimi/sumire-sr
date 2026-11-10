// Ported from Solis internal/makino/live/migration.go.
//
// Migration relocates effects in time, not between idols. A recipient's
// strengths are suspended with their remaining lifetime until its next A/SP
// opportunity, including a transferred chance received from another lane.

import { SkillCategoryType, SkillEfficacyType } from './enums.ts';
import type { Actor, Simulation } from './engine.ts';
import type { EffectSpec, SkillState } from './compile.ts';
import type { StatusInstance } from './status.ts';
import { n } from './util.ts';

export interface StatusMigration {
  category: number;
  effect: StatusInstance;
}

export function migrationMethods() {
  return {
    applyMigration(this: Simulation, source: Actor, target: Actor, skill: SkillState, spec: EffectSpec): number {
      let category: number = SkillCategoryType.Active;
      if (spec.typ === SkillEfficacyType.StrengthEffectMigrationBeforeSpecialSkill) {
        category = SkillCategoryType.Special;
      }
      const kept: StatusInstance[] = [];
      for (const effect of target.effects) {
        if (this.isStrength(effect.spec.status)) {
          // Restored provenance belongs to the relocation skill, not the
          // original applicator (Quest64, charts 67 -> 81/107).
          effect.source = source.index;
          effect.skill = n(skill.ref.Index);
          target.migrations.push({ category, effect });
        } else {
          kept.push(effect);
        }
      }
      target.effects = kept;
      target.revision++;
      return 0;
    },

    restoreMigratedStatuses(this: Simulation, a: Actor, category: number): void {
      const kept: StatusMigration[] = [];
      for (const migration of a.migrations) {
        if (migration.category !== category) {
          kept.push(migration);
          continue;
        }
        if (a.effects.length >= this.maxStatusInstances) {
          this.err = new Error('too many restored live statuses');
          return;
        }
        a.effects.push(migration.effect);
        a.revision++;
      }
      a.migrations = kept;
    },

    /** Checks eligibility after pending effects return, without consuming it. */
    migrationPreview(this: Simulation, a: Actor, category: number): Actor {
      let count = 0;
      for (const migration of a.migrations) {
        if (migration.category === category) count++;
      }
      if (count === 0) return a;
      const preview: Actor = { ...a };
      preview.effects = a.effects.slice();
      preview.summary = null;
      for (const migration of a.migrations) {
        if (migration.category === category) preview.effects.push(migration.effect);
      }
      return preview;
    },
  };
}
