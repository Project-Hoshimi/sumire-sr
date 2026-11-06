CREATE TABLE IF NOT EXISTS "master_Area" (
	"Id" text NOT NULL,
	"Type" bigint,
	"Name" text,
	"Description" text,
	"Order" bigint,
	"AreaGroupId" text,
	"ViewConditionId" text,
	"UnlockConditionId" text,
	"DailyLimitCount" bigint,
	"DailyTicketItemType" bigint,
	"RewardAssetId" text,
	"AssetId" text,
	"ColorCode" text,
	"DailySpecialTicketItemId" text,
	"DailyRewardName" text,
	"QuestIds" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_Condition" (
	"Id" text NOT NULL,
	"Settings" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_HierarchyDetailGrade" (
	"Id" text NOT NULL,
	"HierarchyGradeId" text,
	"SubName" text,
	"RequiredHierarchyPoint" bigint,
	"RequiredHierarchyRank" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_ManagerLevel" (
	"Level" bigint NOT NULL,
	"RequiredExp" bigint,
	"MaxCardLevel" bigint,
	"MaxPhotoEnhanceLevel" bigint,
	"MaxPhotoReportLevel" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_Music" (
	"Id" text NOT NULL,
	"AssetId" text,
	"Name" text,
	"Description" text,
	"Order" bigint,
	"Lyricist" text,
	"Composer" text,
	"Arranger" text,
	"Singer" text,
	"Is3DAvailable" boolean,
	"ComboAdvantageId" text,
	"VolumePermyriads" jsonb,
	"VocalVolumePermyriads" jsonb,
	"Bars" jsonb,
	"Beats" jsonb,
	"Bpms" jsonb,
	"ChartStartOffsetMillisecond" bigint,
	"DisplayCharacterAmount" bigint,
	"ColorVariation" bigint,
	"Digests" jsonb,
	"ReleaseTime" bigint,
	"OriginalCharacterIds" jsonb,
	"NotSelectableStageTypes" jsonb,
	"MvAssetId" text,
	"SelectableStageIds" jsonb,
	"Is360LiveExist" boolean
);
--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "ActivityLessonPromoteLimitCount" bigint;
--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "ActivityLessonPromoteRequiredStoneAmount" bigint;
--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "ActivityLessonPromoteEffectHours" bigint;
--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "ActivityLessonPromoteFreeLimitCount" bigint;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_area_id_idx" ON "master_Area" USING btree ("Id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_condition_id_idx" ON "master_Condition" USING btree ("Id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_hierarchy_detail_grade_id_idx" ON "master_HierarchyDetailGrade" USING btree ("Id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_manager_level_key_idx" ON "master_ManagerLevel" USING btree ("Level");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_music_id_idx" ON "master_Music" USING btree ("Id");
