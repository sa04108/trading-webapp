CREATE TABLE `fred_benchmark_coverage` (
	`benchmark_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`synced_at_ms` integer NOT NULL,
	PRIMARY KEY(`benchmark_id`, `start_date`, `end_date`)
);
