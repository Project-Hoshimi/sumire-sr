CREATE TABLE "master_ShowcaseFrame" (
	"Id" text NOT NULL,
	"Order" bigint,
	"Name" text,
	"Description" text,
	"AssetId" text,
	"UnlockConditionId" text,
	"ShowcaseToyPutCountLimit" bigint
);
--> statement-breakpoint
CREATE TABLE "master_ShowcaseHashtag" (
	"Id" text NOT NULL,
	"Number" bigint,
	"Name" text,
	"AssetId" text,
	"CategoryType" bigint
);
--> statement-breakpoint
CREATE TABLE "master_ShowcaseMusic" (
	"MusicId" text NOT NULL,
	"Order" bigint,
	"ShowcaseMusicFilterId" text
);
--> statement-breakpoint
CREATE TABLE "master_ShowcaseMusicFilter" (
	"Id" text NOT NULL,
	"Name" text,
	"Order" bigint
);
--> statement-breakpoint
CREATE TABLE "master_ShowcaseSetting" (
	"Id" text NOT NULL,
	"RewardLikeObtainLimit" bigint,
	"LikeCountLimit" bigint,
	"ShowcaseToyObtainLimit" bigint,
	"ShowcaseDetailNameLimit" bigint,
	"ShowcaseDetailDescriptionLimit" bigint,
	"ShowcaseMysetNameLimit" bigint,
	"ShowcaseFrameDefaultId" text,
	"RewardLikeDailyRecovery" bigint,
	"ShowcaseUndoCountLimit" bigint,
	"ShowcaseThumbnailDefaultAssetId" text,
	"RewardLikeUsedRewardId" text,
	"DefaultShowcaseToyShopConsumptionItemId" text
);
--> statement-breakpoint
CREATE TABLE "master_ShowcaseToy" (
	"Id" text NOT NULL,
	"FilterIds" jsonb,
	"CategoryId" text,
	"Name" text,
	"AssetId" text,
	"Description" text,
	"HashTagIds" jsonb,
	"PutTypes" jsonb,
	"Order" bigint,
	"PhotoShootingCharacterIds" jsonb,
	"Angle" bigint
);
--> statement-breakpoint
CREATE TABLE "master_ShowcaseToyCategory" (
	"Id" text NOT NULL,
	"Order" bigint,
	"Name" text
);
--> statement-breakpoint
CREATE TABLE "master_ShowcaseToyShopFilter" (
	"Id" text NOT NULL,
	"Name" text,
	"Order" bigint,
	"AssetId" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_showcase_frame_id_idx" ON "master_ShowcaseFrame" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_showcase_hashtag_id_idx" ON "master_ShowcaseHashtag" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_showcase_music_music_id_idx" ON "master_ShowcaseMusic" USING btree ("MusicId");--> statement-breakpoint
CREATE UNIQUE INDEX "master_showcase_music_filter_id_idx" ON "master_ShowcaseMusicFilter" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_showcase_setting_id_idx" ON "master_ShowcaseSetting" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_showcase_toy_id_idx" ON "master_ShowcaseToy" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_showcase_toy_category_id_idx" ON "master_ShowcaseToyCategory" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_showcase_toy_shop_filter_id_idx" ON "master_ShowcaseToyShopFilter" USING btree ("Id");