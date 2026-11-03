CREATE TABLE IF NOT EXISTS "master_Emblem" (
	"Id" text NOT NULL,
	"Name" text,
	"AssetId" text,
	"AutoProvideConditionId" text,
	"IsViewableInInactive" boolean,
	"Order" bigint,
	"Description" text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_emblem_id_idx" ON "master_Emblem" USING btree ("Id");
