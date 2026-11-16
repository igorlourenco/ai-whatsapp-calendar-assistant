CREATE TABLE "message_events" (
	"message_id" text NOT NULL,
	"event_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_events_message_id_event_id_pk" PRIMARY KEY("message_id","event_id")
);
