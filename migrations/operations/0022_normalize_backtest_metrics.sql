UPDATE `backtest_metrics` SET
  `total_return_pct` = CASE WHEN json_valid(`metrics_json`) THEN CASE WHEN
  json_type(`metrics_json`) = 'object'
  AND json_type(`metrics_json`, '$.totalReturnPct') IN ('integer', 'real')
  AND json_type(`metrics_json`, '$.cagrPct') IN ('integer', 'real', 'null')
  AND json_type(`metrics_json`, '$.maxDrawdownPct') IN ('integer', 'real')
  AND json_type(`metrics_json`, '$.sharpe') IN ('integer', 'real', 'null')
  AND json_type(`metrics_json`, '$.winRate') IN ('integer', 'real', 'null')
  AND json_type(`metrics_json`, '$.tradeCount') = 'integer'
THEN json_extract(`metrics_json`, '$.totalReturnPct') ELSE NULL END ELSE NULL END,
  `cagr_pct` = json_extract(`metrics_json`, '$.cagrPct'),
  `max_drawdown_pct` = json_extract(`metrics_json`, '$.maxDrawdownPct'),
  `sharpe` = json_extract(`metrics_json`, '$.sharpe'),
  `win_rate` = json_extract(`metrics_json`, '$.winRate'),
  `trade_count` = json_extract(`metrics_json`, '$.tradeCount'),
  `metrics_json` = json_remove(`metrics_json`, '$.totalReturnPct', '$.cagrPct', '$.maxDrawdownPct', '$.sharpe', '$.winRate', '$.tradeCount');
