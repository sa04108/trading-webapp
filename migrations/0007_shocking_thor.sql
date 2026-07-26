ALTER TABLE `sessions` DROP COLUMN `pending_totp`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `totp_secret`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `totp_enabled`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `recovery_code_hashes_json`;