CREATE TABLE `dart_raw_api_snapshots` (
	`code` text NOT NULL,
	`endpoint` text NOT NULL,
	`business_year` integer NOT NULL,
	`report_code` text NOT NULL,
	`fs_div` text NOT NULL,
	`payload_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`fetched_at_ms` integer NOT NULL,
	PRIMARY KEY(`code`, `endpoint`, `business_year`, `report_code`, `fs_div`),
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_dart_raw_api_snapshots_endpoint" CHECK("dart_raw_api_snapshots"."endpoint" IN ('FINANCIAL_STATEMENT', 'SHARE_STATUS', 'ISSUANCE_STATUS')),
	CONSTRAINT "chk_dart_raw_api_snapshots_report_code" CHECK("dart_raw_api_snapshots"."report_code" IN ('11013', '11012', '11014', '11011')),
	CONSTRAINT "chk_dart_raw_api_snapshots_fs_div" CHECK("dart_raw_api_snapshots"."fs_div" IN ('CFS', 'OFS', 'NONE'))
);
--> statement-breakpoint
CREATE INDEX `idx_dart_raw_api_snapshots_fetched_at` ON `dart_raw_api_snapshots` (`fetched_at_ms`);