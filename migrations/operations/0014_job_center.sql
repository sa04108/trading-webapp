CREATE TABLE `background_job_history` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`finished_at_ms` integer,
	`snapshot_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_background_jobs_finished` ON `background_job_history` (`finished_at_ms`);--> statement-breakpoint
CREATE TABLE `job_dismissals` (
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`finished_at_ms` integer NOT NULL,
	PRIMARY KEY(`user_id`, `job_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_job_dismissals_finished` ON `job_dismissals` (`finished_at_ms`);--> statement-breakpoint
ALTER TABLE `backtest_validations` ADD `completed_at_ms` integer;--> statement-breakpoint
ALTER TABLE `intraday_collections` ADD `parent_run_id` text;--> statement-breakpoint
CREATE INDEX `intraday_collections_parent` ON `intraday_collections` (`parent_run_id`);--> statement-breakpoint
-- 도입 전 기간 검증은 하위 실행의 마지막 종료 시각을 보존하고, 근거가 없으면 이행 시각부터 보관한다.
UPDATE `backtest_validations` SET `completed_at_ms` = coalesce(
  (SELECT max(j.completed_at_ms) FROM backtest_validation_trials t JOIN backtest_jobs j ON j.id=t.job_id
    WHERE t.validation_id=backtest_validations.id), cast(strftime('%s','now') AS integer)*1000)
WHERE status IN ('COMPLETED','FAILED','CANCELLED') AND completed_at_ms IS NULL;
--> statement-breakpoint
-- 참조 없는 준비 결과를 정리해도 작업 목록에는 작은 종료 이력만 남긴다.
CREATE TRIGGER `archive_preparation_job_history` BEFORE DELETE ON `backtest_preparation_jobs`
WHEN OLD.status IN ('COMPLETED','FAILED','CANCELLED')
BEGIN
  INSERT OR REPLACE INTO background_job_history
    (id,status,created_at_ms,updated_at_ms,finished_at_ms,snapshot_json)
  VALUES ('preparation:' || OLD.id, OLD.status, OLD.created_at_ms, OLD.updated_at_ms,
    coalesce(OLD.completed_at_ms,OLD.updated_at_ms),
    json_object('id','preparation:' || OLD.id,'kind','preparation','title','유니버스 준비',
      'status',OLD.status,'phase',CASE OLD.status WHEN 'COMPLETED' THEN '완료' WHEN 'FAILED' THEN '실패' ELSE '취소됨' END,
      'description',CASE WHEN json_valid(OLD.request_json) THEN
        coalesce(json_extract(OLD.request_json,'$.strategyId'),'') || ' · ' ||
        coalesce(json_extract(OLD.request_json,'$.period.from'),'') || ' ~ ' || coalesce(json_extract(OLD.request_json,'$.period.to'),'') ELSE NULL END,
      'progress',NULL,'error',OLD.error,'createdAtMs',OLD.created_at_ms,'updatedAtMs',OLD.updated_at_ms,
      'finishedAtMs',coalesce(OLD.completed_at_ms,OLD.updated_at_ms),'cancellable',json('false'),'link',NULL));
END;
