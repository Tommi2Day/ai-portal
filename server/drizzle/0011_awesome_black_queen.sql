ALTER TABLE "knowledge_sources" ADD COLUMN "replace_on_sync" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "trigger_token_hash" text;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "trigger_token_created_at" timestamp with time zone;