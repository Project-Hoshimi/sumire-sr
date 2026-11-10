// Ported from Solis internal/makino/live/descriptions.go.
//
// Captured Start descriptions are empty. These compact Japanese messages are
// private-server explanations of the actual trace, not reproduced official prose.
// Logging reads existing outcomes and never rolls RNG or re-evaluates effects.

import { SkillEfficacyType, SkillFailureType, StatusEffectType } from './enums.ts';
import type { Actor, Simulation } from './engine.ts';
import type { SkillState } from './compile.ts';
import type { LiveLogDescription, LiveSkill, LiveSkillFailure } from './types.ts';
import { enumString } from './statusNames.ts';
import { hasPrefix, n, s } from './util.ts';

function failureLabel(reason: number): string {
  switch (reason) {
    case SkillFailureType.StaminaShortage:
      return 'スタミナ不足';
    case SkillFailureType.InCoolTime:
      return 'CT中';
    case SkillFailureType.NoRemainingCount:
      return '発動回数なし';
    case SkillFailureType.CategoryMismatch:
      return '対応スキルなし';
    case SkillFailureType.InSkillImpossibleEffect:
      return '発動不可状態';
    case SkillFailureType.OpponentActivation:
      return '相手が発動権を獲得';
    case SkillFailureType.Miss:
      return '発動確率判定に失敗';
    case SkillFailureType.AllSkillEfficacyTriggerFail:
      return '効果条件未成立';
    default:
      return enumString(SkillFailureType, 'SkillFailureType_', reason);
  }
}

export function descriptionMethods() {
  return {
    skillLabel(this: Simulation, a: Actor, skill: SkillState): string {
      let name = s(skill.definition.Name);
      if (name === '') name = s(skill.ref.SkillId);
      return `位置${a.index} ${name}`;
    },

    failureDescriptions(this: Simulation, rows: LiveSkillFailure[]): LiveLogDescription[] {
      const out: LiveLogDescription[] = [];
      for (const row of rows) {
        let reason = failureLabel(n(row.Type));
        const each = row.EachFailureTypes ?? [];
        if (each.length > 1) {
          const labels: string[] = [];
          const seen = new Set<number>();
          for (const t of each) {
            if (seen.has(t)) continue;
            seen.add(t);
            labels.push(failureLabel(t));
          }
          reason = labels.join(' / ');
        }
        out.push({ Message: `位置${n(row.CardIndex)}: ${reason}（消費なし）` });
      }
      return out;
    },

    skillDescriptions(this: Simulation, a: Actor, skill: SkillState, result: LiveSkill): LiveLogDescription[] {
      if (result.Activated !== true) {
        if ((result.Failures?.length ?? 0) > 0) {
          return this.failureDescriptions(result.Failures ?? []);
        }
        return [{ Message: `${this.skillLabel(a, skill)}: 発動しませんでした（消費なし）` }];
      }
      const out: LiveLogDescription[] = [];
      const critical = result.IsCritical === true ? ' / クリティカル' : '';
      out.push({
        Message: `${this.skillLabel(a, skill)}: 発動 / 消費スタミナ${n(result.Stamina)} / スコア${n(result.Score)}${critical}`,
      });
      for (const detail of result.Details ?? []) {
        const index = n(detail.EfficacyIndex);
        if (index < 1 || index > skill.effects.length) continue;
        const eff = skill.effects[index - 1];
        let name = s(this.input.Efficacies.get(eff.id)?.Name);
        if (name === '') name = enumString(SkillEfficacyType, 'SkillEfficacyType_', eff.typ);
        const indexes = detail.TargetCardIndexes ?? [];
        let targets = indexes.map((v) => String(v)).join(',');
        if (indexes.length === 0) {
          targets = hasPrefix(eff.operation, 'score_get') ? '自身' : 'なし';
        }
        let message = `${name} / 対象:${targets} / 値:${n(detail.Value)}`;
        if (n(detail.StatusType) !== StatusEffectType.Unknown) {
          message += ` / ${enumString(StatusEffectType, 'StatusEffectType_', n(detail.StatusType))} / 基本${eff.grade}段階 / 基本${n(detail.EffectiveChartCount)}ビート`;
        }
        out.push({ Message: message });
      }
      return out;
    },
  };
}
