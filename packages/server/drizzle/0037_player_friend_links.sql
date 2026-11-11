CREATE TABLE "player_friend_links" (
	"from_player_id" text NOT NULL,
	"to_player_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_friend_links" ADD CONSTRAINT "player_friend_links_from_player_id_players_id_fk" FOREIGN KEY ("from_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_friend_links" ADD CONSTRAINT "player_friend_links_to_player_id_players_id_fk" FOREIGN KEY ("to_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_friend_links_pair_idx" ON "player_friend_links" USING btree ("from_player_id","to_player_id");--> statement-breakpoint
CREATE INDEX "player_friend_links_to_idx" ON "player_friend_links" USING btree ("to_player_id");