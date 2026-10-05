ALTER TABLE "extractions" ADD COLUMN "merchant_brand" text;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD COLUMN "normalized_name" text;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD COLUMN "brand" text;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD COLUMN "size" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "receipt_items" ADD COLUMN "size_unit" text;