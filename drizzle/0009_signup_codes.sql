CREATE TABLE `signup_codes` (
	`phone` text PRIMARY KEY NOT NULL,
	`code_hash` text,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`sends` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL,
	`last_sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `signup_codes_window_idx` ON `signup_codes` (`window_start`);