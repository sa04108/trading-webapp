CREATE TABLE `preparation_data_revision` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`armed` integer DEFAULT false NOT NULL,
	CONSTRAINT "chk_preparation_revision_singleton" CHECK("preparation_data_revision"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `preparation_preview_cache` (
	`job_id` text PRIMARY KEY NOT NULL,
	`data_revision` integer NOT NULL,
	`validation_version` text NOT NULL,
	`fundamental_symbols_json` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_preparation_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `preparation_data_revision` (`singleton`, `revision`) VALUES (1, 0);
-- Keep source writes and invalidation atomic, including direct SQL and other connections.
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
CREATE TRIGGER `preparation_revision_symbols_delete` AFTER DELETE ON `symbols`
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
CREATE TRIGGER `preparation_revision_facts_delete` AFTER DELETE ON `facts`
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
CREATE TRIGGER `preparation_revision_symbol_facts_state_delete` AFTER DELETE ON `symbol_facts_state`
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
CREATE TRIGGER `preparation_revision_symbol_master_versions_delete` AFTER DELETE ON `symbol_master_versions`
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
CREATE TRIGGER `preparation_revision_symbol_master_storage_state_delete` AFTER DELETE ON `symbol_master_storage_state`
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
CREATE TRIGGER `preparation_revision_symbol_master_checkpoints_delete` AFTER DELETE ON `symbol_master_checkpoints`
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
CREATE TRIGGER `preparation_revision_symbol_master_checkpoint_symbols_delete` AFTER DELETE ON `symbol_master_checkpoint_symbols`
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
CREATE TRIGGER `preparation_revision_symbol_master_events_delete` AFTER DELETE ON `symbol_master_events`
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
CREATE TRIGGER `preparation_revision_symbol_master_coverage_delete` AFTER DELETE ON `symbol_master_coverage`
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
CREATE TRIGGER `preparation_revision_symbol_master_market_caps_delete` AFTER DELETE ON `symbol_master_market_caps`
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
CREATE TRIGGER `preparation_revision_krx_non_trading_days_delete` AFTER DELETE ON `krx_non_trading_days`
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
CREATE TRIGGER `preparation_revision_krx_non_trading_coverage_delete` AFTER DELETE ON `krx_non_trading_coverage`
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
CREATE TRIGGER `preparation_revision_daily_selection_metrics_delete` AFTER DELETE ON `daily_selection_metrics`
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
CREATE TRIGGER `preparation_revision_daily_selection_metric_coverage_delete` AFTER DELETE ON `daily_selection_metric_coverage`
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
CREATE TRIGGER `preparation_revision_symbol_master_trading_days_delete` AFTER DELETE ON `symbol_master_trading_days`
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
CREATE TRIGGER `preparation_revision_krx_daily_bars_delete` AFTER DELETE ON `krx_daily_bars`
BEGIN
  UPDATE `preparation_data_revision` SET `revision` = `revision` + 1, `armed` = false WHERE `singleton` = 1 AND `armed` = true;
END;
--> statement-breakpoint
CREATE TRIGGER `preparation_cache_job_update`
AFTER UPDATE OF `preview_json`, `request_json`, `request_hash`, `status` ON `backtest_preparation_jobs`
BEGIN
  DELETE FROM `preparation_preview_cache` WHERE `job_id` = NEW.`id`;
END;
