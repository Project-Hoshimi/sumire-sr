CREATE TABLE "player_box_gacha" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"marathon_id" text,
	"box_gacha_id" text NOT NULL,
	"drawn_count" bigint DEFAULT 0 NOT NULL,
	"reset_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_gacha_state" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"gacha_id" text NOT NULL,
	"selected_card_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stamp_sheet_number" integer DEFAULT 0 NOT NULL,
	"stamp_number" integer DEFAULT 0 NOT NULL,
	"total_draw_count" bigint DEFAULT 0 NOT NULL,
	"premium_draw_count" bigint DEFAULT 0 NOT NULL,
	"free_ticket_claimed" boolean DEFAULT false NOT NULL,
	"exchange_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_marathon_point" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"marathon_id" text NOT NULL,
	"point" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_BoxGacha" (
	"Id" text NOT NULL,
	"BoxGachaGroupId" text,
	"Name" text,
	"UnlockConditionId" text,
	"RequiredResourceAmount" bigint,
	"CanReset" boolean,
	"ResetLimitCount" bigint
);
--> statement-breakpoint
CREATE TABLE "master_BoxGachaGroup" (
	"Id" text NOT NULL,
	"RequiredResourceType" bigint,
	"RequiredResourceId" text
);
--> statement-breakpoint
CREATE TABLE "master_GachaExchange" (
	"Id" text NOT NULL,
	"RewardId" text,
	"ExchangeLimit" bigint,
	"RequiredResourceAmount" bigint,
	"Order" bigint,
	"GachaId" text
);
--> statement-breakpoint
CREATE TABLE "master_GachaStamp" (
	"GroupId" text NOT NULL,
	"SheetNumber" bigint NOT NULL,
	"StampNumber" bigint NOT NULL,
	"RewardId" text,
	"RewardGachaButtonId" text,
	"AssetId" text,
	"Description" text,
	"IsFeatured" boolean
);
--> statement-breakpoint
CREATE TABLE "master_GachaStampSheet" (
	"GroupId" text NOT NULL,
	"SheetNumber" bigint NOT NULL,
	"CostumeIds" jsonb
);
--> statement-breakpoint
CREATE TABLE "master_GachaStampSheetGroup" (
	"GroupId" text NOT NULL,
	"AssetId" text
);
--> statement-breakpoint
CREATE TABLE "master_MarathonBoxGachaSetting" (
	"MarathonId" text NOT NULL,
	"BoxGachaId" text NOT NULL,
	"Order" bigint,
	"UnlockRequiredPoint" bigint,
	"GuageColorCode" text,
	"GuageName" text
);
--> statement-breakpoint
ALTER TABLE "player_box_gacha" ADD CONSTRAINT "player_box_gacha_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_gacha_state" ADD CONSTRAINT "player_gacha_state_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_marathon_point" ADD CONSTRAINT "player_marathon_point_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_box_gacha_player_box_idx" ON "player_box_gacha" USING btree ("player_id","box_gacha_id");--> statement-breakpoint
CREATE UNIQUE INDEX "player_gacha_state_player_gacha_idx" ON "player_gacha_state" USING btree ("player_id","gacha_id");--> statement-breakpoint
CREATE UNIQUE INDEX "player_marathon_point_player_marathon_idx" ON "player_marathon_point" USING btree ("player_id","marathon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_box_gacha_id_idx" ON "master_BoxGacha" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_box_gacha_group_id_idx" ON "master_BoxGachaGroup" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_gacha_exchange_id_idx" ON "master_GachaExchange" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_gacha_stamp_key_idx" ON "master_GachaStamp" USING btree ("GroupId","SheetNumber","StampNumber");--> statement-breakpoint
CREATE UNIQUE INDEX "master_gacha_stamp_sheet_key_idx" ON "master_GachaStampSheet" USING btree ("GroupId","SheetNumber");--> statement-breakpoint
CREATE UNIQUE INDEX "master_gacha_stamp_sheet_group_key_idx" ON "master_GachaStampSheetGroup" USING btree ("GroupId");--> statement-breakpoint
CREATE UNIQUE INDEX "master_marathon_box_gacha_setting_key_idx" ON "master_MarathonBoxGachaSetting" USING btree ("MarathonId","BoxGachaId");