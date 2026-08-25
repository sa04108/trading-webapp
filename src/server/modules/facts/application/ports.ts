import type { Fact, FactScope } from '../domain/fact.js';

export interface FactQuery {
  readonly scope: FactScope;
  readonly keys?: readonly string[];
  readonly fields?: readonly string[];
  /** 이 시각 이후에 공시된 팩트는 제외한다 */
  readonly asOfMaxTsMs?: number;
}

export interface FactRepository {
  getFacts(query: FactQuery): Promise<Fact[]>;
  saveFacts(facts: readonly Fact[]): Promise<void>;
  /**
   * 종목 하나의 팩트 또는 수집 coverage 보유 여부. 목록 화면의 거친 배지용이다.
   * 제출 검증은 실제 PIT 재무 행과 필수 연도 coverage를 별도로 확인한다(D-069).
   */
  hasFacts(scope: FactScope, key: string): boolean;
  /**
   * 재무를 가진 종목 코드 전체.
   *
   * 목록 화면용이다. 종목마다 `hasFacts`를 부르는 대신 한 번에 읽어 비용을
   * **수집된 종목 수**에 묶는다 — 등록만 하고 수집하지 않은 종목은 0원이다.
   */
  symbolsWithFacts(): ReadonlySet<string>;
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
  /**
   * 재무제표·자본변동을 읽을 연도 (오름차순). 범위 두 값이 아닌 이유는 수집 이력이
   * 불연속일 수 있기 때문이다 — from/to 로 접으면 가운데 구멍을 수집했다고 거짓말한다.
   * FactSyncService의 quota-aware 실행은 저장 경계를 맞추기 위해 한 요청에 한 연도만
   * 넘기지만, CLI 외 직접 어댑터 호출과 기존 구현 호환을 위해 배열 contract는 유지한다.
   */
  readonly years: readonly number[];
  /**
   * 주식총수를 읽을 연도. `years` 의 **각 연도마다** 그 직전 1년을 더한 집합이다
   * (오름차순, 중복 제거).
   *
   * 자본변동 비율은 이벤트 직전 발행주식수를 분모(앵커)로 쓴다. 대상 연도만 읽으면
   * 연초 이벤트의 앵커가 없어 gap 이 되고, 가장 이른 연도 앞에만 앵커를 두면 더 나쁘다 —
   * `years` 가 불연속일 때(증분 수집의 정상 상태다) 구멍 건너편의 낡은 공시가 분모로
   * 잡혀 **gap 없이 조용히 틀린 비율**이 나온다. 그래서 구간마다 앵커가 필요하다.
   */
  readonly shareYears: readonly number[];
  /** true = 연결(CFS), false = 별도(OFS). 데이터셋 하나는 한 기준만 담는다 */
  readonly consolidated: boolean;
}

/** 공시검색(list.json)이 돌려주는 정기공시 한 건 */
export interface PeriodicFiling {
  /** DART 접수번호. 정정공시는 원공시와 다른 접수번호를 가진다 */
  readonly receiptNo: string;
  /** 6자리 종목코드. 비상장 제출자의 공시는 어댑터가 걸러 여기 오지 않는다 */
  readonly stockCode: string;
  /**
   * 보고서명 `(YYYY.MM)` 에서 뽑은 사업연도. 표기가 예상과 다르면 null — 호출부는
   * null 을 "어느 연도인지 모른다" 로 보고 보수적으로 처리해야 한다.
   */
  readonly businessYear: number | null;
  /** 접수일 (YYYY-MM-DD) */
  readonly receiptDate: string;
}

/**
 * FactSource가 물리적인 외부 요청을 시작하기 직전에 한 번 호출한다. 캐시 hit에는
 * 호출하지 않고 HTTP 재시도에는 매번 호출한다. 콜백이 예외를 던지면 요청을 보내지
 * 않는다.
 */
export interface FactSourceRequestHooks {
  beforeRequest?(): void;
}

export interface FactSource {
  /** 재무제표 계정 + 발행주식수 */
  fetchFinancials(
    request: FetchFinancialsRequest,
    hooks?: FactSourceRequestHooks,
  ): Promise<FactIngestionResult>;
  /** 분할·무상증자 등 자본변동 이벤트 */
  fetchCorporateActions(
    request: FetchFinancialsRequest,
    hooks?: FactSourceRequestHooks,
  ): Promise<FactIngestionResult>;
  /**
   * 구간 내 정기공시(사업·반기·분기보고서, 정정 포함) 목록. 증분 sync 가 "이미 covered
   * 인 연도 중 무엇이 다시 공시됐는가" 를 종목별 재수집 없이 한 번에 알아내는 데 쓴다 —
   * 유니버스 전체 × 연도당 최대 12회를 새 공시가 있는 종목만으로 줄인다.
   */
  listRecentPeriodicFilings(
    fromDate: string,
    toDate: string,
    hooks?: FactSourceRequestHooks,
  ): Promise<readonly PeriodicFiling[]>;
}

/**
 * 종목·슬라이스 버전 체인을 한 칸 올리는 좁은 포트 (§9.5 재현성).
 *
 * 팩트도 백테스트 입력이다 — 캔들과 똑같이 실행 결과를 바꾼다. 버전을 올리지 않으면
 * §9.5 필드가 전부 일치하는데 자산 곡선만 달라지고, 복제·재실행이 경고할 근거조차 없다.
 *
 * 재무는 슬라이스 축이 없으므로 `FACTS` 를 슬라이스 자리에 쓴다 — 봉 버전과 한 테이블에
 * 두면서도 서로의 체인을 밀지 않는다.
 */
export interface SymbolVersionBumper {
  bumpVersion(code: string, slice: string, fingerprintSeed: string, nowMs: number): void;
}

export class FactSourceNotConfiguredError extends Error {
  constructor() {
    super('DART 인증키가 설정되지 않아 재무 데이터를 수집할 수 없습니다.');
    this.name = 'FactSourceNotConfiguredError';
  }
}

/** DART가 실제 응답으로 알리거나 영속 원장에 이미 기록된 일일 호출 한도 소진. */
export class DartQuotaError extends Error {
  constructor(message = 'DART 일일 호출 한도를 초과했습니다. 다음 KST 날짜에 다시 시도합니다.') {
    super(message);
    this.name = 'DartQuotaError';
  }
}
