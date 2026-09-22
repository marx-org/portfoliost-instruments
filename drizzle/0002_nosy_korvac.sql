CREATE TABLE "instruments"."fx_rates" (
	"rate_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"source" text DEFAULT 'ecb' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_rate_date_currency_pk" PRIMARY KEY("rate_date","currency")
);
--> statement-breakpoint
CREATE TABLE "instruments"."fx_sync_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_rate_date" date,
	"last_run_at" timestamp with time zone,
	"last_status" text
);
