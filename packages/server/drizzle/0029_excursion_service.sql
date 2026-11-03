CREATE TABLE IF NOT EXISTS "master_ExcursionPlaceSetting" (
	"CharacterId" text NOT NULL,
	"ExcursionPlaceId" text NOT NULL,
	"AdvForceCostumeId" text,
	"PropAssetId" text,
	"ForceCostumeId" text,
	"MinFocalLength" double precision,
	"DefaultFocalLength" double precision,
	"MaxFocalLength" double precision,
	"SceneLayoutPositionIndex" bigint,
	"FinishAdvForceCostumeId" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_excursion_place_setting_key_idx" ON "master_ExcursionPlaceSetting" USING btree ("CharacterId","ExcursionPlaceId");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_ExcursionGazeReaction" (
	"CharacterId" text NOT NULL,
	"ExcursionPlaceId" text NOT NULL,
	"Number" bigint NOT NULL,
	"MotionAssetId" text,
	"VoiceAssetId" text,
	"UnlockCostumeIds" jsonb,
	"UnlockNotCostumeIds" jsonb,
	"CameraMotionAssetId" text,
	"PropAssetId" text,
	"IsFade" boolean,
	"IsLookAt" boolean,
	"Text" text,
	"FocalLength" double precision,
	"FNumberRatio" double precision,
	"TrackingAccuracy" double precision,
	"YOffset" double precision,
	"UnlockGazeNumbers" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_excursion_gaze_reaction_key_idx" ON "master_ExcursionGazeReaction" USING btree ("CharacterId","ExcursionPlaceId","Number");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_CompanyEnjoyObtainPointItemSetting" (
	"CharacterId" text NOT NULL,
	"ItemId" text NOT NULL,
	"ObtainPoint" bigint,
	"GrowthType" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_company_enjoy_obtain_point_item_key_idx" ON "master_CompanyEnjoyObtainPointItemSetting" USING btree ("CharacterId","ItemId");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_excursion_state" (
	"player_id" text PRIMARY KEY NOT NULL,
	"offered_character" text,
	"offered_place_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_character" text,
	"active_place_id" text,
	"started_time" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "player_excursion_state" ADD CONSTRAINT "player_excursion_state_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
