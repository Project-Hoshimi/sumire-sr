CREATE TABLE "master_CardDuplicateExp" (
	"InitialRarity" bigint NOT NULL,
	"Exp" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "master_card_duplicate_exp_key_idx" ON "master_CardDuplicateExp" USING btree ("InitialRarity");