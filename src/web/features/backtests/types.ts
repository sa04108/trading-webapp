import type { UniverseRule } from '../../../shared/schemas/universe-rule.js';
import type { BenchmarkId } from '../../../shared/schemas/benchmark.js';

export type BacktestStatus =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED';

/**
 * 백테스트 제출 바디 (스펙 2026-08-05) — 서버의 `backtestRequestSchema` 와 같은 계약이다.
 *
 * `datasetId`/`universeSnapshotId`/`universe` 는 더 이상 없다 — 유니버스는 화면이 고른
 * 종목 목록이 아니라 `universeRule`(시총 상위 N 규칙)이고, 실제 종목 구성은 제출 시점에
 * 서버가 리밸런스 날짜별로 종목 마스터에서 재구성한다. 옛 필드로 저장된 요청은 이 타입
 * 으로 다시 파싱되지 않는다 — 기존 백테스트 데이터는 이 변경과 함께 마이그레이션이
 * 정리한다(보존 대상 아님).
 */
export interface BacktestRequestBody {
  strategyId: string;
  /** 전략 버전은 보내지 않는다 (D-029) — 서버가 실행 시점의 등록 버전을 기록한다 */
  parameters: Record<string, unknown>;
  universeRule: UniverseRule;
  benchmarkId?: BenchmarkId;
  /** 소비 봉 주기 — 미지정은 유니버스가 가진 슬라이스로 유일하게 정해지는 값 */
  timeframe?: '1m' | '1h' | '1d';
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

/**
 * 백테스트 잡 요약 — 서버 `serializeJob` 이 내리는 모양 그대로다.
 *
 * `datasetId`/`universeSnapshotId` 는 없다 — 잡은 더 이상 데이터셋도 스냅샷도 참조하지
 * 않는다(스펙 2026-08-05). 유니버스 출처를 구분하려면 `provenancePin.sourceKind` 를 본다.
 */
export interface JobSummary {
  id: string;
  status: BacktestStatus;
  strategyId: string;
  request: BacktestRequestBody;
  progressBars: number | null;
  totalBars: number | null;
  progressLabel: string | null;
  error: string | null;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  cloneBatchId: string | null;
  cloneSourceJobId: string | null;
  metrics?: BacktestMetrics | null;
}

export type SeedCloneBatchStatus = 'ACTIVE' | 'CANCELLING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type SeedCloneItemStatus = 'PENDING' | 'DELETED' | BacktestStatus;

export interface SeedCloneBatchSummary {
  id: string;
  sourceJobId: string;
  strategyId: string;
  status: SeedCloneBatchStatus;
  totalCount: number;
  pendingCount: number;
  queuedCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  interruptedCount: number;
  deletedCount: number;
  request: BacktestRequestBody;
  error: string | null;
  createdAtMs: number;
  completedAtMs: number | null;
}

export interface SeedCloneBatchItem {
  ordinal: number;
  randomSeed: number;
  jobId: string | null;
  status: SeedCloneItemStatus;
  metrics: BacktestMetrics | null;
}

export interface SeedCloneBatchDetail extends SeedCloneBatchSummary {
  items: SeedCloneBatchItem[];
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
  /** 100 기준으로 정규화한 제출 시점 벤치마크 */
  benchmark: SeriesPoint[];
  drawdown: SeriesPoint[];
  monthly: Array<{ year: number; month: number; returnPct: number }>;
  symbols: string[];
  totalEquityPoints: number;
}

export interface BenchmarkResult {
  benchmarkId: BenchmarkId;
  name: string;
  available: boolean;
  unavailableReason: string | null;
  totalReturnPct: number | null;
  excessReturnPct: number | null;
  dataHash: string | null;
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
  /** `lastPrice` 를 읽은 봉의 시각 — 기간 종료 시각과 벌어져 있으면 stale 이다 */
  lastPriceTsMs: number;
  unrealizedPnl: number;
  returnPct: number;
}
