CREATE TABLE `data_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dataset_id` text NOT NULL,
	`symbol` text NOT NULL,
	`first_ts_ms` integer,
	`last_ts_ms` integer,
	`bar_count` integer DEFAULT 0 NOT NULL,
	`expected_bar_count` integer,
	`missing_ranges_json` text,
	`computed_at_ms` integer NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_data_coverage_dataset_symbol` ON `data_coverage` (`dataset_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `data_import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`status` text NOT NULL,
	`source_type` text NOT NULL,
	`file_name` text,
	`symbol` text,
	`rows_imported` integer,
	`error` text,
	`created_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_data_import_jobs_dataset` ON `data_import_jobs` (`dataset_id`);--> statement-breakpoint
CREATE TABLE `data_sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`status` text NOT NULL,
	`detail_json` text,
	`created_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `dataset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`note` text,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dataset_versions_dataset` ON `dataset_versions` (`dataset_id`);--> statement-breakpoint
CREATE TABLE `datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`timeframe` text NOT NULL,
	`symbols_json` text NOT NULL,
	`description` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datasets_name_unique` ON `datasets` (`name`);