CREATE TABLE "merchant_names" (
	"user_id" uuid NOT NULL,
	"variant_key" text NOT NULL,
	"name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_names_user_id_variant_key_pk" PRIMARY KEY("user_id","variant_key")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_names" ADD CONSTRAINT "merchant_names_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;