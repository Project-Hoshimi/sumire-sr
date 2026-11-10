// Ported from Solis internal/makino/live/selectors.go.
//
// Skill triggers, target selection and lane helpers shared by the engine.

import { AttributeType, MusicChartType, SkillCategoryType, SkillTargetType, SkillTriggerType, StatusEffectType } from './enums.ts';
import type { Actor, Simulation } from './engine.ts';
import type { TargetSpec, TriggerSpec } from './compile.ts';
import { n, snakeName, trimPrefix } from './util.ts';

export function lanePriority(position: number): number {
  return position - 1;
}

/**
 * Official positions are center-first, not left-to-right: 4, 2, 1, 3, 5.
 * Target and tie priority still follows the official numeric lane number.
 */
export function laneVisualIndex(position: number): number {
  switch (position) {
    case 4:
      return 0;
    case 2:
      return 1;
    case 1:
      return 2;
    case 3:
      return 3;
    case 5:
      return 4;
    default:
      return -1;
  }
}

export function lanesAreNeighbors(a: number, b: number): boolean {
  const left = laneVisualIndex(a);
  const right = laneVisualIndex(b);
  return left >= 0 && right >= 0 && (left === right - 1 || left === right + 1);
}

export function actorBefore(a: Actor, b: Actor): boolean {
  if (a.side !== b.side) return a.side < b.side;
  return lanePriority(a.position) < lanePriority(b.position);
}

export function containsString(values: string[], value: string): boolean {
  for (const v of values) {
    if (v === value) return true;
  }
  return false;
}

export interface MatchResult {
  matched: boolean;
  actor: Actor | null;
}

function noMatch(): MatchResult {
  return { matched: false, actor: null };
}

