CREATE TABLE "master_CardDuplicateReward" (
	"InitialRarity" bigint NOT NULL,
	"CurrentRarity" bigint NOT NULL,
	"RewardId" text
);
--> statement-breakpoint
CREATE TABLE "master_Consumption" (
	"Id" text NOT NULL,
	"Resources" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_duplicate_reward_key_idx" ON "master_CardDuplicateReward" USING btree ("InitialRarity","CurrentRarity");--> statement-breakpoint
CREATE UNIQUE INDEX "master_consumption_id_idx" ON "master_Consumption" USING btree ("Id");