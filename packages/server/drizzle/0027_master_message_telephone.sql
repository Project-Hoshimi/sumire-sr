CREATE TABLE IF NOT EXISTS "master_MessageGroup" (
	"Id" text NOT NULL,
	"Name" text,
	"AssetId" text,
	"CharacterIds" jsonb
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_Message" (
	"Id" text NOT NULL,
	"MessageGroupId" text,
	"Name" text,
	"Type" bigint,
	"CharacterId" text,
	"InstantType" bigint,
	"RarityType" bigint,
	"UnlockConditionId" text,
	"Details" jsonb
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_Telephone" (
	"Id" text NOT NULL,
	"MessageGroupId" text,
	"CharacterId" text,
	"Name" text,
	"AssetId" text,
	"UnlockConditionId" text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_message_group_id_idx" ON "master_MessageGroup" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_message_id_idx" ON "master_Message" USING btree ("Id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_telephone_id_idx" ON "master_Telephone" USING btree ("Id");
