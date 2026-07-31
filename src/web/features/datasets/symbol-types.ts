import type { DatasetSlice } from './dataset-slices';

/** GET /symbols 의 한 행 — 화면이 그리는 데 필요한 것이 전부 여기 있다 */
export interface SymbolSummary {
  code: string;
  market: string;
  name: string | null;
  slices: Array<{
    slice: DatasetSlice;
    hasData: boolean;
    barCount: number;
    firstTsMs: number | null;
    lastTsMs: number | null;
    lastSyncedAtMs: number | null;
  }>;
  /** 이 종목을 참조하는 데이터셋 수 — 제거를 안전하게 만드는 값 */
  datasetCount: number;
  /** 재무 팩트 보유 — 응답을 런타임 검증하지 않으므로 없을 수 있다 (D-033) */
  hasFacts?: boolean;
}

export interface RemovalImpact {
  code: string;
  datasets: Array<{ id: string; name: string; remaining: number }>;
  wouldEmpty: Array<{ id: string; name: string }>;
}

export interface DatasetSummary {
  id: string;
  name: string;
  description: string | null;
  symbols: string[];
  createdAtMs: number;
}

export interface DataJob {
  id: string;
  status: string;
  sourceType: string;
  symbolsJson: string;
  slice: DatasetSlice;
  rowsImported: number | null;
  error: string | null;
  phase: string | null;
  factsJson: string | null;
  createdAtMs: number;
  completedAtMs: number | null;
}

export interface FactsJobState {
  fromYear: number | null;
  toYear: number | null;
  symbolsDone: number;
  symbolTotal: number;
  savedFacts: number;
  gapCount: number;
  failureMessage: string | null;
  skipReason: string | null;
}

export type FactsSyncEstimate =
  | { basis: 'UNSUPPORTED'; reason: string }
  | { basis: 'AFTER_CANDLES' }
  | {
      basis: 'PLANNED';
      fromYear: number;
      toYear: number;
      calls: number;
      estimatedMs: number;
      overDailyLimit: boolean;
    };

export interface SyncEstimateResponse {
  candles: { basis: 'LAST_RUN'; ms: number } | { basis: 'UNKNOWN' };
  facts: FactsSyncEstimate;
  minutePlan: {
    capMonths: number;
    recommendedMonths: number;
    fromTsMs: number;
    expectedBars: number;
    exceedsBacktestLimit: boolean;
  } | null;
  note: string;
}