export function selectorMethods() {
  return {
    coreFanRatio(this: Simulation, a: Actor): number {
      const total = a.data.LightFans + a.data.MiddleFans + a.data.HeavyFans;
      if (total <= 0) return 0;
      return (a.data.MiddleFans + a.data.HeavyFans) / total;
    },

    hasWeakness(this: Simulation, a: Actor): boolean {
      for (const s of a.effects) {
        if (this.isWeakness(s.spec.status)) return true;
      }
      return false;
    },

    isWeakness(this: Simulation, status: number): boolean {
      return this.weaknessTypes.has(status);
    },

    isStrength(this: Simulation, status: number): boolean {
      return this.strengthTypes.has(status);
    },

    matches(this: Simulation, t: TriggerSpec, source: Actor): MatchResult {
      const self = (ok: boolean): MatchResult => ({ matched: ok, actor: source });
      const someone = (predicate: (actor: Actor) => boolean): MatchResult => {
        for (const a of this.actors) {
          if (!a.synthetic && a.side === source.side && predicate(a)) return { matched: true, actor: a };
        }
        return noMatch();
      };
      const combo = this.sides[source.side].combo;
      switch (t.kind) {
        case SkillTriggerType.Unknown:
          return self(true);
        case SkillTriggerType.Beat:
          return self(this.event.chart !== null);
        case SkillTriggerType.LiveStart:
          return self(this.event.chart === null);
        case SkillTriggerType.Combo:
          return self(combo >= t.value);
        case SkillTriggerType.MoreThanCharacterCount: {
          let count = 0;
          for (const a of this.actors) {
            if (!a.synthetic && a.side === source.side && containsString(t.characters, a.data.CharacterID)) count++;
          }
          return self(count >= t.value);
        }
        case SkillTriggerType.BeforeActiveSkillBySomeone:
        case SkillTriggerType.BeforeSpecialSkillBySomeone:
        case SkillTriggerType.BeforeSpecialSkill: {
          let kind: number = MusicChartType.ActiveSkill;
          if (t.kind === SkillTriggerType.BeforeSpecialSkillBySomeone || t.kind === SkillTriggerType.BeforeSpecialSkill) {
            kind = MusicChartType.SpecialSkill;
          }
          let ok =
            n(this.event.chart?.Type) === kind &&
            this.event.winner !== null &&
            this.event.winner.side === source.side &&
            !this.event.activeResolved;
          if (t.kind === SkillTriggerType.BeforeSpecialSkill) {
            ok = ok && this.event.winner === source;
          }
          return { matched: ok, actor: this.event.winner };
        }
        case SkillTriggerType.BeforeCritical:
          return self(this.event.critical.has(source.index) && !this.event.activeResolved);
        case SkillTriggerType.BeforeCriticalBySomeone:
          return someone((a) => this.event.critical.has(a.index) && !this.event.activeResolved);
        case SkillTriggerType.Critical:
          return self(this.event.critical.has(source.index) && this.event.activeResolved);
        case SkillTriggerType.Status:
          return self(this.grade(source, t.status) > 0);
        case SkillTriggerType.SomeoneStatus:
          return someone((a) => this.grade(a, t.status) > 0);
        case SkillTriggerType.StaminaLower:
          return self(n(source.card.Stamina) > 0 && source.stamina * 100 <= n(source.card.Stamina) * t.value);
        case SkillTriggerType.StaminaHigher:
          return self(n(source.card.Stamina) > 0 && source.stamina * 100 >= n(source.card.Stamina) * t.value);
        case SkillTriggerType.SomeoneStaminaLower:
          return someone((a) => a.stamina * 100 <= n(a.card.Stamina) * t.value);
        case SkillTriggerType.FanEngageHigher:
          return self(this.coreFanRatio(source) * 100 >= t.value);
        case SkillTriggerType.Center:
          return self(source.position === 1);
        case SkillTriggerType.MoodType: {
          const mood = snakeName(trimPrefix(this.moodName(), 'MoodType_'));
          return self(mood === t.text);
        }
        case SkillTriggerType.Music:
          return self((this.input.Quest.MusicId ?? '') === t.text);
        case SkillTriggerType.StatusGroup:
          return self(this.hasWeakness(source));
        case SkillTriggerType.SomeoneStatusGroup:
          return someone((a) => this.hasWeakness(a));
        case SkillTriggerType.PositionAttributeVocal:
          return self(this.laneAttribute(source.position) === AttributeType.Vocal);
        case SkillTriggerType.PositionAttributeDance:
          return self(this.laneAttribute(source.position) === AttributeType.Dance);
        case SkillTriggerType.PositionAttributeVisual:
          return self(this.laneAttribute(source.position) === AttributeType.Visual);
        case SkillTriggerType.SomeoneRecovered:
          return someone((a) => this.event.recovered.has(a.index));
        case SkillTriggerType.MostLeft:
          return self(source.position === 4);
        case SkillTriggerType.MostRight:
          return self(source.position === 5);
        case SkillTriggerType.ComboLessEqual:
          return self(combo <= t.value);
        case SkillTriggerType.SomeoneStatusEffectGradeHigher:
          return someone((a) => this.grade(a, t.status) >= t.value);
        case SkillTriggerType.AfterActiveSkillByOpponentSomeone:
          for (const [index, category] of this.event.activated) {
            const a = this.byIndex.get(index);
            if (a !== undefined && a.side !== source.side && category === SkillCategoryType.Active) {
              return { matched: true, actor: a };
            }
          }
          return noMatch();
        default:
          // Compilation rejects every other trigger type.
          return noMatch();
      }
    },

    /**
     * Retains every qualifying actor for target-trigger-N; the scalar matcher
     * above stays allocation-free for pure condition checks.
     */
    matchTrigger(this: Simulation, t: TriggerSpec, source: Actor): { matched: boolean; actors: Actor[] } {
      const ok = this.matches(t, source);
      if (!ok.matched) return { matched: false, actors: [] };
      const first = ok.actor;
      let predicate: ((actor: Actor) => boolean) | undefined;
      switch (t.kind) {
        case SkillTriggerType.BeforeCriticalBySomeone:
          predicate = (a) => this.event.critical.has(a.index) && !this.event.activeResolved;
          break;
        case SkillTriggerType.SomeoneStatus:
          predicate = (a) => this.grade(a, t.status) > 0;
          break;
        case SkillTriggerType.SomeoneStaminaLower:
          predicate = (a) => a.stamina * 100 <= n(a.card.Stamina) * t.value;
          break;
        case SkillTriggerType.SomeoneStatusGroup:
          predicate = (a) => this.hasWeakness(a);
          break;
        case SkillTriggerType.SomeoneRecovered:
          predicate = (a) => this.event.recovered.has(a.index);
          break;
        case SkillTriggerType.SomeoneStatusEffectGradeHigher:
          predicate = (a) => this.grade(a, t.status) >= t.value;
          break;
        default:
          break;
      }
      if (predicate === undefined) {
        if (first === null) return { matched: true, actors: [] };
        return { matched: true, actors: [first] };
      }
      const actors: Actor[] = [];
      for (const a of this.actors) {
        if (!a.synthetic && a.side === source.side && predicate(a)) actors.push(a);
      }
      return { matched: actors.length > 0, actors };
    },

    targets(this: Simulation, t: TargetSpec, source: Actor): Actor[] {
      let side = source.side;
      if (t.opponent) side = 1 - side;
      const candidates: Actor[] = [];
      for (const a of this.actors) {
        if (a.synthetic || (t.kind !== SkillTargetType.Trigger && a.side !== side)) continue;
        let ok = true;
        switch (t.kind) {
          case SkillTargetType.Self:
            ok = a === source;
            break;
          case SkillTargetType.Center:
          case SkillTargetType.OpponentCenter:
            ok = a.position === 1;
            break;
          case SkillTargetType.Status:
            ok = this.grade(a, t.status) > 0;
            break;
          case SkillTargetType.Trigger:
            ok = false;
            for (const bound of this.event.triggerActors) {
              if (a === bound) {
                ok = true;
                break;
              }
            }
            if (this.event.triggerActors.length === 0) {
              ok = this.event.triggerActor !== null && a === this.event.triggerActor;
            }
            break;
          case SkillTargetType.CardType:
          case SkillTargetType.OpponentCardType:
            ok = a.data.Type === t.value;
            break;
          case SkillTargetType.Neighbor:
            ok = lanesAreNeighbors(a.position, source.position);
            break;
          case SkillTargetType.Vocal:
          case SkillTargetType.OpponentVocal:
            ok = a.data.Attribute === AttributeType.Vocal;
            break;
          case SkillTargetType.Dance:
          case SkillTargetType.OpponentDance:
            ok = a.data.Attribute === AttributeType.Dance;
            break;
          case SkillTargetType.Visual:
          case SkillTargetType.OpponentVisual:
            ok = a.data.Attribute === AttributeType.Visual;
            break;
          case SkillTargetType.PositionAttributeVocal:
            ok = this.laneAttribute(a.position) === AttributeType.Vocal;
            break;
          case SkillTargetType.PositionAttributeDance:
          case SkillTargetType.OpponentPositionAttributeDance:
            ok = this.laneAttribute(a.position) === AttributeType.Dance;
            break;
          case SkillTargetType.PositionAttributeVisual:
            ok = this.laneAttribute(a.position) === AttributeType.Visual;
            break;
          case SkillTargetType.OpponentSamePosition:
            ok = a.position === source.position;
            break;
          case SkillTargetType.StaminaMoreThanEqual:
            ok = a.stamina * 100 >= n(a.card.Stamina) * t.value;
            break;
          case SkillTargetType.OpponentStaminaLessThanEqual:
            ok = a.stamina * 100 <= n(a.card.Stamina) * t.value;
            break;
          default:
            break;
        }
        if (ok) candidates.push(a);
      }
      candidates.sort((left, right) => (actorBefore(left, right) ? -1 : actorBefore(right, left) ? 1 : 0));
      let value: ((a: Actor) => bigint) | undefined;
      switch (t.kind) {
        case SkillTargetType.DanceHigher:
          value = (a) => BigInt(this.attribute(a, AttributeType.Dance));
          break;
        case SkillTargetType.VocalHigher:
          value = (a) => BigInt(this.attribute(a, AttributeType.Vocal));
          break;
        case SkillTargetType.VisualHigher:
          value = (a) => BigInt(this.attribute(a, AttributeType.Visual));
          break;
        // int64 division is reproduced with BigInt: stamina*1e6 exceeds 2^53.
        case SkillTargetType.StaminaHigher:
          value = (a) => (BigInt(a.stamina) * 1000000n) / BigInt(n(a.card.Stamina));
          break;
        case SkillTargetType.StaminaLower:
          value = (a) => (-BigInt(a.stamina) * 1000000n) / BigInt(n(a.card.Stamina));
          break;
        default:
          break;
      }
      if (value !== undefined) {
        const fn = value;
        candidates.sort((left, right) => {
          const lv = fn(left);
          const rv = fn(right);
          if (lv > rv) return -1;
          if (lv < rv) return 1;
          return 0;
        });
      }
      if (candidates.length > t.count) return candidates.slice(0, t.count);
      return candidates;
    },
  };
}
