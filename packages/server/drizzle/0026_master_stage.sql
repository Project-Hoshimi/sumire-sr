CREATE TABLE IF NOT EXISTS "master_Stage" (
	"Id" text NOT NULL,
	"AssetId" text,
	"Name" text,
	"Order" bigint,
	"Type" bigint
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_stage_id_idx" ON "master_Stage" USING btree ("Id");
