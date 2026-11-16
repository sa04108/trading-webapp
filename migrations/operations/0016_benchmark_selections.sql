CREATE TABLE `backtest_benchmark_selections` (
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`benchmark_ids_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `job_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `backtest_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
