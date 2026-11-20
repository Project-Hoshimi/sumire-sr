CREATE TABLE "master_MarathonQuest" (
	"Id" text NOT NULL,
	"MarathonId" text NOT NULL,
	"Name" text,
	"Description" text,
	"Order" bigint,
	"UnlockConditionId" text,
	"MarathonPointBonusCharacterIds" jsonb,
	"BoxGachaId" text,
	"StageId" text,
	"MusicId" text,
	"MusicChartPatternId" text,
	"RequiredUnlockItemAmount" bigint,
	"RequiredStamina" bigint,
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
	"QuestPressureId" text,
	"QuestCharacterAdvantageId" text,
	"QuestAudienceAdvantageId" text,
	"MoodType" bigint,
	"MaxCapacity" bigint,
	"DailyLimitCount" bigint,
	"AssetId" text,
	"UnlockDescription" text
);
--> statement-breakpoint
CREATE TABLE "master_MarathonQuestDifficulty" (
	"MarathonQuestId" text NOT NULL,
	"DifficultyNumber" bigint NOT NULL,
	"DifficultyLevel" bigint,
	"MarathonId" text,
	"MentalThreshold" bigint,
	"ClearScore" bigint,
	"RewardManagerExp" bigint,
	"RewardCardExp" bigint,
	"RewardMarathonPoint" bigint,
	"ClearRewardId" text,
	"RankAdditionalRewardId" text,
	"RankSRewardId" text,
	"RankARewardId" text,
	"RankBRewardId" text,
	"RankCRewardId" text,
	"UnlockConditionId" text,
	"LiveBonusGroupId" text
);
--> statement-breakpoint
CREATE TABLE "master_MarathonLiveBonus" (
	"Id" text NOT NULL,
	"Name" text,
	"LiveAbilityId" text,
	"LiveAbilityLevel" bigint,
	"PowerPermil" bigint
);
--> statement-breakpoint
CREATE TABLE "master_MarathonLiveBonusGroup" (
	"GroupId" text NOT NULL,
	"LiveBonusId" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_marathon_quest_id_idx" ON "master_MarathonQuest" USING btree ("Id");
--> statement-breakpoint
CREATE UNIQUE INDEX "master_marathon_quest_difficulty_key_idx" ON "master_MarathonQuestDifficulty" USING btree ("MarathonQuestId","DifficultyNumber");
--> statement-breakpoint
CREATE UNIQUE INDEX "master_marathon_live_bonus_id_idx" ON "master_MarathonLiveBonus" USING btree ("Id");
--> statement-breakpoint
CREATE UNIQUE INDEX "master_marathon_live_bonus_group_key_idx" ON "master_MarathonLiveBonusGroup" USING btree ("GroupId","LiveBonusId");
