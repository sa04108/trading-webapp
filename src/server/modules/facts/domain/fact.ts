/**
 * 상장시점(point-in-time) 팩트 — 재무·거시 지표를 장(long) 포맷 하나로 담는다.
 * 새 지표를 추가할 때 스키마 마이그레이션이 없다는 것이 이 모양의 이유다.
 */
export type FactScope = 'SYMBOL' | 'MACRO';

export interface Fact {
  readonly scope: FactScope;
  /** SYMBOL 이면 종목코드, MACRO 이면 지표 키 (예: 'KR_BASE_RATE') */
  readonly key: string;
  readonly field: string;
  /** 기준 기간. 분기 '2025Q1' | 연간 '2025FY' | 시점성 이벤트 '2025-03-14' */
  readonly periodKey: string;
  /** 이 값이 세상에 알려진 시각 — PIT 컷오프 기준 (DART 접수일 18:00 KST) */
  readonly asOfTsMs: number;
  readonly value: number;
  readonly unit: string;
}

/** 전략이 참조하는 재무 계정. 문자열 리터럴 유니온이라 오타가 컴파일에서 잡힌다. */
export type FundamentalField =
  | 'OPERATING_INCOME'
  | 'CURRENT_ASSETS'
  | 'CURRENT_LIABILITIES'
  | 'TANGIBLE_ASSETS'
  | 'CASH_AND_EQUIVALENTS'
  | 'SHORT_TERM_INVESTMENTS'
  | 'SHORT_TERM_BORROWINGS'
  | 'CURRENT_LONG_TERM_DEBT'
  | 'BONDS'
  | 'LONG_TERM_BORROWINGS'
  | 'SHARES_OUTSTANDING';

/** 손익 계정 — 분기 단독값이며 TTM 합산 대상 */
export const FLOW_FIELDS: readonly FundamentalField[] = ['OPERATING_INCOME'];

/**
 * 자본변동 이벤트는 값이 '비율' 이라 재무 계정과 성질이 다르다 — 별도 field 로 둔다.
 * periodKey = 효력 발생일('YYYY-MM-DD', 거래소 현지 날짜), value = 주식수 증가 배수.
 */
export const CORPORATE_ACTION_FIELD = 'SPLIT_RATIO';

export interface CorporateAction {
  /** 효력 발생일의 거래소 현지 자정을 UTC 로 옮긴 시각 */
  readonly effectiveTsMs: number;
  /** 주식수 증가 배수. 2:1 분할 = 2 */
  readonly ratio: number;
}

export interface FundamentalSnapshot {
  /** 이 시점까지 공시된 것 중 가장 최근 분기의 값 */
  get(field: FundamentalField): number | null;
  /** 직전 4개 분기 합. 4개가 채워지지 않으면 null */
  ttm(field: FundamentalField): number | null;
  /**
   * `get(field)` 가 반환하는 값이 속한 분기 키. 그 계정에 공시가 하나도 없으면 null.
   * `latestPeriodKey` 는 스냅샷 전체(모든 계정을 통틀은 최댓값) 신선도 신호인 반면,
   * 이건 계정 하나만의 신선도다 — 계정마다 실제 공시 빈도가 달라 전사 최댓값만 보면
   * 어떤 계정은 최신인데 다른 계정은 몇 년째 갱신되지 않은 상태가 가려질 수 있다.
   * (이건 필드별 신선도 커서가 필요한 이유에 대한 설명일 뿐, 수집 주기에 대한 스펙이
   * 아니다 — 발행주식수를 포함해 이 스냅샷의 모든 계정은 분기 정기보고서마다 갱신
   * 대상이다. DART `stockTotqySttus` 는 사업보고서뿐 아니라 분기·반기보고서에도
   * '주식의 총수 현황' 섹션을 담고 있다.)
   */
  periodKeyOf(field: FundamentalField): string | null;
  readonly latestPeriodKey: string | null;
  readonly latestAsOfTsMs: number | null;
}
