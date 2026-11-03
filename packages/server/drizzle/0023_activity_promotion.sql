ALTER TABLE "master_Costume" ADD COLUMN IF NOT EXISTS "CostumeTypeId" text;--> statement-breakpoint
ALTER TABLE "master_Hair" ADD COLUMN IF NOT EXISTS "WearableCostumeIds" jsonb;--> statement-breakpoint
ALTER TABLE "master_Hair" ADD COLUMN IF NOT EXISTS "NotWearableCostumeIds" jsonb;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "SecondsPerActivityPromotionStep" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "CharacterSecondToRecover" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "LiveLightFanAmountWeightPermil" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "LiveMiddleFanAmountWeightPermil" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "LiveHeavyFanAmountWeightPermil" bigint;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_ActivityPromotion" (
	"Id" text NOT NULL,
	"Name" text,
	"ViewConditionId" text,
	"UnlockConditionId" text,
	"Order" bigint,
	"Levels" jsonb,
	"ActivityPerformanceId" text,
	"PromotionLevel" bigint,
	"RequiredStamina" bigint,
	"StepConsumptionStamina" bigint,
	"StepRewardGold" bigint,
	"StepRewardCardEnhanceItem" bigint,
	"MultiStepRewardId" text,
	"MaxFanAmount" bigint,
	"SubGenre" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_activity_promotion_id_idx" ON "master_ActivityPromotion" USING btree ("Id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_ActivityPerformance" (
	"Id" text NOT NULL,
	"CostumeTypeIds" jsonb,
	"ForceCostumeTypeId" text,
	"FieldId" text,
	"ExistBackground" bigint,
	"ExistForeground" bigint,
	"BackgroundTopColorCode" text,
	"BackgroundBottomColorCode" text,
	"FieldSpineNumber" bigint,
	"ExistProp" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_activity_performance_id_idx" ON "master_ActivityPerformance" USING btree ("Id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_CharacterActivityLevel" (
	"Level" bigint NOT NULL,
	"RequiredExp" bigint,
	"MaxStamina" bigint,
	"BaseActivityPoint" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_character_activity_level_idx" ON "master_CharacterActivityLevel" USING btree ("Level");
