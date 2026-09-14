ALTER TABLE `backtest_jobs` RENAME COLUMN "worker_id" TO "agent_id";
--> statement-breakpoint
-- 기존 임대 소유자는 에이전트 ID다. 전송 방식 접두사만 제거한다.
UPDATE `backtest_jobs` SET `agent_id` = substr(`agent_id`, 8) WHERE `agent_id` GLOB 'remote:*';
