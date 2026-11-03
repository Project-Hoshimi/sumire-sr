CREATE TABLE "player_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"kind" text NOT NULL,
	"entity_key" text NOT NULL,
	"ordinal" integer NOT NULL,
	"blob" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_entities" ADD CONSTRAINT "player_entities_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_entities_player_kind_key_idx" ON "player_entities" USING btree ("player_id","kind","entity_key");--> statement-breakpoint
CREATE INDEX "player_entities_player_kind_idx" ON "player_entities" USING btree ("player_id","kind");