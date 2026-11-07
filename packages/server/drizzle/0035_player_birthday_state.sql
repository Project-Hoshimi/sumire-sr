CREATE TABLE "player_birthday_state" (
	"player_id" text PRIMARY KEY NOT NULL,
	"event_year" integer DEFAULT 0 NOT NULL,
	"birthday_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"watched_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claimed_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reminded_year" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_birthday_state" ADD CONSTRAINT "player_birthday_state_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;