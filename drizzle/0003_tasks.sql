CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`due_date` text,
	`due_time` text,
	`recurrence` text,
	`notes` text,
	`status` text DEFAULT 'open' NOT NULL,
	`reminded_at` integer,
	`created_at` integer NOT NULL,
	`done_at` integer
);
--> statement-breakpoint
CREATE INDEX `tasks_status_due_idx` ON `tasks` (`status`,`due_date`);--> statement-breakpoint
ALTER TABLE `assistant_state` ADD `task_focus` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_state` ADD `task_focus_at` integer;--> statement-breakpoint
ALTER TABLE `assistant_state` ADD `last_list` text;