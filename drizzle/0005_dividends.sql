CREATE TABLE "instruments"."dividends" (
	"symbol" text NOT NULL,
	"ex_date" date NOT NULL,
	"payment_date" date,
	"declaration_date" date,
	"amount" numeric(18, 8),
	"currency" text,
	"status" text NOT NULL,
	"provider" text,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dividends_symbol_ex_date_pk" PRIMARY KEY("symbol","ex_date")
);
--> statement-breakpoint
CREATE TABLE "instruments"."dividends_fetch_state" (
	"symbol" text NOT NULL,
	"scope" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_status" text,
	CONSTRAINT "dividends_fetch_state_symbol_scope_pk" PRIMARY KEY("symbol","scope")
);
--> statement-breakpoint
CREATE INDEX "idx_dividends_symbol_payment" ON "instruments"."dividends" USING btree ("symbol","payment_date");