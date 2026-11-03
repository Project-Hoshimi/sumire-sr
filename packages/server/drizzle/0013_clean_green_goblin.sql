CREATE TABLE "master_CardLevelRelease" (
	"Id" text NOT NULL,
	"Level" bigint NOT NULL,
	"Targets" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_level_release_key_idx" ON "master_CardLevelRelease" USING btree ("Id","Level");