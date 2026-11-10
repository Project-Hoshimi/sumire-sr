// Proto-shaped values used by the live simulator.
//
// Field names, casing and numbers mirror the generated wire shapes in
// fastify-api/src/gen/Solis_Common_Proto_Master_*.ts and
// fastify-api/src/gen/Solis_Common_Proto_Api_*.ts, so rows produced by
// runtime/proto.ts and by src/master/index.ts (drizzle: column names are the
// same PascalCase names) can be passed through unchanged.
//
// The codec omits zero-valued fields, and drizzle returns `null` for nullable
// columns, so every scalar here is optional/null-tolerant. The simulator reads
// them through `n()` / `s()` (see util.ts) which reproduce Go's zero values.
//
// int64 is a JS `number`: runtime/proto.ts decodes int64 into a number whenever
// the value fits in 2^53-1, and every live score/stamina value is far below it.

/** A master row from masterMusicChartPattern / pmaster.MusicChartPattern. */
export interface MusicChartPattern {
  Id?: string | null;
  Number?: number | null;
  Type?: number | null;
  Position?: number | null;
}

/** A master row from masterQuestPressure / pmaster.QuestPressure. */
export interface QuestPressure {
  Id?: string | null;
  Name?: string | null;
  WeightPermil?: number | null;
}

/** A master row from masterQuestAudienceAdvantage. */
export interface QuestAudienceAdvantage {
  Id?: string | null;
  AudienceAmount?: number | null;
  AdvantagePermil?: number | null;
}

/** A master row from masterComboAdvantage. */
export interface ComboAdvantage {
  Id?: string | null;
  ComboCount?: number | null;
  AdvantagePermil?: number | null;
}

/** A master row from masterQuestStaminaConsumption. */
export interface QuestStaminaConsumption {
  RemainStaminaRatioPercent?: number | null;
  SkillTargetParameterWeightPermil?: number | null;
}

/** A master row from masterQuestCharacterAdvantage. */
export interface QuestCharacterAdvantage {
  Id?: string | null;
  CharacterGroupId?: string | null;
  CharacterIds?: string[] | null;
  AdvantagePermil?: number | null;
}

/** A master row from masterPhotoAbilityTarget. */
export interface PhotoAbilityTarget {
  Id?: string | null;
  Type?: number | null;
  TargetId?: string | null;
}

/** A master row from masterQuest. */
export interface Quest {
  Id?: string | null;
  AreaId?: string | null;
  StageId?: string | null;
  MusicId?: string | null;
  DifficultyLevel?: number | null;
  Name?: string | null;
  Description?: string | null;
  Order?: number | null;
  MusicChartPatternId?: string | null;
  Position1AttributeType?: number | null;
  Position2AttributeType?: number | null;
  Position3AttributeType?: number | null;
  Position4AttributeType?: number | null;
  Position5AttributeType?: number | null;
  ActiveSkillWeightPermil?: number | null;
  SpecialSkillWeightPermil?: number | null;
  SkillStaminaWeightPermil?: number | null;
  StaminaRecoveryWeightPermil?: number | null;
  BeatDanceWeightPermil?: number | null;
  BeatVocalWeightPermil?: number | null;
  BeatVisualWeightPermil?: number | null;
  MaxCapacity?: number | null;
  MentalThreshold?: number | null;
  QuestPressureId?: string | null;
  QuestCharacterAdvantageId?: string | null;
  QuestAudienceAdvantageId?: string | null;
  MoodType?: number | null;
  ClearScore?: number | null;
  LiveBonusGroupId?: string | null;
}

/** A master row from masterSetting. */
export interface Setting {
  Id?: string | null;
  CardDefaultMental?: number | null;
  CardDefaultTechnique?: number | null;
  LiveLightFanAmountWeightPermil?: number | null;
  LiveMiddleFanAmountWeightPermil?: number | null;
  LiveHeavyFanAmountWeightPermil?: number | null;
  LiveMinimumGuaranteedAudienceAmount?: number | null;
  /** Bonus ceiling above 1000 permil for prepared attributes. */
  LiveMaxParameterBonusPermil?: number | null;
  /** Statuses treated as strengths (positive effects). */
  StatusEffectTypeStrengthList?: number[] | null;
  /** Statuses treated as weaknesses that lower a parameter. */
  StatusEffectTypeWeaknessDownList?: number[] | null;
  /** Other weakness statuses (debuffs that are not parameter downs). */
  StatusEffectTypeWeaknessOtherList?: number[] | null;
}

