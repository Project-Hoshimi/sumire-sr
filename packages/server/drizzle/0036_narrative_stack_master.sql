CREATE TABLE IF NOT EXISTS "master_AreaGroup" (
	"Id" text NOT NULL,
	"Name" text,
	"Order" bigint,
	"AssetId" text,
	"AreaIds" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_ComboAdvantage" (
	"Id" text NOT NULL,
	"ComboCount" bigint NOT NULL,
	"AdvantagePermil" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_FunctionLock" (
	"Type" bigint NOT NULL,
	"UnlockConditionId" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_HierarchyDivisionReward" (
	"Id" text NOT NULL,
	"Name" text,
	"RewardId" text,
	"Order" bigint,
	"DetailGradeId" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_HierarchyReward" (
	"Id" text NOT NULL,
	"Order" bigint,
	"Name" text,
	"ConditionId" text,
	"RewardId" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_LiveBonus" (
	"Id" text NOT NULL,
	"Name" text,
	"LiveAbilityId" text,
	"LiveAbilityLevel" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_LiveBonusGroup" (
	"GroupId" text NOT NULL,
	"LiveBonusIds" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_MusicChartPattern" (
	"Id" text NOT NULL,
	"Number" bigint NOT NULL,
	"Type" bigint,
	"Position" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_MusicMasteryLevel" (
	"Level" bigint NOT NULL,
	"RequiredMasteryPoint" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_MusicMasteryReward" (
	"MusicId" text NOT NULL,
	"CharacterId" text NOT NULL,
	"MusicMasteryRewardSetId" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_MusicMasteryRewardSet" (
	"Id" text NOT NULL,
	"Level" bigint NOT NULL,
	"RewardId" text,
	"RewardStoneAmount" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_PhotoAbilityTarget" (
	"Id" text NOT NULL,
	"Type" bigint,
	"TargetId" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_Quest" (
	"Id" text NOT NULL,
	"AreaId" text,
	"StageId" text,
	"MusicId" text,
	"DifficultyLevel" bigint,
	"Name" text,
	"Description" text,
	"Order" bigint,
	"MusicChartPatternId" text,
	"Position1AttributeType" bigint,
	"Position2AttributeType" bigint,
	"Position3AttributeType" bigint,
	"Position4AttributeType" bigint,
	"Position5AttributeType" bigint,
	"ActiveSkillWeightPermil" bigint,
	"SpecialSkillWeightPermil" bigint,
	"SkillStaminaWeightPermil" bigint,
	"StaminaRecoveryWeightPermil" bigint,
	"BeatDanceWeightPermil" bigint,
	"BeatVocalWeightPermil" bigint,
	"BeatVisualWeightPermil" bigint,
	"MaxCapacity" bigint,
	"MentalThreshold" bigint,
	"QuestPressureId" text,
	"QuestCharacterAdvantageId" text,
	"QuestAudienceAdvantageId" text,
	"MoodType" bigint,
	"ClearScore" bigint,
	"RewardManagerExp" bigint,
	"RewardCardExp" bigint,
	"ClearRewardId" text,
	"RankAdditionalRewardId" text,
	"RankSRewardId" text,
	"RankARewardId" text,
	"RankBRewardId" text,
	"RankCRewardId" text,
	"RankDRewardId" text,
	"ViewConditionId" text,
	"UnlockConditionId" text,
	"DailyLimitCount" bigint,
	"TicketAmount" bigint,
	"AchievedRankRewards" jsonb,
	"LiveBonusGroupId" text,
	"LiveSkipType" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_QuestAudienceAdvantage" (
	"Id" text NOT NULL,
	"AudienceAmount" bigint NOT NULL,
	"AdvantagePermil" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_QuestCharacterAdvantage" (
	"Id" text NOT NULL,
	"CharacterGroupId" text,
	"CharacterIds" jsonb,
	"AdvantagePermil" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_QuestPressure" (
	"Id" text NOT NULL,
	"Name" text,
	"WeightPermil" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_QuestStaminaConsumption" (
	"RemainStaminaRatioPercent" bigint NOT NULL,
	"SkillTargetParameterWeightPermil" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_SkillEfficacy" (
	"Id" text NOT NULL,
	"Name" text,
	"Type" bigint,
	"Description" text,
	"ShortDescription" text,
	"Grade" bigint,
	"MaxGrade" bigint,
	"SkillTargetId" text,
	"LimitBreakMaxGrade" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_SkillTarget" (
	"Id" text NOT NULL,
	"Type" bigint,
	"IsOpponent" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_SkillTrigger" (
	"Id" text NOT NULL,
	"Type" bigint,
	"CharacterIds" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_StatusEffectName" (
	"StatusEffectType" bigint NOT NULL,
	"Name" text
);
--> statement-breakpoint
ALTER TABLE "player_lesson_progress" ADD COLUMN IF NOT EXISTS "banked_reward_gold" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_lesson_progress" ADD COLUMN IF NOT EXISTS "banked_reward_manager_exp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_lesson_progress" ADD COLUMN IF NOT EXISTS "banked_reward_card_enhance_item" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_lesson_progress" ADD COLUMN IF NOT EXISTS "rate_anchor_time" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "master_Accessory" ADD COLUMN IF NOT EXISTS "Param1Permil" bigint;--> statement-breakpoint
ALTER TABLE "master_Accessory" ADD COLUMN IF NOT EXISTS "Param2Type" bigint;--> statement-breakpoint
ALTER TABLE "master_Accessory" ADD COLUMN IF NOT EXISTS "Param2Permil" bigint;--> statement-breakpoint
ALTER TABLE "master_Accessory" ADD COLUMN IF NOT EXISTS "Param2Value" bigint;--> statement-breakpoint
ALTER TABLE "master_Accessory" ADD COLUMN IF NOT EXISTS "CharacterId" text;--> statement-breakpoint
ALTER TABLE "master_Accessory" ADD COLUMN IF NOT EXISTS "CharacterGroupId" text;--> statement-breakpoint
ALTER TABLE "master_Character" ADD COLUMN IF NOT EXISTS "DefaultLiveCostumeId" text;--> statement-breakpoint
ALTER TABLE "master_PhotoAbility" ADD COLUMN IF NOT EXISTS "MoodType" bigint;--> statement-breakpoint
ALTER TABLE "master_PhotoAbility" ADD COLUMN IF NOT EXISTS "SkillId" text;--> statement-breakpoint
ALTER TABLE "master_PhotoAbility" ADD COLUMN IF NOT EXISTS "AbilityTargetId" text;--> statement-breakpoint
ALTER TABLE "master_PhotoAbility" ADD COLUMN IF NOT EXISTS "ConditionCardType" bigint;--> statement-breakpoint
ALTER TABLE "master_PhotoAbility" ADD COLUMN IF NOT EXISTS "ConditionLiveType" bigint;--> statement-breakpoint
ALTER TABLE "master_PhotoAbility" ADD COLUMN IF NOT EXISTS "StatusEffectType" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "ActivityPromotionFetchStepsSize" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "LiveMinimumGuaranteedAudienceAmount" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "LiveMaxParameterBonusPermil" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "StatusEffectTypeStrengthList" jsonb;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "StatusEffectTypeWeaknessDownList" jsonb;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "StatusEffectTypeWeaknessOtherList" jsonb;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "CardDefaultMental" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "CardDefaultTechnique" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "QuestDailyTicketLimitUseCount" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "QuestContestTicketLimitUseCount" bigint;--> statement-breakpoint
ALTER TABLE "master_Stage" ADD COLUMN IF NOT EXISTS "ThumbnailAssetId" text;--> statement-breakpoint
ALTER TABLE "master_Stage" ADD COLUMN IF NOT EXISTS "Description" text;--> statement-breakpoint
ALTER TABLE "master_Stage" ADD COLUMN IF NOT EXISTS "TimeDifference" text;--> statement-breakpoint
ALTER TABLE "master_Stage" ADD COLUMN IF NOT EXISTS "IsHideWithPhotoShooting" boolean;--> statement-breakpoint
ALTER TABLE "master_Stage" ADD COLUMN IF NOT EXISTS "OverrideAssetVariationId" text;--> statement-breakpoint
ALTER TABLE "master_Stage" ADD COLUMN IF NOT EXISTS "AdditionalAssetIds" jsonb;--> statement-breakpoint
ALTER TABLE "master_Stage" ADD COLUMN IF NOT EXISTS "CameraPositions" jsonb;--> statement-breakpoint
ALTER TABLE "master_Stage" ADD COLUMN IF NOT EXISTS "OpeningAssetId" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_area_group_id_idx" ON "master_AreaGroup" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_combo_advantage_key_idx" ON "master_ComboAdvantage" USING btree ("Id","ComboCount");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_function_lock_type_idx" ON "master_FunctionLock" USING btree ("Type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_hierarchy_division_reward_id_idx" ON "master_HierarchyDivisionReward" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_hierarchy_reward_id_idx" ON "master_HierarchyReward" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_live_bonus_id_idx" ON "master_LiveBonus" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_live_bonus_group_key_idx" ON "master_LiveBonusGroup" USING btree ("GroupId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_music_chart_pattern_key_idx" ON "master_MusicChartPattern" USING btree ("Id","Number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_music_mastery_level_key_idx" ON "master_MusicMasteryLevel" USING btree ("Level");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_music_mastery_reward_key_idx" ON "master_MusicMasteryReward" USING btree ("MusicId","CharacterId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_music_mastery_reward_set_key_idx" ON "master_MusicMasteryRewardSet" USING btree ("Id","Level");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_photo_ability_target_id_idx" ON "master_PhotoAbilityTarget" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_quest_id_idx" ON "master_Quest" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_quest_audience_advantage_key_idx" ON "master_QuestAudienceAdvantage" USING btree ("Id","AudienceAmount");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_quest_character_advantage_id_idx" ON "master_QuestCharacterAdvantage" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_quest_pressure_id_idx" ON "master_QuestPressure" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_quest_stamina_consumption_key_idx" ON "master_QuestStaminaConsumption" USING btree ("RemainStaminaRatioPercent");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_skill_efficacy_id_idx" ON "master_SkillEfficacy" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_skill_target_id_idx" ON "master_SkillTarget" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_skill_trigger_id_idx" ON "master_SkillTrigger" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_status_effect_name_key_idx" ON "master_StatusEffectName" USING btree ("StatusEffectType");