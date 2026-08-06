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
CREATE INDEX `idx_krx_daily_bars_date` ON `krx_daily_bars` (`date`);