/** A master row from masterSkillDetail. */
export interface SkillDetail {
  EfficacyId?: string | null;
  TriggerId?: string | null;
}

/** A master row from masterSkillLevel. */
export interface SkillLevel {
  Level?: number | null;
  Description?: string | null;
  ShortDescription?: string | null;
  RequiredItemAmount?: number | null;
  RequiredCardLevel?: number | null;
  Stamina?: number | null;
  TriggerId?: string | null;
  ProbabilityPermil?: number | null;
  LimitCount?: number | null;
  CoolTime?: number | null;
  SkillDetails?: SkillDetail[] | null;
  StaminaPermil?: number | null;
}

/** A master row from masterSkill. */
export interface Skill {
  Id?: string | null;
  Name?: string | null;
  CategoryType?: number | null;
  Levels?: SkillLevel[] | null;
  AssetId?: string | null;
}

/** A master row from masterSkillEfficacy. */
export interface SkillEfficacy {
  Id?: string | null;
  Name?: string | null;
  Type?: number | null;
  Description?: string | null;
  ShortDescription?: string | null;
  Grade?: number | null;
  MaxGrade?: number | null;
  SkillTargetId?: string | null;
  LimitBreakMaxGrade?: number | null;
}

/** A master row from masterSkillTrigger. */
export interface SkillTrigger {
  Id?: string | null;
  Type?: number | null;
  CharacterIds?: string[] | null;
}

/** A master row from masterSkillTarget. */
export interface SkillTarget {
  Id?: string | null;
  Type?: number | null;
  IsOpponent?: boolean | null;
}

/** A learned skill reference attached to a deck card (papi.LiveDeckCardSkill). */
export interface LiveDeckCardSkill {
  Index?: number | null;
  SkillId?: string | null;
  SkillLevel?: number | null;
  PossessionType?: number | null;
  LiveAbilityId?: string | null;
  LiveAbilityLevel?: number | null;
  RewrittenEfficacyIds?: string[] | null;
}

/** A prepared deck card (papi.LiveDeckCard). */
export interface LiveDeckCard {
  Index?: number | null;
  CardId?: string | null;
  DisplayCharacterId?: string | null;
  DisplayCostumeId?: string | null;
  Level?: number | null;
  Rarity?: number | null;
  Vocal?: number | null;
  Dance?: number | null;
  Visual?: number | null;
  Stamina?: number | null;
  StartStamina?: number | null;
  Mental?: number | null;
  Technique?: number | null;
  SkillLevel1?: number | null;
  SkillLevel2?: number | null;
  SkillLevel3?: number | null;
  AudienceAmount?: number | null;
  Skills?: LiveDeckCardSkill[] | null;
  IsBuddy?: boolean | null;
  IsFriendBuddy?: boolean | null;
  DisplayHairId?: string | null;
  IsTourScout?: boolean | null;
  EvolutionLevel?: number | null;
  SkillLevel4?: number | null;
}

/** A user deck (papi.LiveUserDeck). */
export interface LiveUserDeck {
  DeckName?: string | null;
  Cards?: LiveDeckCard[] | null;
  BonusSkills?: LiveDeckCardSkill[] | null;
  /** Performers without cards (papi.ExtraCharacterInfo rows). */
  ExtraCharacterInfos?: Array<Record<string, unknown>> | null;
}

/** A simulation user (papi.LiveUserInfo). */
export interface LiveUserInfo {
  Index?: number | null;
  UserId?: string | null;
  Name?: string | null;
  EmblemId?: string | null;
  UserDeck?: LiveUserDeck | null;
  UserResult?: LiveUserResult | null;
  IsNpc?: boolean | null;
}

/** Per-card result (papi.LiveCardResult). */
export interface LiveCardResult {
  CardId?: string | null;
  TotalScore?: number | null;
}

/** Per-user result (papi.LiveUserResult). */
export interface LiveUserResult {
  Score?: number | null;
  CriticalCount?: number | null;
  HitCount?: number | null;
  MissCount?: number | null;
  MaxComboCount?: number | null;
  CardResults?: LiveCardResult[] | null;
}

/** A log line (papi.LiveLogDescription). */
export interface LiveLogDescription {
  Message?: string | null;
}

/** A skill activation failure (papi.LiveSkillFailure). */
export interface LiveSkillFailure {
  CardIndex?: number | null;
  Type?: number | null;
  EachFailureTypes?: number[] | null;
}

