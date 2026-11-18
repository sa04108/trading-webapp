CREATE TABLE retiring_seed_refreshes AS
SELECT id, source_job_id, preparation_job_id, status FROM backtest_refresh_jobs
WHERE CASE WHEN json_valid(action_json) THEN json_extract(action_json, '$.kind') END = 'RANDOM_SEEDS';
--> statement-breakpoint
-- 폐기된 화면을 가리키는 알림은 본문을 보존하고 링크만 해제한다.
UPDATE notifications SET link = NULL WHERE link GLOB '/backtests/batches/*'
  OR link IN (SELECT '/backtests/' || source_job_id || '?refreshJob=' || id
              FROM retiring_seed_refreshes);
--> statement-breakpoint
-- 아직 생성되지 않은 실행이 있는 원본마다 한 번만 알린다. 실제 작업 행은 그대로 둔다.
INSERT INTO notifications (id, type, severity, title, body, link, created_at_ms)
SELECT 'retired-seed-' || lower(hex(randomblob(16))), 'backtest', 'error', '대기 중인 난수 복제가 종료되었습니다',
       '난수 시드 복제 기능이 종료되어 남은 실행을 만들 수 없습니다. 설정 탐색에서 새 실험을 시작할 수 있습니다.',
       CASE WHEN EXISTS (SELECT 1 FROM backtest_jobs WHERE id = pending.source_job_id)
            THEN '/backtests/' || pending.source_job_id || '/search' END, unixepoch() * 1000
FROM (
  SELECT source_job_id FROM backtest_clone_batches b WHERE status = 'ACTIVE'
    AND EXISTS (SELECT 1 FROM backtest_clone_batch_items i WHERE i.batch_id = b.id AND i.state = 'PENDING')
  UNION
  SELECT source_job_id FROM retiring_seed_refreshes WHERE status IN ('QUEUED', 'PREPARING', 'SUBMITTING')
) pending;
--> statement-breakpoint
DELETE FROM job_dismissals WHERE job_id GLOB 'clone-batch:*' OR job_id IN (
  SELECT 'backtest-refresh:' || id FROM retiring_seed_refreshes
);
--> statement-breakpoint
-- 공유 중인 준비 작업은 유지하고, 폐기 요청만 사용 중인 준비 작업은 기존 취소 절차로 종료한다.
UPDATE backtest_preparation_jobs SET cancel_requested = 1, updated_at_ms = unixepoch() * 1000
WHERE status IN ('QUEUED','RUNNING','WAITING_DATA','WAITING_DAILY_QUOTA') AND lifecycle_managed = 1
  AND id IN (SELECT preparation_job_id FROM retiring_seed_refreshes)
  AND NOT EXISTS (SELECT 1 FROM backtest_refresh_jobs WHERE preparation_job_id = backtest_preparation_jobs.id
                  AND id NOT IN (SELECT id FROM retiring_seed_refreshes))
  AND NOT EXISTS (SELECT 1 FROM preparation_wizard_references WHERE preparation_job_id = backtest_preparation_jobs.id)
  AND NOT EXISTS (SELECT 1 FROM backtest_wizard_children WHERE kind='preparation' AND job_id = backtest_preparation_jobs.id)
  AND NOT EXISTS (SELECT 1 FROM backtest_jobs WHERE preparation_job_id = backtest_preparation_jobs.id)
  AND NOT EXISTS (SELECT 1 FROM configuration_search_items WHERE preparation_job_id = backtest_preparation_jobs.id)
  AND NOT EXISTS (SELECT 1 FROM backtest_validation_trials WHERE preparation_job_id = backtest_preparation_jobs.id);
--> statement-breakpoint
DELETE FROM backtest_refresh_jobs WHERE id IN (SELECT id FROM retiring_seed_refreshes);
--> statement-breakpoint
DROP TABLE retiring_seed_refreshes;
--> statement-breakpoint
DROP TABLE `backtest_clone_batch_items`;--> statement-breakpoint
DROP TABLE `backtest_clone_batches`;--> statement-breakpoint
ALTER TABLE `backtest_jobs` DROP COLUMN `clone_batch_id`;
