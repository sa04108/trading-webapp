CREATE TABLE `daily_selection_metrics` (
	`date` text NOT NULL,
	`standard_code` text NOT NULL,
	`market_cap_krw` text,
	`volume` integer,
	`trading_value_krw` text,
	PRIMARY KEY(`date`, `standard_code`)
);
--> statement-breakpoint
INSERT INTO `daily_selection_metrics` (`date`, `standard_code`, `market_cap_krw`)
SELECT `date`, `standard_code`, `market_cap_krw`
FROM `symbol_master_market_caps`;
