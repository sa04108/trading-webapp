CREATE TABLE `crypto_datasets` (
	`query_key` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`bars_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `crypto_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`input_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`strategy_version` text NOT NULL,
	`dataset_key` text,
	`executor` text,
	`token` text,
	`deadline_ms` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`result_json` text,
	`error` text,
	FOREIGN KEY (`dataset_key`) REFERENCES `crypto_datasets`(`query_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `crypto_runs_owner` ON `crypto_runs` (`owner_id`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `crypto_runs_queue` ON `crypto_runs` (`status`,`created_at_ms`);