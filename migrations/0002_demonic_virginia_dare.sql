CREATE TABLE `universe_snapshot_symbols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` text NOT NULL,
	`standard_code` text NOT NULL,
	`short_code` text NOT NULL,
	`name_at_selection` text NOT NULL,
	`market_at_selection` text NOT NULL,
	`market_cap_krw` text,
	`rank` integer,
	`instrument_type` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `universe_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_universe_snapshot_symbols_snap_code` ON `universe_snapshot_symbols` (`snapshot_id`,`standard_code`);--> statement-breakpoint
CREATE INDEX `idx_universe_snapshot_symbols_snap` ON `universe_snapshot_symbols` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `universe_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_kind` text NOT NULL,
	`requested_date` text NOT NULL,
	`effective_trading_date` text NOT NULL,
	`usable_from_date` text NOT NULL,
	`usable_from_rule` text NOT NULL,
	`markets_json` text NOT NULL,
	`filter_policy_version` text NOT NULL,
	`contract_version` text NOT NULL,
	`sort_key` text NOT NULL,
	`sort_direction` text NOT NULL,
	`selection_method` text NOT NULL,
	`selection_n` integer,
	`selected_count` integer NOT NULL,
	`eligible_count` integer NOT NULL,
	`unknown_market_cap_count` integer NOT NULL,
	`excluded_by_type_json` text NOT NULL,
	`raw_counts_json` text NOT NULL,
	`selection_hash` text NOT NULL,
	`candidate_canonical_hash` text NOT NULL,
	`krx_approval_expiry_date` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_universe_snapshots_created` ON `universe_snapshots` (`created_at_ms`);--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `universe_snapshot_id` text;--> statement-breakpoint
ALTER TABLE `backtest_jobs` ADD `provenance_pin_json` text;--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `provenance_pin_json` text;--> statement-breakpoint
ALTER TABLE `symbols` ADD `standard_code` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_symbols_standard_code` ON `symbols` (`standard_code`);