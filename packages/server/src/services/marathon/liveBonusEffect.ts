/**
 * Owned marathon live bonuses as live-scoring effects.
 *
 * A `MarathonLiveBonus` master row points at one `LiveAbility` level
 * (`LiveAbilityId` + `LiveAbilityLevel`). Every owned copy (`Amount`) stacks the
 * level's `Value`, so a marathon live bonus behaves like the same card-level
 * live ability. Resolution is pure: the caller loads the master rows and passes
 * a synchronous `lookup`.
 *
 * Application is not done here: the effects are handed to `prepareLiveInput`
 * (`extraDeckBonuses` in `../liveInput.ts`), which routes them into every
 * player deck card's `Bonuses` exactly like the card's own live ability
 * (`prepareOwnedLiveAbilities` / `LIVE_ABILITY_PHOTO`) and before the card stat
 * pass, so parameter types 1-12 change card attributes. Types that routing does
 * not support (equipment boosts, unknown ids) are skipped there instead of
 * failing the live.
 *
 * Passive skills (type 13) are deck-level event bonuses rather than per-card
 * possessions: `marathonPassiveEffects` resolves them to `extraBonusSkills`,
 * which `prepareLiveInput` appends to the player's `UserDeck.BonusSkills` one
 * entry per owned copy (the engine's synthetic stage-bonus actor), after the
 * quest live bonuses and only for the player side.
 *
 * `MarathonLiveBonus.PowerPermil` has no consumer in the live engine (the
 * passive path reads only `SkillId` and the skill level), so it is not applied.
 */
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import type { LiveBonusSkillEffect, LiveDeckBonusEffect } from '../liveInput.ts';

export type MarathonOwnedLiveBonus = { LiveBonusId: string; Amount: number };

export type MarathonBonusEffect = LiveDeckBonusEffect;

export type MarathonDeckPassive = LiveBonusSkillEffect;

/** Wire `LiveAbility.Type` for a passive skill (matches `liveInput.ts`). */
const PASSIVE_SKILL_TYPE = 13;

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

/**
 * One selected `LiveAbility.Levels` row, reduced to the fields the live input
 * reads: `Type` routes the effect, `Value` is the bonus amount or the passive
 * skill level, `Level` is the row's level (passed on as `LiveAbilityLevel`) and
 * `SkillId` identifies the passive skill of a type-13 row.
 */
export type MarathonLiveAbilityLevel = {
  type: number;
  value: number;
  level: number;
  skillId: string;
  /**
   * `LiveAbility.Id` of the resolved row, filled in by the caller that loaded
   * the master row (a level row does not carry its parent id). Passed on as the
   * passive entry's `LiveAbilityId`, like an owned live ability does.
   */
  liveAbilityId?: string;
};

/**
 * Pick the `LiveAbility.Levels` entry whose `Level` matches the
 * `MarathonLiveBonus.LiveAbilityLevel` and keep the fields the passive and
 * bonus paths read.
 */
export function marathonLiveAbilityLevel(
  levels: readonly Decoded[] | null | undefined,
  level: number,
): MarathonLiveAbilityLevel | undefined {
  for (const candidate of levels ?? []) {
    if (n(candidate.Level) === level) {
      return {
        type: n(candidate.Type),
        value: n(candidate.Value),
        level: n(candidate.Level),
        skillId: s(candidate.SkillId),
      };
    }
  }
  return undefined;
}

/**
 * Resolve owned marathon live bonuses to live effects. `lookup` resolves one
 * owned bonus id to its already level-selected row (`marathonLiveAbilityLevel`),
 * or `undefined` when the id is unknown. Each copy multiplies the value by
 * `Amount`; effects of the same type are merged by summing. Passive skills
 * (type 13) are excluded here: they are not card bonus-map entries, see
 * `marathonPassiveEffects`.
 */
export function marathonBonusEffects(
  owned: readonly MarathonOwnedLiveBonus[],
  lookup: (id: string) => MarathonBonusEffect | undefined,
): MarathonBonusEffect[] {
  const merged = new Map<number, number>();
  for (const bonus of owned) {
    const amount = n(bonus.Amount);
    if (amount <= 0) continue;
    const effect = lookup(bonus.LiveBonusId);
    if (effect === undefined || effect.type === PASSIVE_SKILL_TYPE) continue;
    merged.set(effect.type, (merged.get(effect.type) ?? 0) + effect.value * amount);
  }
  return [...merged.entries()].map(([type, value]) => ({ type, value }));
}

/**
 * Resolve owned marathon passive skills (type 13) to deck bonus skills. Each
 * owned copy becomes one entry, so `Amount` N yields N identical skill
 * references. Copies resolving to the same skill id, level and live ability are
 * merged into one entry whose `amount` is the copy count; `addBonusSkillPassives`
 * expands it again.
 */
export function marathonPassiveEffects(
  owned: readonly MarathonOwnedLiveBonus[],
  lookup: (id: string) => MarathonLiveAbilityLevel | undefined,
): MarathonDeckPassive[] {
  const merged = new Map<string, MarathonDeckPassive>();
  for (const bonus of owned) {
    const amount = Math.trunc(n(bonus.Amount));
    if (amount <= 0) continue;
    const effect = lookup(bonus.LiveBonusId);
    if (effect === undefined || effect.type !== PASSIVE_SKILL_TYPE) continue;
    if (effect.skillId === '' || effect.value <= 0) continue;
    const key = `${effect.skillId}|${effect.value}|${effect.level}|${s(effect.liveAbilityId)}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        skillId: effect.skillId,
        skillLevel: effect.value,
        amount,
        liveAbilityId: s(effect.liveAbilityId),
        liveAbilityLevel: effect.level,
      });
      continue;
    }
    existing.amount += amount;
  }
  return [...merged.values()];
}
