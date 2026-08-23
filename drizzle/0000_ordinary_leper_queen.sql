CREATE SCHEMA "instruments";
--> statement-breakpoint
CREATE TABLE "instruments"."ticker_reference" (
	"listing_key" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"exchange" text NOT NULL,
	"name" text NOT NULL,
	"asset_type" text NOT NULL,
	"stock_sector" text,
	"etf_category" text,
	"country" text,
	"country_code" text,
	"isin" text,
	"aliases" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ticker_reference_ticker_idx" ON "instruments"."ticker_reference" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "ticker_reference_isin_idx" ON "instruments"."ticker_reference" USING btree ("isin");