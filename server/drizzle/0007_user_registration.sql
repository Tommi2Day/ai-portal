ALTER TABLE "users" ADD COLUMN "pending_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_completed" boolean DEFAULT true NOT NULL;