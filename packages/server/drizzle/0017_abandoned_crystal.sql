CREATE TABLE "master_PhotoContestActivity" (
	"Id" text NOT NULL,
	"Name" text,
	"Type" bigint,
	"ThumbAssetId" text,
	"StageId" text,
	"CostumeTypeIds" jsonb,
	"ForceCostumeTypeId" text,
	"PhotoShootingMotionSetId" text,
	"IsDeleteCharacter" boolean,
	"Order" bigint,
	"ViewConditionId" text,
	"UnlockConditionId" text,
	"ImpossibleShootingCharacterIds" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_PhotoContestQuestMusic" (
	"Id" text NOT NULL,
	"MusicId" text,
	"AssetId" text,
	"Name" text,
	"Description" text,
	"Order" bigint,
	"Lyricist" text,
	"Composer" text,
	"Arranger" text,
	"Singer" text,
	"ViewConditionId" text,
	"UnlockConditionId" text
);
--> statement-breakpoint
CREATE TABLE "master_PhotoContestQuestStage" (
	"Id" text NOT NULL,
	"StageId" text,
	"AssetId" text,
	"Name" text,
	"Description" text,
	"MaxCapacity" bigint,
	"Order" bigint,
	"ViewConditionId" text,
	"UnlockConditionId" text
);
--> statement-breakpoint
CREATE TABLE "master_PhotoContestSection" (
	"Id" text NOT NULL,
	"Name" text,
	"Theme" text,
	"Description" text,
	"AssetId" text,
	"BackgroundColorCode" text,
	"UnlockConditionId" text
);
--> statement-breakpoint
CREATE TABLE "master_PhotoContestSectionReward" (
	"Id" text NOT NULL,
	"RequiredEvaluationPoint" bigint,
	"RewardId" text
);
--> statement-breakpoint
CREATE TABLE "master_QuestContestRankingSeason" (
	"Id" text NOT NULL,
	"StartTime" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_contest_activity_id_idx" ON "master_PhotoContestActivity" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_contest_quest_music_id_idx" ON "master_PhotoContestQuestMusic" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_contest_quest_stage_id_idx" ON "master_PhotoContestQuestStage" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_contest_section_id_idx" ON "master_PhotoContestSection" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_contest_section_reward_id_idx" ON "master_PhotoContestSectionReward" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_quest_contest_ranking_season_id_idx" ON "master_QuestContestRankingSeason" USING btree ("Id");