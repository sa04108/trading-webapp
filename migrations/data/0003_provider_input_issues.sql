CREATE TABLE provider_input_issues (
 id TEXT PRIMARY KEY NOT NULL, symbol TEXT NOT NULL, business_year INTEGER,
 report_code TEXT, reason TEXT NOT NULL, evidence TEXT NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER provider_input_issues_insert AFTER INSERT ON provider_input_issues BEGIN
 UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1;
END;
--> statement-breakpoint
CREATE TRIGGER provider_input_issues_update AFTER UPDATE ON provider_input_issues BEGIN
 UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1;
END;
--> statement-breakpoint
CREATE TRIGGER provider_input_issues_delete AFTER DELETE ON provider_input_issues BEGIN
 UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1;
END;
