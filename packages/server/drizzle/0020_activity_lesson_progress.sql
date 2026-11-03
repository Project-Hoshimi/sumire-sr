CREATE TABLE "player_lesson_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"step_reward_gold" integer DEFAULT 0 NOT NULL,
	"step_reward_manager_exp" integer DEFAULT 0 NOT NULL,
	"step_reward_card_enhance_item" integer DEFAULT 0 NOT NULL,
	"reward_gold" integer DEFAULT 0 NOT NULL,
	"reward_manager_exp" integer DEFAULT 0 NOT NULL,
	"reward_card_enhance_item" integer DEFAULT 0 NOT NULL,
	"last_receive_time" bigint DEFAULT 0 NOT NULL,
	"max_reward_time" bigint DEFAULT 0 NOT NULL,
	"daily_promote_count" integer DEFAULT 0 NOT NULL,
	"current_area_id" text DEFAULT 'area-main-001' NOT NULL,
	"campaign_effects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"daily_state_day" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "master_Setting" ADD COLUMN "SecondsPerActivityLessonStep" bigint;--> statement-breakpoint
ALTER TABLE "player_lesson_progress" ADD CONSTRAINT "player_lesson_progress_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_lesson_progress_player_idx" ON "player_lesson_progress" USING btree ("player_id");