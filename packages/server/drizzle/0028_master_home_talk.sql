CREATE TABLE IF NOT EXISTS "master_HomeTalk" (
	"HomeTalkId" text NOT NULL,
	"CharacterId" text,
	"PlaceType" bigint,
	"ConditionId" text,
	"FirstPriority" bigint,
	"Weight" bigint,
	"CallPatternId" text,
	"ChoiceText" text,
	"ManagerText" text,
	"Reliability" bigint,
	"Title" text,
	"CardId" text,
	"DisplayConditionDescription" text,
	"Order" bigint,
	"ReleaseDate" bigint,
	"CharacterTalks" jsonb
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_home_talk_id_idx" ON "master_HomeTalk" USING btree ("HomeTalkId");
