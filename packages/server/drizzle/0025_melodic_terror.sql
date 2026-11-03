ALTER TABLE "master_Character" ADD COLUMN IF NOT EXISTS "Type" bigint;--> statement-breakpoint
ALTER TABLE "master_PhotoAbilitySet" ADD COLUMN IF NOT EXISTS "Limited" bigint;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "PhotoShootingItemThresholds" jsonb;--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN IF NOT EXISTS "StoryPhotoShootingDefaultCharacterId" text;
