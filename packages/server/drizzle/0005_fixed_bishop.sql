CREATE TABLE "player_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_ledger" ADD CONSTRAINT "player_ledger_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_claims" ADD CONSTRAINT "reward_claims_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_ledger_player_idx" ON "player_ledger" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_claims_player_source_idx" ON "reward_claims" USING btree ("player_id","source_type","source_id");