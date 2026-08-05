CREATE TABLE `symbol_master_checkpoint_symbols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checkpoint_id` text NOT NULL,
	`standard_code` text NOT NULL,
	`short_code` text NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`shares_outstanding` text NOT NULL,
	`instrument_type` text NOT NULL,
	`listed_date` text,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `symbol_master_checkpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smcs_checkpoint_code` ON `symbol_master_checkpoint_symbols` (`checkpoint_id`,`standard_code`);--> statement-breakpoint
CREATE TABLE `symbol_master_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`checkpoint_date` text NOT NULL,
	`source` text NOT NULL,
	`verified_at_ms` integer,
	`mismatch_json` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbol_master_checkpoints_checkpoint_date_unique` ON `symbol_master_checkpoints` (`checkpoint_date`);--> statement-breakpoint
CREATE TABLE `symbol_master_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`synced_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_master_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`effective_date` text NOT NULL,
	`standard_code` text NOT NULL,
	`event_type` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`observed_span_start` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sme_effective` ON `symbol_master_events` (`effective_date`);--> statement-breakpoint
CREATE INDEX `idx_sme_code_effective` ON `symbol_master_events` (`standard_code`,`effective_date`);--> statement-breakpoint
CREATE TABLE `symbol_master_market_caps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`standard_code` text NOT NULL,
	`market_cap_krw` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smmc_date_code` ON `symbol_master_market_caps` (`date`,`standard_code`);