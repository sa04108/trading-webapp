CREATE TABLE `dart_financial_filing_receipts` (
	`receipt_no` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`business_year` integer NOT NULL,
	`receipt_date` text NOT NULL,
	`processed_at_ms` integer NOT NULL,
	FOREIGN KEY (`code`) REFERENCES `symbols`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dart_financial_filing_receipts_code_year` ON `dart_financial_filing_receipts` (`code`,`business_year`);