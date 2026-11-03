CREATE TABLE "master_ExcursionPlace" (
	"Id" text NOT NULL,
	"Name" text,
	"AdvAssetId" text,
	"IdleCameraMotionAssetId" text,
	"BackgroundAssetId" text,
	"BgmAssetId" text,
	"SceneLayoutAssetId" text,
	"AdvNotWearableCostumeTypeIds" jsonb,
	"FinishAdvNotWearableCostumeTypeIds" jsonb,
	"NotWearableCostumeTypeIds" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_excursion_place_id_idx" ON "master_ExcursionPlace" USING btree ("Id");