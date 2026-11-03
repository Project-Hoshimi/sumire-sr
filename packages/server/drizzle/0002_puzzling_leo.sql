DROP INDEX "player_entities_player_kind_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "player_entities_player_kind_ordinal_idx" ON "player_entities" USING btree ("player_id","kind","ordinal");