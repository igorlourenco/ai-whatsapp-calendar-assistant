ALTER TABLE `assistant_state` ADD `batch` text;--> statement-breakpoint
ALTER TABLE `assistant_state` ADD `batch_at` integer;--> statement-breakpoint
ALTER TABLE `inbound_messages` ADD `media_url` text;--> statement-breakpoint
ALTER TABLE `inbound_messages` ADD `media_mime` text;