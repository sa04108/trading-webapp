CREATE TABLE `backtest_warning_details` (
	`job_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`warning` text NOT NULL,
	PRIMARY KEY(`job_id`, `sequence`),
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
