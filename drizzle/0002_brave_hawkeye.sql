CREATE TABLE "instruments"."logos" (
	"symbol" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"remote_url" text NOT NULL,
	"file" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refresh_after" timestamp with time zone NOT NULL
);
