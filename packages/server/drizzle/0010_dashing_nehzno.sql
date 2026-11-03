CREATE TABLE "player_love_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"love_id" text NOT NULL,
	"name" text,
	"exp" bigint DEFAULT 0 NOT NULL,
	"last_receive_time" bigint DEFAULT 0 NOT NULL,
	"read_episode_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_CardEvolution" (
	"CardId" text NOT NULL,
	"EvolutionLevel" bigint NOT NULL,
	"RewardCostumeId" text,
	"RewardHairId" text
);
--> statement-breakpoint
CREATE TABLE "master_CardEvolutionLevel" (
	"GroupId" text NOT NULL,
	"Level" bigint NOT NULL,
	"Exp" bigint,
	"DuplicateObtainExp" bigint
);
--> statement-breakpoint
CREATE TABLE "master_CardEvolutionLevelRelease" (
	"GroupId" text NOT NULL,
	"Level" bigint NOT NULL,
	"Targets" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_CardEvolutionMessage" (
	"CardId" text NOT NULL,
	"EvolutionLevel" bigint NOT NULL,
	"Number" bigint NOT NULL,
	"CharacterId" text,
	"EvolveMessage" text,
	"VoiceAssetId" text
);
--> statement-breakpoint
CREATE TABLE "master_Character" (
	"Id" text NOT NULL,
	"AssetId" text,
	"Name" text,
	"EnName" text,
	"Cv" text,
	"Color" text,
	"DefaultCostumeId" text,
	"LoveInfo" jsonb,
	"LoveInfos" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_EventStory" (
	"Id" text NOT NULL,
	"AssetId" text,
	"Name" text,
	"Description" text,
	"Order" bigint,
	"ViewConditionId" text,
	"Episodes" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_ExtraStory" (
	"Id" text NOT NULL,
	"ExtraStoryPartId" text,
	"AssetId" text,
	"Name" text,
	"Description" text,
	"Order" bigint,
	"ViewConditionId" text,
	"UnlockConditionId" text,
	"Episodes" jsonb,
	"ExtraStoryType" bigint,
	"IconAssetId" text,
	"BackgroundAssetId" text,
	"SecretEffectColorCode" text
);
--> statement-breakpoint
CREATE TABLE "master_ExtraStoryPart" (
	"Id" text NOT NULL,
	"AssetId" text,
	"Name" text,
	"SubTitle" text,
	"NoteText" text,
	"Order" bigint,
	"Type" bigint,
	"ViewConditionId" text,
	"UnlockConditionId" text,
	"ExtraStoryIds" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_LoveColor" (
	"LoveId" text NOT NULL,
	"ExecuteButtonGradientStartColor" text,
	"ExecuteButtonGradientEndColor" text,
	"HomeButtonFrameColor" text,
	"StorySelectMaskColor" text,
	"ItemBackgroundColor" text,
	"LoveLevelBackgroundColor" text,
	"MainColor" text,
	"NoticeColor" text,
	"PickupTextColor" text,
	"OverlayBackgroundColor" text,
	"ScreenBackgroundColor" text,
	"IconColor" text,
	"BorderLineColor" text,
	"GaugeColor" text,
	"FooterGradientStartColor" text,
	"FooterGradientEndColor" text,
	"StartButtonGradientColor1" text,
	"StartButtonGradientColor2" text,
	"StartButtonGradientColor3" text,
	"StartButtonTextColor" text,
	"LoveLevelUpBackgroundColor" text,
	"AdvMainColor" text
);
--> statement-breakpoint
CREATE TABLE "master_LoveHomeAction" (
	"Id" text NOT NULL,
	"LoveId" text NOT NULL,
	"CharacterId" text,
	"MotionAssetId" text,
	"AdditionMotionAssetId" text,
	"VoiceAssetId" text,
	"Text" text,
	"ActionType" bigint,
	"HiddenFavorabilityGte" bigint,
	"HiddenFavorabilityLte" bigint,
	"UnlockLoveStoryEndIds" jsonb,
	"NowAfter" bigint,
	"NowBefore" bigint,
	"Weight" bigint,
	"CostumeId" text
);
--> statement-breakpoint
CREATE TABLE "master_LoveLevel" (
	"LoveId" text NOT NULL,
	"Level" bigint NOT NULL,
	"RequiredExp" bigint,
	"LessonStepRewardExp" bigint,
	"LessonStepRewardStoryReadItemAmount" bigint
);
--> statement-breakpoint
CREATE TABLE "master_LoveStoryEpisode" (
	"Id" text NOT NULL,
	"LoveId" text NOT NULL,
	"Episode" bigint NOT NULL,
	"StoryId" text,
	"AssetId" text,
	"ConsumptionItemAmount" bigint
);
--> statement-breakpoint
CREATE TABLE "master_Story" (
	"Id" text NOT NULL,
	"SectionName" text,
	"Name" text,
	"Description" text,
	"RewardId" text,
	"AdvPlayTypes" jsonb,
	"AdvAssetIds" jsonb,
	"AdditionalDisplayCharacterIds" jsonb,
	"BranchFirstText" text,
	"BranchCautionText" text,
	"BranchBgmAssetId" text,
	"BranchChoices" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_StoryEpisodeConsumption" (
	"Id" text NOT NULL,
	"ReleaseCount" bigint NOT NULL,
	"RequiredStoryPoint" bigint
);
--> statement-breakpoint
CREATE TABLE "master_StoryPart" (
	"Id" text NOT NULL,
	"AssetId" text,
	"Name" text,
	"SubTitle" text,
	"Order" bigint,
	"Type" bigint,
	"ViewConditionId" text,
	"UnlockConditionId" text,
	"PointType" bigint,
	"StoryEpisodeConsumptionId" text,
	"Chapters" jsonb,
	"NoteText" text
);
--> statement-breakpoint
ALTER TABLE "player_love_progress" ADD CONSTRAINT "player_love_progress_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_love_progress_player_love_idx" ON "player_love_progress" USING btree ("player_id","love_id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_evolution_key_idx" ON "master_CardEvolution" USING btree ("CardId","EvolutionLevel");--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_evolution_level_key_idx" ON "master_CardEvolutionLevel" USING btree ("GroupId","Level");--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_evolution_level_release_key_idx" ON "master_CardEvolutionLevelRelease" USING btree ("GroupId","Level");--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_evolution_message_key_idx" ON "master_CardEvolutionMessage" USING btree ("CardId","EvolutionLevel","Number");--> statement-breakpoint
CREATE UNIQUE INDEX "master_character_key_idx" ON "master_Character" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_event_story_id_idx" ON "master_EventStory" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_extra_story_id_idx" ON "master_ExtraStory" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_extra_story_part_id_idx" ON "master_ExtraStoryPart" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_love_color_key_idx" ON "master_LoveColor" USING btree ("LoveId");--> statement-breakpoint
CREATE UNIQUE INDEX "master_love_home_action_key_idx" ON "master_LoveHomeAction" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_love_level_key_idx" ON "master_LoveLevel" USING btree ("LoveId","Level");--> statement-breakpoint
CREATE UNIQUE INDEX "master_love_story_episode_key_idx" ON "master_LoveStoryEpisode" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_story_id_idx" ON "master_Story" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_story_episode_consumption_key_idx" ON "master_StoryEpisodeConsumption" USING btree ("Id","ReleaseCount");--> statement-breakpoint
CREATE UNIQUE INDEX "master_story_part_id_idx" ON "master_StoryPart" USING btree ("Id");