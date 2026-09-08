CREATE TABLE "instruments"."news_articles" (
	"url" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"source" text,
	"published_at" timestamp with time zone NOT NULL,
	"symbols" text[] NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_news_symbols" ON "instruments"."news_articles" USING gin ("symbols");--> statement-breakpoint
CREATE INDEX "idx_news_published" ON "instruments"."news_articles" USING btree ("published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_news_expires" ON "instruments"."news_articles" USING btree ("expires_at");