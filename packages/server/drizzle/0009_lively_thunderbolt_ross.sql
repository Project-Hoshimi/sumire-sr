CREATE TABLE "master_AccessoryEnhancement" (
	"Rarity" bigint NOT NULL,
	"RequiredGold" bigint
);
--> statement-breakpoint
CREATE TABLE "master_ActivityAbility" (
	"Id" text NOT NULL,
	"Name" text,
	"Levels" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_CardRank" (
	"Rank" bigint NOT NULL,
	"IsDataExist" boolean,
	"LevelLimitUpAmount" bigint,
	"RequiredExp" bigint
);
--> statement-breakpoint
CREATE TABLE "master_CardRarity" (
	"Rarity" bigint NOT NULL,
	"LevelLimit" bigint,
	"ParameterBonusPermil" bigint,
	"RequiredExp" bigint
);
--> statement-breakpoint
CREATE TABLE "master_CardSupportRelease" (
	"Count" bigint NOT NULL,
	"ItemId" text,
	"ItemAmount" bigint,
	"StoneAmount" bigint
);
--> statement-breakpoint
CREATE TABLE "master_LiveAbility" (
	"Id" text NOT NULL,
	"Name" text,
	"Levels" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_PhotoAbility" (
	"Id" text NOT NULL,
	"Name" text,
	"Description" text,
	"AbilityType" bigint,
	"PhotoAbilityLevels" jsonb,
	"PhotoAbilityGrades" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_PhotoRarityLevel" (
	"Rarity" bigint NOT NULL,
	"Level" bigint NOT NULL,
	"DeleteRewardItem" text,
	"RerollRequiredItem" bigint,
	"EnhanceRequiredItem" bigint
);
--> statement-breakpoint
CREATE TABLE "master_PhotoRecipe" (
	"Id" text NOT NULL,
	"Name" text,
	"Description" text,
	"Level" bigint,
	"PhotoAbilitySetId" text,
	"RetouchConsumptionId" text,
	"SaleRewardId" text,
	"PhotoRetouchEnhanceGroupId" text,
	"MinPhotoLevel" bigint,
	"MaxPhotoLevel" bigint,
	"Order" bigint
);
--> statement-breakpoint
CREATE TABLE "master_PhotoRetouchEnhance" (
	"GroupId" text NOT NULL,
	"PhotoLevel" bigint NOT NULL,
	"ConsumptionId" text
);
--> statement-breakpoint
CREATE TABLE "master_Setting" (
	"Id" text NOT NULL,
	"AccessoryEnhancesRequiredMaterialAmount" bigint,
	"AccessoryLimit" bigint,
	"CardResetStoneAmount" bigint,
	"CardSupportLevelLimit" bigint,
	"CardSupportRemovableMinutes" bigint,
	"PhotoDeleteAmountLimit" bigint,
	"PhotoDefaultLimit" bigint,
	"PhotoLimitExtendAmount" bigint,
	"PhotoLimitExtendStone" bigint,
	"PhotoLimitExtendLimit" bigint,
	"PhotoRecipeLimit" bigint,
	"PhotoRecipeSaleAmountLimit" bigint,
	"GoldLimit" bigint,
	"ItemLimit" bigint,
	"FreeStoneLimit" bigint,
	"PaidStoneLimit" bigint,
	"CardStaminaBarMax" bigint
);
--> statement-breakpoint
CREATE TABLE "master_Skill" (
	"Id" text NOT NULL,
	"Name" text,
	"CategoryType" bigint,
	"Levels" jsonb,
	"AssetId" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_accessory_enhancement_key_idx" ON "master_AccessoryEnhancement" USING btree ("Rarity");--> statement-breakpoint
CREATE UNIQUE INDEX "master_activity_ability_id_idx" ON "master_ActivityAbility" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_rank_key_idx" ON "master_CardRank" USING btree ("Rank");--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_rarity_key_idx" ON "master_CardRarity" USING btree ("Rarity");--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_support_release_key_idx" ON "master_CardSupportRelease" USING btree ("Count");--> statement-breakpoint
CREATE UNIQUE INDEX "master_live_ability_id_idx" ON "master_LiveAbility" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_ability_id_idx" ON "master_PhotoAbility" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_rarity_level_key_idx" ON "master_PhotoRarityLevel" USING btree ("Rarity","Level");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_recipe_id_idx" ON "master_PhotoRecipe" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_photo_retouch_enhance_key_idx" ON "master_PhotoRetouchEnhance" USING btree ("GroupId","PhotoLevel");--> statement-breakpoint
CREATE UNIQUE INDEX "master_setting_id_idx" ON "master_Setting" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_skill_id_idx" ON "master_Skill" USING btree ("Id");