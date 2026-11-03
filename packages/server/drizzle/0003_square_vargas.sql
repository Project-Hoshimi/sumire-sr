CREATE TABLE "server_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_Card" (
	"Id" text NOT NULL,
	"AssetId" text,
	"Name" text,
	"Description" text,
	"Type" integer,
	"CharacterId" text,
	"InitialRarity" integer,
	"CardParameterId" text,
	"VocalRatioPermil" integer,
	"DanceRatioPermil" integer,
	"VisualRatioPermil" integer,
	"StaminaRatioPermil" integer,
	"CardLevelReleaseId" text,
	"SkillId1" text,
	"SkillId2" text,
	"SkillId3" text,
	"LiveAbilityId" text,
	"ActivityAbilityId" text,
	"Order" integer,
	"ReleaseDate" integer,
	"RewardCostumeId" text,
	"RewardHairIds" jsonb,
	"ObtainMessage" text,
	"RewardHairId" text,
	"CardEvolutionLevelReleaseGroupId" text,
	"CardEvolutionLevelGroupId" text,
	"SkillId4" text,
	"Stories" jsonb,
	"Messages" jsonb,
	"HomeTalks" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_CardLevel" (
	"Level" integer NOT NULL,
	"RequiredExp" integer
);
--> statement-breakpoint
CREATE TABLE "master_CardParameter" (
	"Id" text NOT NULL,
	"Level" integer NOT NULL,
	"Value" integer,
	"StaminaValue" integer
);
--> statement-breakpoint
CREATE TABLE "master_EventMission" (
	"Id" text NOT NULL,
	"EventMissionType" integer,
	"AssetId" text,
	"Name" text,
	"Order" integer,
	"ViewConditionId" text,
	"UnlockConditionId" text,
	"MissionIds" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_Gacha" (
	"Id" text NOT NULL,
	"AssetId" text,
	"BannerAssetId" text,
	"AppealAssetId" text,
	"MovieAssetId" text,
	"ScreenAssetId" text,
	"Name" text,
	"Description" text,
	"Precaution" text,
	"GachaType" integer,
	"ViewConditionId" text,
	"UnlockConditionId" text,
	"PickupCardIds" jsonb,
	"ExchangeResourceType" integer,
	"ExchangeResourceId" text,
	"ExchangeBoothId" text,
	"Order" integer,
	"IsPeriodDisplay" boolean,
	"AppealText" text,
	"SelectPickupAmount" integer,
	"SelectCardIds" jsonb,
	"ShopId" text,
	"BgmAssetId" text,
	"ButtonIds" jsonb,
	"ExchangeIds" jsonb,
	"CardRewards" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_GachaButton" (
	"Id" text NOT NULL,
	"Name" text,
	"Description" text,
	"IsAnimation" boolean,
	"ConsumptionId" text,
	"DiscountLimitType" integer,
	"DiscountCount" integer,
	"DiscountConsumptionId" text,
	"DrawCount" integer,
	"LimitType" integer,
	"LimitCount" integer,
	"BonusRewardId" text,
	"BonusCount" integer,
	"Order" integer,
	"GachaId" text,
	"GachaStampSheetGroupId" text
);
--> statement-breakpoint
CREATE TABLE "master_Item" (
	"Id" text NOT NULL,
	"Name" text,
	"AssetId" text,
	"Description" text,
	"HowToGet" text,
	"Type" integer,
	"Value" integer,
	"Order" integer,
	"SalePrice" integer,
	"IsPhotoShootingCharacterOnly" boolean
);
--> statement-breakpoint
CREATE TABLE "master_LoginBonus" (
	"Id" text NOT NULL,
	"Name" text,
	"Description" text,
	"Type" integer,
	"AssetId" text,
	"TopColorCode" text,
	"BottomColorCode" text,
	"Priority" integer,
	"RewardIds" jsonb,
	"OpenConditionId" text,
	"ReceiveConditionId" text
);
--> statement-breakpoint
CREATE TABLE "master_LoginBonusText" (
	"Id" text NOT NULL,
	"CostumeId" text,
	"Text" text
);
--> statement-breakpoint
CREATE TABLE "master_Mission" (
	"Id" text NOT NULL,
	"CategoryType" integer,
	"MissionType" integer,
	"TargetIds" jsonb,
	"Name" text,
	"ShortDescription" text,
	"LongDescription" text,
	"Order" integer,
	"ViewConditionId" text,
	"LinkType" integer,
	"LinkDetail" text,
	"Progresses" jsonb,
	"EventMissionId" text,
	"CompanyEnjoyCharacterId" text,
	"CompanyEnjoyCharacterMissionCategoryType" integer,
	"CompanyTrustMissionCategoryType" integer
);
--> statement-breakpoint
CREATE TABLE "master_Reward" (
	"Id" text NOT NULL,
	"Resources" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_RewardSort" (
	"RewardSortTargetType" integer NOT NULL,
	"RewardSortResourceType" integer NOT NULL,
	"Order" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_id_idx" ON "master_Card" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_level_key_idx" ON "master_CardLevel" USING btree ("Level");--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_parameter_key_idx" ON "master_CardParameter" USING btree ("Id","Level");--> statement-breakpoint
CREATE UNIQUE INDEX "master_event_mission_id_idx" ON "master_EventMission" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_gacha_id_idx" ON "master_Gacha" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_gacha_button_id_idx" ON "master_GachaButton" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_item_id_idx" ON "master_Item" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_login_bonus_id_idx" ON "master_LoginBonus" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_login_bonus_text_id_idx" ON "master_LoginBonusText" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_mission_id_idx" ON "master_Mission" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_reward_id_idx" ON "master_Reward" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_reward_sort_key_idx" ON "master_RewardSort" USING btree ("RewardSortTargetType","RewardSortResourceType");