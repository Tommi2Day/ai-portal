CREATE TYPE "public"."knowledge_source_type" AS ENUM('upload', 'filesystem', 'confluence', 'sharepoint');--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector,
	"embedding_dim" integer,
	"embedding_model" text,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
--> statement-breakpoint
CREATE TABLE "knowledge_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"public" boolean DEFAULT false NOT NULL,
	"allowed_groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"mime_type" text,
	"version" text,
	"sha256" text,
	"size" integer,
	"data" "bytea",
	"status" text DEFAULT 'indexed' NOT NULL,
	"error" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"embedding_model" text,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"type" "knowledge_source_type" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text,
	"sync_interval_minutes" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"last_stats" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "groups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_collection_id_knowledge_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."knowledge_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_collection_id_knowledge_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."knowledge_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kchunk_doc_idx" ON "knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "kchunk_collection_idx" ON "knowledge_chunks" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "kchunk_tsv_idx" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "kdoc_source_ext_uq" ON "knowledge_documents" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "kdoc_collection_idx" ON "knowledge_documents" USING btree ("collection_id");