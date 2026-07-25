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
  strategyVersion: string;
  parameters: Record<string, unknown>;
  datasetId: string;
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
  datasetVersion: number;
  datasetHash: string;
  engineVersion: string;
  feeModelVersion: string;
  slippageModelVersion: string;
  randomSeed: number;
  gitCommitSha: string;
  warningsJson: string | null;
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
