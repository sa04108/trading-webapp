CREATE TABLE `external_api_daily_usage` (
	`api` text NOT NULL,
	`quota_scope` text NOT NULL,
	`usage_date_kst` text NOT NULL,
	`calls_used` integer DEFAULT 0 NOT NULL,
	`quota_exceeded_at_ms` integer,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`api`, `quota_scope`, `usage_date_kst`)
);
--> statement-breakpoint
CREATE INDEX `idx_external_api_daily_usage_date` ON `external_api_daily_usage` (`usage_date_kst`);
--> statement-breakpoint
INSERT INTO `external_api_daily_usage` (
	`api`,
	`quota_scope`,
	`usage_date_kst`,
	`calls_used`,
	`updated_at_ms`
)
SELECT
	'DART',
	'daily',
	`dart_quota_date_kst`,
	sum(`dart_calls_used`),
	max(`updated_at_ms`)
FROM `backtest_preparation_jobs`
WHERE `dart_quota_date_kst` IS NOT NULL
GROUP BY `dart_quota_date_kst`;
