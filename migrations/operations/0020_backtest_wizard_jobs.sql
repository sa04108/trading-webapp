CREATE TABLE `backtest_wizard_children` (
	`wizard_id` text NOT NULL,
	`kind` text NOT NULL,
	`job_id` text NOT NULL,
	PRIMARY KEY(`wizard_id`, `kind`, `job_id`),
	FOREIGN KEY (`wizard_id`) REFERENCES `backtest_wizard_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_wizard_child_job` ON `backtest_wizard_children` (`kind`,`job_id`);--> statement-breakpoint
CREATE TABLE `backtest_wizard_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source_job_id` text,
	`current_step` text DEFAULT 'strategy' NOT NULL,
	`status` text DEFAULT 'WAITING' NOT NULL,
	`backtest_job_id` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`finished_at_ms` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_wizard_owner_status` ON `backtest_wizard_jobs` (`owner_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_preparation_wizard_references` (
	`user_id` text NOT NULL,
	`context` text NOT NULL,
	`preparation_job_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `context`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preparation_job_id`) REFERENCES `backtest_preparation_jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_preparation_wizard_references`("user_id", "context", "preparation_job_id") SELECT "user_id", "context", "preparation_job_id" FROM `preparation_wizard_references`;--> statement-breakpoint
DROP TABLE `preparation_wizard_references`;--> statement-breakpoint
ALTER TABLE `__new_preparation_wizard_references` RENAME TO `preparation_wizard_references`;--> statement-breakpoint
CREATE INDEX `idx_preparation_wizard_job` ON `preparation_wizard_references` (`preparation_job_id`);
--> statement-breakpoint
-- 기존 작성 내용과 진행 중 미리보기를 독립 위저드로 옮겨 사용자가 작업 목록에서 재개할 수 있게 한다.
INSERT INTO backtest_wizard_jobs (id, owner_id, source_job_id, current_step, status, created_at_ms, updated_at_ms)
SELECT 'wizard_' || lower(hex(randomblob(16))), c.user_id, nullif(c.context,''),
  coalesce((SELECT json_extract(d.payload_json,'$.currentStep') FROM backtest_wizard_drafts d
    WHERE d.user_id=c.user_id AND d.context=c.context AND d.step='strategy'), 'universe'),
  'WAITING',
  coalesce((SELECT min(updated_at_ms) FROM backtest_wizard_drafts d WHERE d.user_id=c.user_id AND d.context=c.context),
    (SELECT p.created_at_ms FROM preparation_wizard_references r JOIN backtest_preparation_jobs p ON p.id=r.preparation_job_id
      WHERE r.user_id=c.user_id AND r.context=c.context)),
  coalesce((SELECT max(updated_at_ms) FROM backtest_wizard_drafts d WHERE d.user_id=c.user_id AND d.context=c.context),
    (SELECT p.updated_at_ms FROM preparation_wizard_references r JOIN backtest_preparation_jobs p ON p.id=r.preparation_job_id
      WHERE r.user_id=c.user_id AND r.context=c.context))
FROM (SELECT user_id, context FROM backtest_wizard_drafts UNION SELECT user_id, context FROM preparation_wizard_references) c;
--> statement-breakpoint
UPDATE backtest_wizard_drafts SET context=(SELECT w.id FROM backtest_wizard_jobs w
  WHERE w.owner_id=backtest_wizard_drafts.user_id AND coalesce(w.source_job_id,'')=backtest_wizard_drafts.context);
--> statement-breakpoint
UPDATE preparation_wizard_references SET context=(SELECT w.id FROM backtest_wizard_jobs w
  WHERE w.owner_id=preparation_wizard_references.user_id AND coalesce(w.source_job_id,'')=preparation_wizard_references.context);
--> statement-breakpoint
INSERT INTO backtest_wizard_children (wizard_id,kind,job_id)
SELECT context,'preparation',preparation_job_id FROM preparation_wizard_references;
