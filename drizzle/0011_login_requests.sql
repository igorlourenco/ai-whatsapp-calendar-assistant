CREATE TABLE `login_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`phone` text,
	`expires_at` integer NOT NULL,
	`consumed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_requests_code_unique` ON `login_requests` (`code`);--> statement-breakpoint
CREATE INDEX `login_requests_created_idx` ON `login_requests` (`created_at`);