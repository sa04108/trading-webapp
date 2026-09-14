-- 워커에 배포할 계산 입력 데이터 전용 스키마
CREATE TABLE `benchmark_daily_values` (
	`benchmark_id` text NOT NULL,
	`date` text NOT NULL,
	`close` real NOT NULL,
	`synced_at_ms` integer NOT NULL,
	PRIMARY KEY(`benchmark_id`, `date`)
);
--> statement-breakpoint
CREATE TABLE `daily_selection_metric_coverage` (
	`date` text PRIMARY KEY NOT NULL,
	`synced_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_selection_metrics` (
	`date` text NOT NULL,
	`standard_code` text NOT NULL,
	`market_cap_krw` text,
	`volume` integer,
	`trading_value_krw` text,
	PRIMARY KEY(`date`, `standard_code`)
);
--> statement-breakpoint
CREATE TABLE `dart_financial_filing_receipts` (
	`receipt_no` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`business_year` integer NOT NULL,
	`receipt_date` text NOT NULL,
	`processed_at_ms` integer NOT NULL,
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `facts` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`field` text NOT NULL,
	`period_key` text NOT NULL,
	`as_of_ts_ms` integer NOT NULL,
	`value` real NOT NULL,
	`unit` text NOT NULL,
	`corporate_action_before_shares` integer,
	`corporate_action_after_shares` integer,
	PRIMARY KEY(`scope`, `key`, `field`, `period_key`, `as_of_ts_ms`),
	CONSTRAINT "chk_facts_scope" CHECK("facts"."scope" IN ('SYMBOL', 'MACRO'))
);
--> statement-breakpoint
CREATE TABLE `fred_benchmark_coverage` (
	`benchmark_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`synced_at_ms` integer NOT NULL,
	PRIMARY KEY(`benchmark_id`, `start_date`, `end_date`)
);
--> statement-breakpoint
CREATE TABLE `krx_daily_bars` (
	`short_code` text NOT NULL,
	`date` text NOT NULL,
	`market` text NOT NULL,
	`open` integer NOT NULL,
	`high` integer NOT NULL,
	`low` integer NOT NULL,
	`close` integer NOT NULL,
	`volume` integer NOT NULL,
	PRIMARY KEY(`short_code`, `date`)
);
--> statement-breakpoint
CREATE TABLE `krx_non_trading_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`synced_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `krx_non_trading_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`short_code` text NOT NULL,
	`market` text NOT NULL,
	`last_close` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preparation_data_revision` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`armed` integer DEFAULT false NOT NULL,
	CONSTRAINT "chk_preparation_revision_singleton" CHECK("preparation_data_revision"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `symbol_facts_state` (
	`code` text PRIMARY KEY NOT NULL,
	`covered_years_json` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`action_covered_years_json` text,
	`action_gap_years_json` text,
	`financial_updated_at_ms` integer,
	`action_updated_at_ms` integer,
	`financial_coverage_protocol_json` text,
	`action_coverage_protocol_json` text,
	`action_gap_details_json` text,
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `symbol_master_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`checkpoint_date` text NOT NULL,
	`source` text NOT NULL,
	`verified_at_ms` integer,
	`mismatch_json` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE `symbol_master_market_caps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`standard_code` text NOT NULL,
	`market_cap_krw` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_master_storage_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`migrated_at_ms` integer,
	CONSTRAINT "chk_sms_singleton" CHECK("symbol_master_storage_state"."singleton" = 1),
	CONSTRAINT "chk_sms_phase" CHECK("symbol_master_storage_state"."phase" IN ('PENDING', 'ACTIVE'))
);
--> statement-breakpoint
CREATE TABLE `symbol_master_trading_days` (
	`date` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_master_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`standard_code` text NOT NULL,
	`valid_from_date` text NOT NULL,
	`valid_to_date` text,
	`short_code` text NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`shares_outstanding` text NOT NULL,
	`instrument_type` text NOT NULL,
	`listed_date` text,
	`recorded_at_ms` integer NOT NULL,
	CONSTRAINT "chk_smv_valid_range" CHECK("symbol_master_versions"."valid_to_date" IS NULL OR "symbol_master_versions"."valid_to_date" > "symbol_master_versions"."valid_from_date")
);
--> statement-breakpoint
CREATE TABLE `symbol_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`slice` text NOT NULL,
	`version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `symbols` (
	`code` text PRIMARY KEY NOT NULL,
	`market` text NOT NULL,
	`name` text,
	`created_at_ms` integer NOT NULL,
	`standard_code` text
);
--> statement-breakpoint
CREATE INDEX `idx_benchmark_daily_values_date` ON `benchmark_daily_values` (`date`);
--> statement-breakpoint
CREATE INDEX `idx_dart_financial_filing_receipts_code_year` ON `dart_financial_filing_receipts` (`code`,`business_year`);
--> statement-breakpoint
CREATE INDEX `idx_facts_pit` ON `facts` (`scope`,`key`,`field`,`as_of_ts_ms`);
--> statement-breakpoint
CREATE INDEX `idx_kntd_date` ON `krx_non_trading_days` (`date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kntd_date_code` ON `krx_non_trading_days` (`date`,`short_code`);
--> statement-breakpoint
CREATE INDEX `idx_krx_daily_bars_date` ON `krx_daily_bars` (`date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smcs_checkpoint_code` ON `symbol_master_checkpoint_symbols` (`checkpoint_id`,`standard_code`);
--> statement-breakpoint
CREATE INDEX `idx_sme_code_effective` ON `symbol_master_events` (`standard_code`,`effective_date`);
--> statement-breakpoint
CREATE INDEX `idx_sme_effective` ON `symbol_master_events` (`effective_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smmc_date_code` ON `symbol_master_market_caps` (`date`,`standard_code`);
--> statement-breakpoint
CREATE INDEX `idx_smv_asof` ON `symbol_master_versions` (`valid_from_date`,`valid_to_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smv_code_from` ON `symbol_master_versions` (`standard_code`,`valid_from_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_smv_open_code` ON `symbol_master_versions` (`standard_code`) WHERE "symbol_master_versions"."valid_to_date" IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_smv_short_code` ON `symbol_master_versions` (`short_code`);
--> statement-breakpoint
CREATE INDEX `idx_smv_valid_to` ON `symbol_master_versions` (`valid_to_date`);
--> statement-breakpoint
CREATE INDEX `idx_symbol_versions_code_slice` ON `symbol_versions` (`code`,`slice`);
--> statement-breakpoint
CREATE INDEX `idx_symbols_market` ON `symbols` (`market`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_symbols_standard_code` ON `symbols` (`standard_code`);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbol_master_checkpoints_checkpoint_date_unique` ON `symbol_master_checkpoints` (`checkpoint_date`);
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metric_coverage_delete` AFTER DELETE ON `daily_selection_metric_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metric_coverage_insert` AFTER INSERT ON `daily_selection_metric_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metric_coverage_update` AFTER UPDATE ON `daily_selection_metric_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metrics_delete` AFTER DELETE ON `daily_selection_metrics`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metrics_insert` AFTER INSERT ON `daily_selection_metrics`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_daily_selection_metrics_update` AFTER UPDATE ON `daily_selection_metrics`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_facts_delete` AFTER DELETE ON `facts`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_facts_insert` AFTER INSERT ON `facts`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_facts_update` AFTER UPDATE ON `facts`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_daily_bars_delete` AFTER DELETE ON `krx_daily_bars`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_daily_bars_insert` AFTER INSERT ON `krx_daily_bars`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_daily_bars_update` AFTER UPDATE ON `krx_daily_bars`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_coverage_delete` AFTER DELETE ON `krx_non_trading_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_coverage_insert` AFTER INSERT ON `krx_non_trading_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_coverage_update` AFTER UPDATE ON `krx_non_trading_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_days_delete` AFTER DELETE ON `krx_non_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_days_insert` AFTER INSERT ON `krx_non_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_krx_non_trading_days_update` AFTER UPDATE ON `krx_non_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_facts_state_delete` AFTER DELETE ON `symbol_facts_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_facts_state_insert` AFTER INSERT ON `symbol_facts_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_facts_state_update` AFTER UPDATE ON `symbol_facts_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoint_symbols_delete` AFTER DELETE ON `symbol_master_checkpoint_symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoint_symbols_insert` AFTER INSERT ON `symbol_master_checkpoint_symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoint_symbols_update` AFTER UPDATE ON `symbol_master_checkpoint_symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoints_delete` AFTER DELETE ON `symbol_master_checkpoints`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoints_insert` AFTER INSERT ON `symbol_master_checkpoints`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_checkpoints_update` AFTER UPDATE ON `symbol_master_checkpoints`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_coverage_delete` AFTER DELETE ON `symbol_master_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_coverage_insert` AFTER INSERT ON `symbol_master_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_coverage_update` AFTER UPDATE ON `symbol_master_coverage`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_events_delete` AFTER DELETE ON `symbol_master_events`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_events_insert` AFTER INSERT ON `symbol_master_events`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_events_update` AFTER UPDATE ON `symbol_master_events`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_market_caps_delete` AFTER DELETE ON `symbol_master_market_caps`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_market_caps_insert` AFTER INSERT ON `symbol_master_market_caps`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_market_caps_update` AFTER UPDATE ON `symbol_master_market_caps`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_storage_state_delete` AFTER DELETE ON `symbol_master_storage_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_storage_state_insert` AFTER INSERT ON `symbol_master_storage_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_storage_state_update` AFTER UPDATE ON `symbol_master_storage_state`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_trading_days_delete` AFTER DELETE ON `symbol_master_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_trading_days_insert` AFTER INSERT ON `symbol_master_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_trading_days_update` AFTER UPDATE ON `symbol_master_trading_days`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_versions_delete` AFTER DELETE ON `symbol_master_versions`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_versions_insert` AFTER INSERT ON `symbol_master_versions`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbol_master_versions_update` AFTER UPDATE ON `symbol_master_versions`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbols_delete` AFTER DELETE ON `symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbols_insert` AFTER INSERT ON `symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_revision_symbols_update` AFTER UPDATE ON `symbols`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_smv_no_overlap_insert`
BEFORE INSERT ON `symbol_master_versions`
WHEN EXISTS (
	SELECT 1
	FROM `symbol_master_versions` v
	WHERE v.`standard_code` = NEW.`standard_code`
		AND v.`valid_from_date` < COALESCE(NEW.`valid_to_date`, '9999-12-31')
		AND COALESCE(v.`valid_to_date`, '9999-12-31') > NEW.`valid_from_date`
)
BEGIN
	SELECT RAISE(ABORT, 'symbol_master_versions interval overlap');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_smv_no_overlap_update`
BEFORE UPDATE OF `standard_code`, `valid_from_date`, `valid_to_date`
ON `symbol_master_versions`
WHEN EXISTS (
	SELECT 1
	FROM `symbol_master_versions` v
	WHERE v.`id` <> OLD.`id`
		AND v.`standard_code` = NEW.`standard_code`
		AND v.`valid_from_date` < COALESCE(NEW.`valid_to_date`, '9999-12-31')
		AND COALESCE(v.`valid_to_date`, '9999-12-31') > NEW.`valid_from_date`
)
BEGIN
	SELECT RAISE(ABORT, 'symbol_master_versions interval overlap');
END;
--> statement-breakpoint
INSERT INTO "preparation_data_revision" VALUES (1, 0, 0);
--> statement-breakpoint
INSERT INTO "symbol_master_storage_state" VALUES (1, 'PENDING', NULL);
--> statement-breakpoint
CREATE TABLE dataset_state (singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1), dataset_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TRIGGER dataset_revision_benchmark_daily_values_insert AFTER INSERT ON "benchmark_daily_values" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_benchmark_daily_values_update AFTER UPDATE ON "benchmark_daily_values" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_benchmark_daily_values_delete AFTER DELETE ON "benchmark_daily_values" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_daily_selection_metric_coverage_insert AFTER INSERT ON "daily_selection_metric_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_daily_selection_metric_coverage_update AFTER UPDATE ON "daily_selection_metric_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_daily_selection_metric_coverage_delete AFTER DELETE ON "daily_selection_metric_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_daily_selection_metrics_insert AFTER INSERT ON "daily_selection_metrics" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_daily_selection_metrics_update AFTER UPDATE ON "daily_selection_metrics" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_daily_selection_metrics_delete AFTER DELETE ON "daily_selection_metrics" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_dart_financial_filing_receipts_insert AFTER INSERT ON "dart_financial_filing_receipts" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_dart_financial_filing_receipts_update AFTER UPDATE ON "dart_financial_filing_receipts" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_dart_financial_filing_receipts_delete AFTER DELETE ON "dart_financial_filing_receipts" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_facts_insert AFTER INSERT ON "facts" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_facts_update AFTER UPDATE ON "facts" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_facts_delete AFTER DELETE ON "facts" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_fred_benchmark_coverage_insert AFTER INSERT ON "fred_benchmark_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_fred_benchmark_coverage_update AFTER UPDATE ON "fred_benchmark_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_fred_benchmark_coverage_delete AFTER DELETE ON "fred_benchmark_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_krx_daily_bars_insert AFTER INSERT ON "krx_daily_bars" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_krx_daily_bars_update AFTER UPDATE ON "krx_daily_bars" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_krx_daily_bars_delete AFTER DELETE ON "krx_daily_bars" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_krx_non_trading_coverage_insert AFTER INSERT ON "krx_non_trading_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_krx_non_trading_coverage_update AFTER UPDATE ON "krx_non_trading_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_krx_non_trading_coverage_delete AFTER DELETE ON "krx_non_trading_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_krx_non_trading_days_insert AFTER INSERT ON "krx_non_trading_days" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_krx_non_trading_days_update AFTER UPDATE ON "krx_non_trading_days" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_krx_non_trading_days_delete AFTER DELETE ON "krx_non_trading_days" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_facts_state_insert AFTER INSERT ON "symbol_facts_state" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_facts_state_update AFTER UPDATE ON "symbol_facts_state" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_facts_state_delete AFTER DELETE ON "symbol_facts_state" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_checkpoint_symbols_insert AFTER INSERT ON "symbol_master_checkpoint_symbols" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_checkpoint_symbols_update AFTER UPDATE ON "symbol_master_checkpoint_symbols" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_checkpoint_symbols_delete AFTER DELETE ON "symbol_master_checkpoint_symbols" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_checkpoints_insert AFTER INSERT ON "symbol_master_checkpoints" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_checkpoints_update AFTER UPDATE ON "symbol_master_checkpoints" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_checkpoints_delete AFTER DELETE ON "symbol_master_checkpoints" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_coverage_insert AFTER INSERT ON "symbol_master_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_coverage_update AFTER UPDATE ON "symbol_master_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_coverage_delete AFTER DELETE ON "symbol_master_coverage" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_events_insert AFTER INSERT ON "symbol_master_events" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_events_update AFTER UPDATE ON "symbol_master_events" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_events_delete AFTER DELETE ON "symbol_master_events" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_market_caps_insert AFTER INSERT ON "symbol_master_market_caps" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_market_caps_update AFTER UPDATE ON "symbol_master_market_caps" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_market_caps_delete AFTER DELETE ON "symbol_master_market_caps" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_storage_state_insert AFTER INSERT ON "symbol_master_storage_state" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_storage_state_update AFTER UPDATE ON "symbol_master_storage_state" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_storage_state_delete AFTER DELETE ON "symbol_master_storage_state" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_trading_days_insert AFTER INSERT ON "symbol_master_trading_days" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_trading_days_update AFTER UPDATE ON "symbol_master_trading_days" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_trading_days_delete AFTER DELETE ON "symbol_master_trading_days" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_versions_insert AFTER INSERT ON "symbol_master_versions" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_versions_update AFTER UPDATE ON "symbol_master_versions" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_master_versions_delete AFTER DELETE ON "symbol_master_versions" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_versions_insert AFTER INSERT ON "symbol_versions" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_versions_update AFTER UPDATE ON "symbol_versions" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbol_versions_delete AFTER DELETE ON "symbol_versions" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbols_insert AFTER INSERT ON "symbols" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbols_update AFTER UPDATE ON "symbols" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
--> statement-breakpoint
CREATE TRIGGER dataset_revision_symbols_delete AFTER DELETE ON "symbols" BEGIN UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1; END;
