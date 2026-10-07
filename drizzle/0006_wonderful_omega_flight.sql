ALTER TABLE "instruments"."split_candidates" ADD COLUMN "effective_date" date;--> statement-breakpoint
ALTER TABLE "instruments"."split_candidates" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "instruments"."split_candidates" ADD COLUMN "provider_numerator" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "instruments"."split_candidates" ADD COLUMN "provider_denominator" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "instruments"."split_candidates" ADD COLUMN "provider_factor" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "instruments"."split_candidates" ADD COLUMN "provider_status" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "instruments"."split_candidates" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "instruments"."split_candidates" ADD COLUMN "applied_at" timestamp with time zone;