export type BacktestStatus =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED';

export interface BacktestRequestBody {
  strategyId: string;
  /** 전략 버전은 보내지 않는다 (D-029) — 서버가 실행 시점의 등록 버전을 기록한다 */
  parameters: Record<string, unknown>;
  /** `universeSnapshotId` 와 배타적이다 (xor) — 둘 중 정확히 하나만 지정한다 (Task 12/13) */
  datasetId?: string;
  /**
   * 과거 시점 고정 유니버스 스냅샷 참조 — `datasetId` 와 배타적이다.
   * 위저드가 KRX 모드로 제출할 때 이 필드를 채우고 `datasetId` 는 생략한다 (Task 13).
   */
  universeSnapshotId?: string;
  /** 소비 봉 주기 — 미지정은 데이터셋 timeframe (이 필드가 없던 시절의 요청 호환) */
  timeframe?: '1m' | '1h' | '1d';
  universe: { type: 'SYMBOLS'; symbols: string[] };
  period: { from: string; to: string };
  capital: { initialCash: number; currency: 'KRW' };
  execution: {
    fillTiming: 'NEXT_BAR_OPEN';
    commissionProfileId: string;
    slippageProfileId: string;
  };
  risk: { maxPositions: number };
  randomSeed: number;
}

export interface JobSummary {
  id: string;
  status: BacktestStatus;
  strategyId: string;
  datasetId: string;
  request: BacktestRequestBody;
  progressBars: number | null;
  totalBars: number | null;
  progressLabel: string | null;
  error: string | null;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  metrics?: BacktestMetrics | null;
}

export interface BacktestMetrics {
  initialCash: number;
  finalEquity: number;
  totalReturnPct: number;
  cagrPct: number | null;
  maxDrawdownPct: number;
  maxDrawdownDurationMs: number;
  volatilityPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  winRate: number | null;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  tradeCount: number;
  avgHoldingTimeMs: number | null;
  maxConcurrentPositions: number;
  totalCommission: number;
  totalTax: number;
  totalSlippage: number;
}

export interface RunMetadata {
  strategyId: string;
  strategyVersion: string;
  strategySourceHash: string;
  parameterJson: string;
  datasetId: string;
  /** 소비한 (종목,슬라이스,버전,해시) 스냅샷 — 구 datasetVersion/datasetHash (§9.5) */
  universeHash: string;
  universeJson: string;
  engineVersion: string;
  feeModelVersion: string;
  slippageModelVersion: string;
  randomSeed: number;
  gitCommitSha: string;
  warningsJson: string | null;
  openPositionsJson: string | null;
  startedAtMs: number;
  completedAtMs: number | null;
}

export interface SeriesPoint {
  tsMs: number;
  value: number;
}

export interface SeriesResponse {
  equity: SeriesPoint[];
  drawdown: SeriesPoint[];
  monthly: Array<{ year: number; month: number; returnPct: number }>;
  symbols: Array<{ symbol: string; tradeCount: number; netPnl: number; winRate: number | null }>;
  totalEquityPoints: number;
}

export interface TradeRow {
  id: number;
  symbol: string;
  quantity: number;
  entryTsMs: number;
  exitTsMs: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  returnPct: number;
  holdingTimeMs: number;
  exitReason: string | null;
}

export const TERMINAL_STATUSES: BacktestStatus[] = [
  'CANCELLED',
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
];

export function isTerminal(status: BacktestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** 기간 종료 시점 미청산 포지션 (매도 비용 미반영 평가치) */
export interface OpenPositionSnapshot {
  symbol: string;
  quantity: number;
  avgEntryPrice: number;
  entryTsMs: number;
  lastPrice: number;
  unrealizedPnl: number;
  returnPct: number;
}
