CREATE TABLE `assistant_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`draft` text,
	`pick` text,
	`draft_at` integer,
	`focus` text DEFAULT '[]' NOT NULL,
	`focus_at` integer
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`emoji` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`calendar_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_calendar_url_unique` ON `categories` (`calendar_url`);--> statement-breakpoint
CREATE TABLE `digest_log` (
	`kind` text NOT NULL,
	`local_date` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `local_date`)
);
--> statement-breakpoint
CREATE TABLE `inbound_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`reply` text,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE INDEX `inbound_status_idx` ON `inbound_messages` (`status`,`received_at`);--> statement-breakpoint
CREATE TABLE `message_events` (
	`message_id` text NOT NULL,
	`event_id` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `event_id`)
);
--> statement-breakpoint
CREATE TABLE `reminder_log` (
	`event_id` text NOT NULL,
	`occurrence_start` integer NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `occurrence_start`)
);
