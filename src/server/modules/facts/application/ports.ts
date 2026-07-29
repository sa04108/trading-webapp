import type { Fact, FactScope } from '../domain/fact.js';

export interface FactQuery {
  /** 데이터셋 단위 물리 격리 — 캔들과 같은 관례 (§11) */
  readonly datasetId: string;
  readonly scope: FactScope;
  readonly keys?: readonly string[];
  readonly fields?: readonly string[];
  /** 이 시각 이후에 공시된 팩트는 제외한다 */
  readonly asOfMaxTsMs?: number;
}

export interface FactRepository {
  getFacts(query: FactQuery): Promise<Fact[]>;
  saveFacts(datasetId: string, facts: readonly Fact[]): Promise<void>;
  /** 제출 검증용 — 재무가 수집되지 않은 데이터셋에 재무 전략을 걸지 않게 막는다 */
  hasFacts(datasetId: string, scope: FactScope): boolean;
}

/** 수집이 채우지 못한 칸. 조용히 빠뜨리면 랭킹이 소리 없이 왜곡된다. */
export interface FactIngestionGap {
  readonly symbol: string;
  readonly periodKey: string;
  readonly reason: string;
}

export interface FactIngestionResult {
  readonly facts: readonly Fact[];
  /** 파서가 만든 것과 같은 이름을 쓴다 (ParsedFinancials.gaps) — 경계마다 이름이
   *  바뀌면 합칠 때 조용히 빈 배열이 된다 */
  readonly gaps: readonly FactIngestionGap[];
}

export interface FetchFinancialsRequest {
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  /** true = 연결(CFS), false = 별도(OFS). 데이터셋 하나는 한 기준만 담는다 */
  readonly consolidated: boolean;
}

export interface FactSource {
  /** 재무제표 계정 + 발행주식수 */
  fetchFinancials(request: FetchFinancialsRequest): Promise<FactIngestionResult>;
  /** 분할·무상증자 등 자본변동 이벤트 */
  fetchCorporateActions(request: FetchFinancialsRequest): Promise<FactIngestionResult>;
}

export class FactSourceNotConfiguredError extends Error {
  constructor() {
    super('DART_API_KEY 가 설정되지 않았습니다. 재무 데이터 수집을 사용할 수 없습니다.');
    this.name = 'FactSourceNotConfiguredError';
  }
}
