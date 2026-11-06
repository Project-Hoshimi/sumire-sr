ALTER TABLE "player_love_progress" ADD COLUMN "story_episode_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "player_love_progress" ADD COLUMN "selections" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "player_love_progress" ADD COLUMN "past_selections" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "player_love_progress" ADD COLUMN "active_story_episode_id" text DEFAULT '' NOT NULL;
