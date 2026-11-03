-- Idempotent: dev databases migrated from the quest branches already have this table.
CREATE TABLE IF NOT EXISTS "photo_image_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"public_user_id" text NOT NULL,
	"upload_id" text NOT NULL,
	"upload_state" text NOT NULL,
	"finalization_id" text,
	"upload_state_updated_at" timestamp with time zone NOT NULL,
	"upload_expires_at" timestamp with time zone,
	"name" text NOT NULL,
	"bucket" text NOT NULL,
	"generation" text DEFAULT '' NOT NULL,
	"metageneration" text DEFAULT '' NOT NULL,
	"content_type" text NOT NULL,
	"time_created" text DEFAULT '' NOT NULL,
	"updated" text DEFAULT '' NOT NULL,
	"storage_class" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"md5_hash" text DEFAULT '' NOT NULL,
	"content_encoding" text DEFAULT '' NOT NULL,
	"content_disposition" text DEFAULT '' NOT NULL,
	"crc32c" text DEFAULT '' NOT NULL,
	"etag" text DEFAULT '' NOT NULL,
	"download_tokens" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "photo_image_metadata" ADD CONSTRAINT "photo_image_metadata_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "photo_image_metadata_player_idx" ON "photo_image_metadata" USING btree ("player_id");