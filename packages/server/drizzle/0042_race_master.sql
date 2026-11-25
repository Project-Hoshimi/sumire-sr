CREATE TABLE "master_RaceLiveBonus" (
	"Id" text NOT NULL,
	"Level" bigint NOT NULL,
	"LiveAbilityId" text,
	"LiveAbilityLevel" bigint,
	"PowerPermil" bigint,
	"RequiredRaceMedalAmount" bigint,
	"UnlockConditionId" text
);
--> statement-breakpoint
CREATE TABLE "master_RaceLiveBonusGroup" (
	"GroupId" text NOT NULL,
	"LiveBonusId" text NOT NULL,
	"Order" bigint
);
--> statement-breakpoint
CREATE TABLE "master_RacePanel" (
	"RaceAreaId" text NOT NULL,
	"Number" bigint NOT NULL,
	"Type" bigint,
	"RaceQuestId" text,
	"EventStoryEpisode" bigint,
	"RequiredRacePointAmount" bigint,
	"RacePanelRewardId" text
);
--> statement-breakpoint
CREATE TABLE "master_RacePanelReward" (
	"Id" text NOT NULL,
	"RaceId" text,
	"RewardId" text
);
--> statement-breakpoint
CREATE TABLE "master_RaceQuest" (
	"Id" text NOT NULL,
	"GroupId" text,
	"Name" text,
	"Description" text,
	"Order" bigint,
	"MusicId" text,
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
	"QuestPressureId" text,
	"QuestCharacterAdvantageId" text,
	"QuestAudienceAdvantageId" text,
	"MoodType" bigint,
	"ActivityLessonRewardType" bigint,
	"LiveSkipType" bigint,
	"UnlockConditionId" text
);
--> statement-breakpoint
CREATE TABLE "master_RaceQuestDifficulty" (
	"RaceQuestId" text NOT NULL,
	"DifficultyNumber" bigint NOT NULL,
	"DifficultyLevel" bigint,
	"MentalThreshold" bigint,
	"ClearScore" bigint,
	"UnlockConditionId" text,
	"UnlockDescription" text,
	"StageId" text,
	"MaxCapacity" bigint,
	"LiveBonusGroupId" text
);
--> statement-breakpoint
CREATE TABLE "master_RaceRankingReward" (
	"RankGradeId" text NOT NULL,
	"Type" bigint NOT NULL,
	"RankFrom" bigint NOT NULL,
	"RewardId" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_race_live_bonus_key_idx" ON "master_RaceLiveBonus" USING btree ("Id","Level");--> statement-breakpoint
CREATE UNIQUE INDEX "master_race_live_bonus_group_key_idx" ON "master_RaceLiveBonusGroup" USING btree ("GroupId","LiveBonusId");--> statement-breakpoint
CREATE UNIQUE INDEX "master_race_panel_key_idx" ON "master_RacePanel" USING btree ("RaceAreaId","Number");--> statement-breakpoint
CREATE UNIQUE INDEX "master_race_panel_reward_id_idx" ON "master_RacePanelReward" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_race_quest_id_idx" ON "master_RaceQuest" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_race_quest_difficulty_key_idx" ON "master_RaceQuestDifficulty" USING btree ("RaceQuestId","DifficultyNumber");--> statement-breakpoint
CREATE UNIQUE INDEX "master_race_ranking_reward_key_idx" ON "master_RaceRankingReward" USING btree ("RankGradeId","Type","RankFrom");