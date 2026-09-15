export const KRX_CONTRACT_VERSION = 'v1';

export type KrxMarket = 'KOSPI' | 'KOSDAQ';

export interface KrxIssueBaseInfoRow {
  /** 기본 ISU_CD — 표준 종목코드다. */
  readonly standardCode: string;
  /** ISU_SRT_CD — KRX 단축 종목코드다. */
  readonly shortCode: string;
  /** ISU_NM 원문이다. */
  readonly name: string;
  /** LIST_DD 를 ISO 날짜로 바꾼 값이다. 형식이 다르면 null 이다. */
  readonly listedDate: string | null;
  /** MKT_TP_NM 원문이다. */
  readonly marketRaw: string;
  /** SECUGRP_NM 원문이다. */
  readonly securityGroupRaw: string;
  /** SECT_TP_NM 원문이다. */
  readonly sectionRaw: string | null;
  /** KIND_STKCERT_TP_NM 원문이다. */
  readonly stockKindRaw: string | null;
  /** LIST_SHRS — 상장주식수. 콤마 없는 10진 정수 문자열, 알 수 없으면 null 이다. */
  readonly listedShares: string | null;
}

export interface KrxDailyTradeRow {
  /** 일별 API 의 ISU_CD 는 단축 종목코드다. */
  readonly shortCode: string;
  readonly name: string;
  /** 콤마를 없앤 10진 정수 문자열이다. 알 수 없으면 null 이다. */
  readonly marketCapRaw: string | null;
  /** ACC_TRDVAL 원문이다. number 로 좁히지 않으며, 알 수 없으면 null 이다. */
  readonly tradingValueRaw: string | null;
  // 값을 모르면 null 이다(휴장 직후·거래 정지 등). 가격·거래량은 원 단위 정수라
  // 2^53 을 넘지 않으므로 number 로 둔다.
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
  readonly volume: number | null;
}
