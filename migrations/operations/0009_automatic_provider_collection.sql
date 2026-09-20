ALTER TABLE `provider_request_plans` ADD `retry_after_ms` integer;--> statement-breakpoint
-- 과거 수동 승인만 기다리던 수집 작업을 다시 평가한다. 무결성 오류는 재개하지 않는다.
UPDATE agent_data_requests
SET status = 'QUEUED', activity = 'WAITING_RETRY', attempts = 0,
    next_attempt_at_ms = 0, error = NULL
WHERE status = 'BLOCKED' AND EXISTS (
  SELECT 1 FROM provider_request_plans p
  WHERE p.status IN ('BLOCKED', 'APPROVED', 'CANCELLED')
    AND instr(agent_data_requests.error, p.fingerprint) > 0
    AND substr(agent_data_requests.error, 1, length(p.reason) + 1) = p.reason || ':'
);
--> statement-breakpoint
-- 완료 원문과 누적 시도는 보존하고, 소진된 요청은 자동 재시도 대기로 이행한다.
UPDATE provider_request_plans
SET status = CASE WHEN attempts >= max_attempts THEN 'WAITING_RETRY' ELSE 'READY' END,
    retry_after_ms = CASE WHEN attempts >= max_attempts
      THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 900000 ELSE NULL END
WHERE status IN ('BLOCKED', 'APPROVED', 'CANCELLED');
