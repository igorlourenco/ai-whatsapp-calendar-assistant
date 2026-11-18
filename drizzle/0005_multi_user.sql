CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`all_day` integer NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`category_id` text,
	`location` text,
	`notes` text,
	`recurrence` text,
	`exdates` text DEFAULT '[]' NOT NULL,
	`reminder_minutes` integer,
	`source_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_start_idx` ON `events` (`start_at`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`phone` text,
	`name` text,
	`storage` text DEFAULT 'icloud' NOT NULL,
	`tz` text,
	`morning_at` text,
	`evening_at` text,
	`default_reminder` integer,
	`feed_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`phone` text PRIMARY KEY NOT NULL,
	`name` text,
	`ics_token` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_ics_token_unique` ON `users` (`ics_token`);