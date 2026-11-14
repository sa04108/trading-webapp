CREATE TABLE `intraday_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`symbol` text NOT NULL,
	`period_json` text NOT NULL,
	`status` text NOT NULL,
	`fetched_bars` integer DEFAULT 0 NOT NULL,
	`pages` integer DEFAULT 0 NOT NULL,
	`oldest_end_ms` integer,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `intraday_collections_owner` ON `intraday_collections` (`owner_id`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `intraday_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`request_json` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`result_json` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `intraday_runs_owner` ON `intraday_runs` (`owner_id`,`created_at_ms`);