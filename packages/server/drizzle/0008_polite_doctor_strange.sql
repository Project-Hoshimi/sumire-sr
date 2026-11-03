CREATE TABLE "master_Accessory" (
	"Id" text NOT NULL,
	"Classification" text,
	"Rarity" bigint,
	"Name" text,
	"CategoryType" bigint,
	"Param1Type" bigint,
	"Param1Value" bigint,
	"SalePrice" bigint
);
--> statement-breakpoint
CREATE TABLE "master_Costume" (
	"Id" text NOT NULL,
	"CharacterId" text,
	"DefaultHairId" text,
	"Name" text,
	"Order" bigint
);
--> statement-breakpoint
CREATE TABLE "master_Hair" (
	"Id" text NOT NULL,
	"CharacterId" text,
	"FittingCostumeId" text,
	"Name" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_accessory_id_idx" ON "master_Accessory" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_costume_id_idx" ON "master_Costume" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_hair_id_idx" ON "master_Hair" USING btree ("Id");