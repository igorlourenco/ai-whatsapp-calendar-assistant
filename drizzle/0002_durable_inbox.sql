ALTER TABLE "events" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "phone" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "reply" text;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "events_source_msg_idx" ON "events" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "inbound_status_idx" ON "inbound_messages" USING btree ("status","received_at");