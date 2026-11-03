CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"firebase_uid" text,
	"seed_id" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"is_banned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deck_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"deck_number" integer NOT NULL,
	"leader_card_id" text,
	"member_card_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gacha_history" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"gacha_master_id" text NOT NULL,
	"draw_count" integer NOT NULL,
	"cost_type" text NOT NULL,
	"cost_amount" integer NOT NULL,
	"drawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idol_roster" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"master_id" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"affection" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_stage_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"stage_master_id" text NOT NULL,
	"high_score" bigint DEFAULT 0 NOT NULL,
	"best_rank" integer,
	"cleared" boolean DEFAULT false NOT NULL,
	"full_combo" boolean DEFAULT false NOT NULL,
	"clear_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owned_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"master_id" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"exp" bigint DEFAULT 0 NOT NULL,
	"limit_break_phase" integer DEFAULT 0 NOT NULL,
	"skill_level" integer DEFAULT 1 NOT NULL,
	"duplicated_count" integer DEFAULT 0 NOT NULL,
	"attachment" integer DEFAULT 0 NOT NULL,
	"gacha_history_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"exp" bigint DEFAULT 0 NOT NULL,
	"gold" bigint DEFAULT 0 NOT NULL,
	"free_jewel" bigint DEFAULT 0 NOT NULL,
	"paid_jewel" bigint DEFAULT 0 NOT NULL,
	"stamina" integer DEFAULT 0 NOT NULL,
	"stamina_max" integer DEFAULT 0 NOT NULL,
	"last_stamina_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deck_configurations" ADD CONSTRAINT "deck_configurations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gacha_history" ADD CONSTRAINT "gacha_history_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idol_roster" ADD CONSTRAINT "idol_roster_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_stage_progress" ADD CONSTRAINT "live_stage_progress_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_cards" ADD CONSTRAINT "owned_cards_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_firebase_uid_idx" ON "accounts" USING btree ("firebase_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "deck_player_number_idx" ON "deck_configurations" USING btree ("player_id","deck_number");--> statement-breakpoint
CREATE INDEX "gacha_history_player_idx" ON "gacha_history" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idol_roster_player_master_idx" ON "idol_roster" USING btree ("player_id","master_id");--> statement-breakpoint
CREATE UNIQUE INDEX "live_stage_player_master_idx" ON "live_stage_progress" USING btree ("player_id","stage_master_id");--> statement-breakpoint
CREATE INDEX "owned_cards_player_idx" ON "owned_cards" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_account_id_idx" ON "players" USING btree ("account_id");