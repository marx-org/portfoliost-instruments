CREATE TABLE "instruments"."curated_listing_override_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_key" text NOT NULL,
	"action" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments"."curated_listing_overrides" (
	"listing_key" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"exchange" text NOT NULL,
	"quote_currency" char(3) NOT NULL,
	"asset_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rationale" text NOT NULL,
	"provenance" text NOT NULL,
	"source_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "curated_listing_override_history_listing_idx" ON "instruments"."curated_listing_override_history" USING btree ("listing_key","created_at");--> statement-breakpoint
CREATE INDEX "curated_listing_overrides_ticker_idx" ON "instruments"."curated_listing_overrides" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "curated_listing_overrides_exchange_idx" ON "instruments"."curated_listing_overrides" USING btree ("exchange");--> statement-breakpoint
CREATE INDEX "curated_listing_overrides_status_idx" ON "instruments"."curated_listing_overrides" USING btree ("status");