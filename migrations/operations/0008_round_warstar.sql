ALTER TABLE `dart_raw_api_snapshots` ADD `receipt_no` text;--> statement-breakpoint
CREATE INDEX `idx_dart_raw_report_metadata` ON `dart_raw_api_snapshots` (`code`,`business_year`,`report_code`);--> statement-breakpoint
CREATE INDEX `idx_dart_filings_scope` ON `dart_discovered_filings` (`symbol`,`business_year`,`report_code`,`receipt_no`);--> statement-breakpoint
CREATE INDEX `idx_dart_filings_status` ON `dart_discovered_filings` (`status`);--> statement-breakpoint
CREATE INDEX `idx_dart_discovery_completed` ON `dart_discovery_jobs` (`status`,`to_date`,`completed_at_ms`);