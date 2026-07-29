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

/**
 * 데이터셋 버전 체인을 한 칸 올리는 좁은 포트 (§9.5 재현성).
 *
 * 팩트도 백테스트 입력이다 — 캔들과 똑같이 데이터셋 내용을 바꾼다. 그런데 잡의
 * `datasetVersion`/`datasetHash` 는 제출 시점의 데이터셋 최신 버전에서 고정되고,
 * 그 버전은 지금까지 캔들 변경(CSV import·증권사 동기화)만 올려왔다. 팩트를 백필하거나
 * DART 정정공시를 다시 받아도 버전이 그대로면 §9.5 열세 필드가 전부 일치하는데 자산
 * 곡선만 달라지고, 복제·재실행이 경고할 근거조차 없다.
 *
 * `market-data` 의 `DatasetService.bumpVersion` 이 이 모양을 그대로 구현한다 —
 * 두 번째 버전 체계를 새로 만들지 않고 기존 체인 해시를 재사용하기 위한 포트다.
 */
export interface DatasetVersionBumper {
  bumpVersion(datasetId: string, fingerprintSeed: string, nowMs: number): void;
}

export class FactSourceNotConfiguredError extends Error {
  constructor() {
    super('DART_API_KEY 가 설정되지 않았습니다. 재무 데이터 수집을 사용할 수 없습니다.');
    this.name = 'FactSourceNotConfiguredError';
  }
}
