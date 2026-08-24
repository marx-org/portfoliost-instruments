CREATE TABLE "instruments"."exchange_reference" (
	"exchange_code" text PRIMARY KEY NOT NULL,
	"operating_mic" text,
	"canonical_name" text,
	"country_code" text,
	"yahoo_suffix" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
