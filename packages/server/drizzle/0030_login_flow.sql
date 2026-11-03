CREATE TABLE IF NOT EXISTS "account_credentials" (
	"account_id" text PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"onetime_token_hash" text,
	"onetime_expires_at" timestamp with time zone,
	"onetime_target_uid" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invites_token_hash_idx" ON "invites" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
