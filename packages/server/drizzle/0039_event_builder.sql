CREATE TABLE "event_definition_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"version" integer NOT NULL,
	"published" jsonb NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"published_version" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_schedule" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"exchange_ends_at" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_definition_history" ADD CONSTRAINT "event_definition_history_event_id_event_definitions_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_schedule" ADD CONSTRAINT "event_schedule_event_id_event_definitions_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_definition_history_event_version_idx" ON "event_definition_history" USING btree ("event_id","version");--> statement-breakpoint
CREATE INDEX "event_schedule_event_id_idx" ON "event_schedule" USING btree ("event_id");