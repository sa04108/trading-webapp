// 데이터 파일로 배포할 테이블을 명시한다. 신규 테이블은 소유 DB를 먼저 결정한다.
export const DATA_TABLE_NAMES = [
  "benchmark_daily_values",
  "daily_selection_metric_coverage",
  "daily_selection_metrics",
  "dart_financial_filing_receipts",
  "facts",
  "fred_benchmark_coverage",
  "krx_daily_bars",
  "krx_non_trading_coverage",
  "krx_non_trading_days",
  "preparation_data_revision",
  "symbol_facts_state",
  "symbol_master_coverage",
  "symbol_master_market_caps",
  "symbol_master_trading_days",
  "symbol_master_versions",
  "symbol_versions",
  "symbols"
] as const;
