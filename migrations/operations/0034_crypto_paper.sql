CREATE TABLE `crypto_paper_accounts` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`source_run_id` text NOT NULL,
	`initial_cash` real NOT NULL,
	`cash` real NOT NULL,
	`holding_json` text,
	`active` integer DEFAULT 0 NOT NULL,
	`active_from_ms` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`last_session` text,
	`updated_at_ms` integer NOT NULL,
	`valued_at_ms` integer,
	`error` text,
	FOREIGN KEY (`source_run_id`) REFERENCES `crypto_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `crypto_paper_fills` (
	`owner_id` text NOT NULL,
	`date` text NOT NULL,
	`sequence` integer NOT NULL,
	`fill_json` text NOT NULL,
	PRIMARY KEY(`owner_id`, `date`, `sequence`),
	FOREIGN KEY (`owner_id`) REFERENCES `crypto_paper_accounts`(`owner_id`) ON UPDATE no action ON DELETE no action
);
