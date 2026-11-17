CREATE TABLE `shopping_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`bought_at` integer
);
--> statement-breakpoint
CREATE INDEX `shopping_status_idx` ON `shopping_items` (`status`,`created_at`);