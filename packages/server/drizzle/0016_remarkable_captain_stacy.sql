CREATE TABLE "master_PhotoAbilitySet" (
	"Id" text NOT NULL,
	"PhotoAbilityIds" jsonb,
	"PhotoRarity" bigint
);
--> statement-breakpoint
CREATE TABLE "master_PhotoActivity" (
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
CREATE TABLE "master_PhotoAllInOne" (
	"Id" text NOT NULL,
	"AssetId" text,
	"Name" text,
	"Rarity" bigint,
	"PlaceName" text,
	"EventName" text,
	"Level" bigint,
	"Abilities" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_PhotoExpression" (
	"Id" text NOT NULL,
	"Name" text,
	"ThumbnailAssetId" text,
	"StageId" text,
	"CostumeTypeIds" jsonb,
	"ForceCostumeTypeId" text,
	"Order" bigint,
	"ViewConditionId" text,
	"UnlockConditionId" text,
	"ImpossibleShootingCharacterIds" jsonb,
	"ImpossiblePhotoPoseIds" jsonb,
	"SceneLayoutAssetId" text,
	"CharacterAmountArray" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_PhotoExpressionStagePosition" (
	"StageId" text NOT NULL,
	"Number" bigint NOT NULL,
	"Name" text,
	"PossiblePhotoPoseType" bigint,
	"InitialPhotoPoseId" text,
	"CharacterPositions" jsonb,
	"CharacterAngles" jsonb,
	"CameraPositions" jsonb,
	"CameraAngles" jsonb,
	"UpperLimit" double precision,
	"LowerLimit" double precision,
	"PreviewCameraPositions" jsonb,
	"PreviewCameraAngles" jsonb,
	"PreviewUpperLimit" double precision,
	"PreviewLowerLimit" double precision,
	"LookEffectAssetId" text
);
--> statement-breakpoint
CREATE TABLE "master_PhotoFacial" (
	"Id" text NOT NULL,
	"Name" text,
	"Order" bigint
);
--> statement-breakpoint
CREATE TABLE "master_PhotoPose" (
	"Id" text NOT NULL,
	"Name" text,
	"Description" text,
	"PoseType" bigint,
	"PoseMotionType" bigint,
	"LookingType" bigint,
	"Order" bigint,
	"ReleaseDatetime" bigint
);
--> statement-breakpoint
CREATE TABLE "master_PhotoQuestMusic" (
	"Id" text NOT NULL,
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
CREATE TABLE "master_PhotoQuestStage" (
	"Id" text NOT NULL,
	"AssetId" text,
	"Name" text,
	"MaxCapacity" bigint,
	"Order" bigint,
	"ViewConditionId" text,
	"UnlockConditionId" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_ability_set_id_idx" ON "master_PhotoAbilitySet" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_activity_id_idx" ON "master_PhotoActivity" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_all_in_one_id_idx" ON "master_PhotoAllInOne" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_expression_id_idx" ON "master_PhotoExpression" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_expression_stage_position_key_idx" ON "master_PhotoExpressionStagePosition" USING btree ("StageId","Number");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_facial_id_idx" ON "master_PhotoFacial" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_pose_id_idx" ON "master_PhotoPose" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_quest_music_id_idx" ON "master_PhotoQuestMusic" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_quest_stage_id_idx" ON "master_PhotoQuestStage" USING btree ("Id");