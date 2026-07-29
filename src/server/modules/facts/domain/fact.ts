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
  readonly latestPeriodKey: string | null;
  readonly latestAsOfTsMs: number | null;
}
