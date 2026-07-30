DROP INDEX `idx_data_coverage_dataset_symbol`;--> statement-breakpoint
ALTER TABLE `data_coverage` ADD `slice` text DEFAULT '1d' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_data_coverage_dataset_symbol_slice` ON `data_coverage` (`dataset_id`,`symbol`,`slice`);--> statement-breakpoint
DROP INDEX `idx_broker_sync_state_dataset_symbol`;--> statement-breakpoint
ALTER TABLE `broker_sync_state` ADD `slice` text DEFAULT '1d' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_broker_sync_state_dataset_symbol` ON `broker_sync_state` (`dataset_id`,`symbol`,`slice`);--> statement-breakpoint
ALTER TABLE `datasets` ADD `default_timeframe` text DEFAULT '1d' NOT NULL;--> statement-breakpoint
ALTER TABLE `datasets` ADD `symbols_key` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `datasets` SET `default_timeframe` = CASE `timeframe` WHEN '1d' THEN '1d' ELSE '1m' END;
--> statement-breakpoint
UPDATE `data_coverage` SET `slice` = COALESCE((
  SELECT CASE d.`timeframe` WHEN '1d' THEN '1d' ELSE '1m' END FROM `datasets` d WHERE d.`id` = `data_coverage`.`dataset_id`
), '1d');
--> statement-breakpoint
UPDATE `broker_sync_state` SET `slice` = COALESCE((
  SELECT CASE d.`timeframe` WHEN '1d' THEN '1d' ELSE '1m' END FROM `datasets` d WHERE d.`id` = `broker_sync_state`.`dataset_id`
), '1d');