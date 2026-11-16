ALTER TABLE "login_tokens" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "login_tokens" CASCADE;--> statement-breakpoint
ALTER TABLE "reminder_log" DROP CONSTRAINT "reminder_log_event_id_events_id_fk";
--> statement-breakpoint
ALTER TABLE "reminder_log" ALTER COLUMN "event_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "calendar_url" text;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_calendar_url_unique" UNIQUE("calendar_url");