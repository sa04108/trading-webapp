CREATE INDEX intraday_runs_history ON intraday_runs (
  owner_id,
  CASE WHEN json_valid(request_json) THEN json_extract(request_json, '$.strategyId') END,
  created_at_ms,
  id,
  CASE WHEN status = 'COMPLETED' AND json_valid(result_json)
  THEN json_extract(result_json, '$.metrics.returnPct', '$.metrics.maxDrawdownPct', '$.metrics.sharpe') END,
  updated_at_ms
);
