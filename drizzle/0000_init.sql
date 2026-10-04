CREATE TYPE "public"."ai_mode" AS ENUM('platform', 'byok');--> statement-breakpoint
CREATE TYPE "public"."extraction_method" AS ENUM('llm', 'manual');--> statement-breakpoint
CREATE TYPE "public"."key_source" AS ENUM('platform', 'user');--> statement-breakpoint
CREATE TYPE "public"."llm_operation" AS ENUM('extract', 'reextract', 'key_test');--> statement-breakpoint
CREATE TYPE "public"."receipt_source" AS ENUM('camera', 'file', 'manual');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('pending_upload', 'uploaded', 'processing', 'extracted', 'failed');--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"method" "extraction_method" NOT NULL,
	"provider" text,
	"model" text,
	"key_source" "key_source",
	"prompt_version" text,
	"raw_json" jsonb NOT NULL,
	"merchant_name" text,
	"merchant_vat" text,
	"merchant_address" text,
	"purchased_at" timestamp with time zone,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"total" numeric(12, 2),
	"tax_total" numeric(12, 2),
	"payment_method" text,
	"category" text,
	"confidence" real,
	"notes" text,
	"is_current" boolean DEFAULT true NOT NULL,
	"edited_by_user" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extractions_id_user_uq" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "receipt_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extraction_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(10, 3),
	"unit_price" numeric(12, 2),
	"amount" numeric(12, 2),
	"vat_rate" numeric(5, 2),
	"category" text
);
--> statement-breakpoint
CREATE TABLE "receipts_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "receipt_source" NOT NULL,
	"storage_path" text,
	"original_filename" text,
	"sha256" text,
	"mime_type" text,
	"size_bytes" integer,
	"captured_at" timestamp with time zone,
	"status" "receipt_status" NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_raw_storage_path_unique" UNIQUE("storage_path"),
	CONSTRAINT "receipts_raw_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "receipts_raw_file_check" CHECK ("receipts_raw"."source" = 'manual' or ("receipts_raw"."storage_path" is not null and "receipts_raw"."sha256" is not null)),
	CONSTRAINT "receipts_raw_storage_path_owner_check" CHECK ("receipts_raw"."storage_path" is null or starts_with("receipts_raw"."storage_path", "receipts_raw"."user_id"::text || '/'))
);
--> statement-breakpoint
CREATE TABLE "user_ai_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mode" "ai_mode" DEFAULT 'platform' NOT NULL,
	"provider" text,
	"model" text,
	"fallback_to_platform" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer NOT NULL,
	"last4" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_api_keys_user_provider_uq" UNIQUE("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"receipt_id" uuid,
	"extraction_id" uuid,
	"operation" "llm_operation" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"key_source" "key_source" NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer NOT NULL,
	"success" boolean NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_per_mtok_usd" numeric(12, 6) NOT NULL,
	"output_per_mtok_usd" numeric(12, 6) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_prices_provider_model_pk" PRIMARY KEY("provider","model")
);
--> statement-breakpoint
CREATE TABLE "stats_monthly" (
	"user_id" uuid NOT NULL,
	"month" date NOT NULL,
	"category" text NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"n_receipts" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stats_monthly_user_id_month_category_pk" PRIMARY KEY("user_id","month","category")
);
--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_receipt_owner_fk" FOREIGN KEY ("receipt_id","user_id") REFERENCES "public"."receipts_raw"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_extraction_owner_fk" FOREIGN KEY ("extraction_id","user_id") REFERENCES "public"."extractions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts_raw" ADD CONSTRAINT "receipts_raw_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_receipt_id_receipts_raw_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts_raw"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stats_monthly" ADD CONSTRAINT "stats_monthly_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extractions_current_uq" ON "extractions" USING btree ("receipt_id") WHERE "extractions"."is_current";--> statement-breakpoint
CREATE INDEX "extractions_receipt_idx" ON "extractions" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "extractions_user_purchased_idx" ON "extractions" USING btree ("user_id","purchased_at");--> statement-breakpoint
CREATE INDEX "receipt_items_extraction_idx" ON "receipt_items" USING btree ("extraction_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_raw_user_sha256_uq" ON "receipts_raw" USING btree ("user_id","sha256") WHERE "receipts_raw"."sha256" is not null;--> statement-breakpoint
CREATE INDEX "receipts_raw_user_created_idx" ON "receipts_raw" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "llm_usage_user_created_idx" ON "llm_usage" USING btree ("user_id","created_at" DESC NULLS LAST);