/** A per-target detail row (papi.LiveSkillDetailTargetCardInfo). */
export interface LiveSkillDetailTargetCardInfo {
  TargetCardIndex?: number | null;
  Value?: number | null;
}

/** A skill detail (papi.LiveSkillDetail). */
export interface LiveSkillDetail {
  EfficacyIndex?: number | null;
  Value?: number | null;
  StatusType?: number | null;
  TargetCardIndexes?: number[] | null;
  EffectiveChartCount?: number | null;
  TargetCardInfos?: LiveSkillDetailTargetCardInfo[] | null;
}

/** A skill status row (papi.LiveSkillStatus). */
export interface LiveSkillStatus {
  SkillIndex?: number | null;
  RemainCount?: number | null;
  CoolTime?: number | null;
}

/** A status effect origin (papi.LiveStatusEffectReason). */
export interface LiveStatusEffectReason {
  CardIndex?: number | null;
  SkillIndex?: number | null;
}

/** A status effect row (papi.LiveCardStatusEffect). */
export interface LiveCardStatusEffect {
  StatusType?: number | null;
  SkillEfficacyType?: number | null;
  Value?: number | null;
  Grade?: number | null;
  RemainEffectedChartCount?: number | null;
  MaxGrade?: number | null;
  Value2?: number | null;
  StatusReasons?: LiveStatusEffectReason[] | null;
  LimitBreakMaxGrade?: number | null;
}

/** A card snapshot (papi.LiveCardStatus). */
export interface LiveCardStatus {
  CardIndex?: number | null;
  Stamina?: number | null;
  Dance?: number | null;
  Vocal?: number | null;
  Visual?: number | null;
  Effects?: LiveCardStatusEffect[] | null;
  SkillStatuses?: LiveSkillStatus[] | null;
}

/** A user snapshot (papi.LiveUserStatus). */
export interface LiveUserStatus {
  UserIndex?: number | null;
  CurrentComboCount?: number | null;
  TotalScore?: number | null;
}

/** A beat (papi.LiveBeat). */
export interface LiveBeat {
  Order?: number | null;
  CardIndex?: number | null;
  Score?: number | null;
  IsCritical?: boolean | null;
}

/** A skill activation (papi.LiveSkill). */
export interface LiveSkill {
  Order?: number | null;
  CardIndex?: number | null;
  SkillIndex?: number | null;
  Activated?: boolean | null;
  Stamina?: number | null;
  Score?: number | null;
  IsCritical?: boolean | null;
  Details?: LiveSkillDetail[] | null;
  Failures?: LiveSkillFailure[] | null;
  IsComboBreak?: boolean | null;
  CardStatuses?: LiveCardStatus[] | null;
  UserStatuses?: LiveUserStatus[] | null;
  Descriptions?: LiveLogDescription[] | null;
}

/** A chart row (papi.LiveChart). */
export interface LiveChart {
  Number?: number | null;
  ChartType?: number | null;
  AttributeType?: number | null;
  Beats?: LiveBeat[] | null;
  ActivatedSkill?: LiveSkill | null;
  ActivatedPassiveSkills?: LiveSkill[] | null;
  UserStatuses?: LiveUserStatus[] | null;
  CardStatuses?: LiveCardStatus[] | null;
}

/** The simulation output (papi.LiveResult). */
export interface LiveResult {
  UserInfos?: LiveUserInfo[] | null;
  ActivatedPassiveSkills?: LiveSkill[] | null;
  Charts?: LiveChart[] | null;
  TotalAudienceAmount?: number | null;
  Cleared?: boolean | null;
  IsDisplayDetailAvailable?: boolean | null;
  PreChart?: LiveChart | null;
  DetailLogId?: string | null;
}

/** An NPC battle card (papi.LiveBattleCardInfo). */
export interface LiveBattleCardInfo {
  Position?: number | null;
  CardId?: string | null;
  Level?: number | null;
  Rarity?: number | null;
  LightFanAmount?: number | null;
  MiddleFanAmount?: number | null;
  HeavyFanAmount?: number | null;
  EvolutionLevel?: number | null;
}

/** A configured NPC opponent (papi.QuestOpponentInfo). */
export interface QuestOpponentInfo {
  Name?: string | null;
  ManagerLevel?: number | null;
  CardInfos?: LiveBattleCardInfo[] | null;
}
