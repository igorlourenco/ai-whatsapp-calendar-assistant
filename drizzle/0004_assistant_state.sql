CREATE TABLE "assistant_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"draft" jsonb,
	"draft_at" timestamp with time zone,
	"focus" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"focus_at" timestamp with time zone
);
