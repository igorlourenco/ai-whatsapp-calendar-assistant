ALTER TABLE `categories` ADD `description` text;--> statement-breakpoint
ALTER TABLE `categories` ADD `is_default` integer DEFAULT false NOT NULL;