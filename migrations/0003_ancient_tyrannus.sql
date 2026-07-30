CREATE TABLE `dataset_facts_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dataset_id` text NOT NULL,
	`symbol` text NOT NULL,
	`covered_years_json` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dataset_facts_state_dataset_symbol` ON `dataset_facts_state` (`dataset_id`,`symbol`);--> statement-breakpoint
ALTER TABLE `data_import_jobs` ADD `phase` text;--> statement-breakpoint
ALTER TABLE `data_import_jobs` ADD `candles_ms` integer;--> statement-breakpoint
ALTER TABLE `data_import_jobs` ADD `facts_json` text;