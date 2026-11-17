CREATE TABLE `risk_free_rate_history` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`history_json` text NOT NULL,
	CONSTRAINT "chk_risk_free_rate_singleton" CHECK("risk_free_rate_history"."singleton" = 1)
);
--> statement-breakpoint
CREATE TRIGGER risk_free_rate_history_insert AFTER INSERT ON risk_free_rate_history BEGIN
 UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1;
END;
--> statement-breakpoint
CREATE TRIGGER risk_free_rate_history_update AFTER UPDATE OF history_json ON risk_free_rate_history WHEN NEW.history_json != OLD.history_json BEGIN
 UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1;
END;
--> statement-breakpoint
CREATE TRIGGER risk_free_rate_history_delete AFTER DELETE ON risk_free_rate_history BEGIN
 UPDATE dataset_state SET revision = revision + 1 WHERE singleton = 1;
END;
