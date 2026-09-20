CREATE TABLE `dart_corp_code_snapshot` (
	`namespace` text PRIMARY KEY NOT NULL,
	`xml` text NOT NULL,
	`content_hash` text NOT NULL,
	`fetched_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dart_discovered_filings` (
	`identity` text PRIMARY KEY NOT NULL,
	`receipt_no` text,
	`symbol` text,
	`business_year` integer,
	`report_code` text,
	`payload_json` text NOT NULL,
	`discovered_at_ms` integer NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dart_discovery_jobs` (
	`window_days` integer DEFAULT 80 NOT NULL,
	`day` text PRIMARY KEY NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`page` integer NOT NULL,
	`status` text NOT NULL,
	`owner` text,
	`lease_until_ms` integer,
	`completed_at_ms` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `dart_discovery_pages` (
	`day` text NOT NULL,
	`from_date` text NOT NULL,
	`page` integer NOT NULL,
	`payload_json` text NOT NULL,
	`fetched_at_ms` integer NOT NULL,
	PRIMARY KEY(`day`, `from_date`, `page`)
);
--> statement-breakpoint
CREATE TABLE `dart_filing_endpoint_checkpoints` (
	`receipt_no` text NOT NULL,
	`endpoint` text NOT NULL,
	`fs_div` text NOT NULL,
	`status` text NOT NULL,
	`retry_after_ms` integer,
	PRIMARY KEY(`receipt_no`, `endpoint`, `fs_div`)
);
--> statement-breakpoint
CREATE TABLE `dart_raw_api_snapshot_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_json` text NOT NULL,
	`archived_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `krx_raw_api_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`namespace` text NOT NULL,
	`endpoint` text NOT NULL,
	`bas_dd` text NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`fetched_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_krx_raw_api_snapshots_key` ON `krx_raw_api_snapshots` (`namespace`,`endpoint`,`bas_dd`);--> statement-breakpoint
CREATE TABLE `provider_execution_provenance` (
	`job_id` text PRIMARY KEY NOT NULL,
	`freshness_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_request_plans` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`request_json` text NOT NULL,
	`reason` text NOT NULL,
	`evidence` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`created_at_ms` integer NOT NULL,
	`decided_at_ms` integer
);
