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
  /** 재무 팩트 보유 — 응답을 런타임 검증하지 않으므로 없을 수 있다 (D-033) */
  hasFacts?: boolean;
}

export interface DatasetSummary {
  id: string;
  name: string;
  description: string | null;
  symbols: string[];
  createdAtMs: number;
  /** KRX 스냅샷 확정이 만든 데이터셋이면 그 출처 */
  universeSnapshot: {
    snapshotId: string;
    effectiveTradingDate: string;
    sortKey: string;
  } | null;
  /** 현재 상장 목록에 없는 참조 종목 — null 은 판정 불가(KRX 실패)거나 스냅샷 비연결 */
  unlistedSymbols: string[] | null;
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
  /** 종목 단위로 격리된 실패 목록 (BrokerSyncFailedSymbol[] JSON). null = 실패한 종목 없음 */
  failedSymbolsJson: string | null;
  createdAtMs: number;
  completedAtMs: number | null;
}

/** data_sync_jobs.failed_symbols_json 의 원소 — 격리된 종목 하나 */
export interface BrokerSyncFailedSymbol {
  code: string;
  market: string;
  reason: string;
}

/** failedSymbolsJson 파싱. 형식이 어긋나도 화면이 죽지 않게 빈 배열로 눙친다 */
export function parseFailedSymbols(json: string | null | undefined): BrokerSyncFailedSymbol[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as BrokerSyncFailedSymbol[]) : [];
  } catch {
    return [];
  }
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
