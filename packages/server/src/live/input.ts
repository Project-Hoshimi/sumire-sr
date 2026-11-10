// Ported from Solis internal/makino/live/input.go.

import type {
  LiveUserInfo,
  MusicChartPattern,
  Quest,
  QuestAudienceAdvantage,
  QuestPressure,
  ComboAdvantage,
  QuestStaminaConsumption,
  Setting,
  Skill,
  SkillEfficacy,
  SkillTarget,
  SkillTrigger,
} from './types.ts';

export const RULESET_VERSION = 'live-v5';

/** Scoring identity of a card, independent of any visual replacement idol. */
export interface CardData {
  Bonuses: Map<number, number>;
  StrengthModifiers: StrengthModifier[];
  CharacterID: string;
  GroupID: string;
  Type: number;
  Attribute: number;
  LightFans: number;
  MiddleFans: number;
  HeavyFans: number;
  /** Scales the multiplied score, never prepared attributes or fixed additions. */
  CharacterAdvantagePermil: number;
}

/** A photo's status restriction; must not be flattened into Bonuses. */
export interface StrengthModifier {
  Type: number;
  StatusTypes: number[];
  Amount: number;
}

/**
 * Fully resolved simulation input. `simulate` clones the mutable user/deck
 * state it touches; master rows are treated as immutable and never modified.
 */
export interface Input {
  Quest: Quest;
  Setting: Setting;
  Chart: MusicChartPattern[];
  Pressure: QuestPressure;
  AudienceAdvantages: QuestAudienceAdvantage[];
  ComboAdvantages: ComboAdvantage[];
  StaminaConsumption: QuestStaminaConsumption[];
  Users: LiveUserInfo[];
  Cards: Map<number, CardData>;
  Skills: Map<string, Skill>;
  Efficacies: Map<string, SkillEfficacy>;
  Triggers: Map<string, SkillTrigger>;
  Targets: Map<string, SkillTarget>;
  Seed: bigint;
  /** Exercise captures have no unbuffed criticals; CriticalRateUp still applies. */
  DisableBaseCriticalRate?: boolean;
  /** Zero derives the coefficient from `Chart` at initialization. */
  BeatScoreCoefficientPermil?: number;
}
