ALTER TABLE `backtest_preparation_jobs` ADD `overall_progress` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `backtest_preparation_jobs` SET `overall_progress` = 100 WHERE `status` = 'COMPLETED';
