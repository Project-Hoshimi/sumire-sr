DROP INDEX "master_race_panel_reward_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "master_race_panel_reward_key_idx" ON "master_RacePanelReward" USING btree ("Id","RaceId");