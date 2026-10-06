CREATE TABLE "instruments"."fundamentals_fetch_state" (
	"symbol" text NOT NULL,
	"scope" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_status" text,
	CONSTRAINT "fundamentals_fetch_state_symbol_scope_pk" PRIMARY KEY("symbol","scope")
);
--> statement-breakpoint
CREATE TABLE "instruments"."fundamentals_metrics" (
	"symbol" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments"."fundamentals_statements" (
	"symbol" text NOT NULL,
	"statement" text NOT NULL,
	"period" text NOT NULL,
	"period_key" text NOT NULL,
	"period_end" date,
	"fiscal_year" integer,
	"fiscal_period" text,
	"provider" text,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fundamentals_statements_symbol_statement_period_period_key_pk" PRIMARY KEY("symbol","statement","period","period_key")
);
--> statement-breakpoint
CREATE INDEX "idx_fundamentals_symbol_period" ON "instruments"."fundamentals_statements" USING btree ("symbol","period","period_end" DESC NULLS LAST);