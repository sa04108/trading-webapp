import type { FundamentalField } from '../../domain/fact.js';

export interface DartAccountRule {
  readonly field: FundamentalField;
  /** BS = 재무상태표(시점값), IS = 손익계산서(기간값 — 누적 차분 필요) */
  readonly statement: 'BS' | 'IS';
}

/**
 * IFRS 표준 태그(account_id) 우선 매핑. 이것이 있으면 회사별 계정명 차이를 타지 않는다.
 * 태그·필드 이름은 DART API 키 발급 후 실제 응답으로 검증해 조정한다
 * (toss-stock-info-source.ts 가 쓰는 것과 같은 관례).
 */
const BY_ACCOUNT_ID: Record<string, DartAccountRule> = {
  'ifrs-full_ProfitLossFromOperatingActivities': { field: 'OPERATING_INCOME', statement: 'IS' },
  'dart_OperatingIncomeLoss': { field: 'OPERATING_INCOME', statement: 'IS' },
  'ifrs-full_ProfitLoss': { field: 'NET_INCOME', statement: 'IS' },
  'ifrs-full_CurrentAssets': { field: 'CURRENT_ASSETS', statement: 'BS' },
  'ifrs-full_CurrentLiabilities': { field: 'CURRENT_LIABILITIES', statement: 'BS' },
  'ifrs-full_PropertyPlantAndEquipment': { field: 'TANGIBLE_ASSETS', statement: 'BS' },
  'ifrs-full_CashAndCashEquivalents': { field: 'CASH_AND_EQUIVALENTS', statement: 'BS' },
  'dart_ShortTermDepositsNotClassifiedAsCashEquivalents': {
    field: 'SHORT_TERM_INVESTMENTS',
    statement: 'BS',
  },
  'ifrs-full_ShorttermBorrowings': { field: 'SHORT_TERM_BORROWINGS', statement: 'BS' },
  'dart_ShortTermBorrowings': { field: 'SHORT_TERM_BORROWINGS', statement: 'BS' },
  'dart_CurrentPortionOfLongTermBorrowings': {
    field: 'CURRENT_LONG_TERM_DEBT',
    statement: 'BS',
  },
  'dart_BondsIssued': { field: 'BONDS', statement: 'BS' },
  'ifrs-full_LongtermBorrowings': { field: 'LONG_TERM_BORROWINGS', statement: 'BS' },
  'dart_LongTermBorrowings': { field: 'LONG_TERM_BORROWINGS', statement: 'BS' },
  'ifrs-full_Equity': { field: 'TOTAL_EQUITY', statement: 'BS' },
};

/**
 * 계정명(account_nm) 폴백. 표준 태그가 '-표준계정코드 미사용-' 인 회사를 위한 경로다.
 * 공백을 제거하고 정확히 일치하는 것만 받는다 — 부분 일치는 '단기차입금' 이
 * '유동성장기차입금' 을 잡는 식으로 조용히 틀린다.
 */
const BY_ACCOUNT_NAME: Record<string, DartAccountRule> = {
  영업이익: { field: 'OPERATING_INCOME', statement: 'IS' },
  '영업이익(손실)': { field: 'OPERATING_INCOME', statement: 'IS' },
  당기순이익: { field: 'NET_INCOME', statement: 'IS' },
  '당기순이익(손실)': { field: 'NET_INCOME', statement: 'IS' },
  유동자산: { field: 'CURRENT_ASSETS', statement: 'BS' },
  유동부채: { field: 'CURRENT_LIABILITIES', statement: 'BS' },
  유형자산: { field: 'TANGIBLE_ASSETS', statement: 'BS' },
  현금및현금성자산: { field: 'CASH_AND_EQUIVALENTS', statement: 'BS' },
  단기금융상품: { field: 'SHORT_TERM_INVESTMENTS', statement: 'BS' },
  단기차입금: { field: 'SHORT_TERM_BORROWINGS', statement: 'BS' },
  유동성장기부채: { field: 'CURRENT_LONG_TERM_DEBT', statement: 'BS' },
  유동성장기차입금: { field: 'CURRENT_LONG_TERM_DEBT', statement: 'BS' },
  사채: { field: 'BONDS', statement: 'BS' },
  장기차입금: { field: 'LONG_TERM_BORROWINGS', statement: 'BS' },
  자본총계: { field: 'TOTAL_EQUITY', statement: 'BS' },
};

/**
 * 두 인자는 **문자열임이 확인된 값** 이어야 한다 — 여기서 `.trim()`·`.replace()` 를
 * 바로 부르기 때문에, 이름이 바뀐 DART 필드를 그대로 넘기면 영어 bare TypeError 가
 * 수집 전체를 죽인다. 호출부(dart-report-parser.ts)가 `readString` 으로 확인하고,
 * 어긋난 필드는 그 필드 이름을 밝히는 gap 으로 남긴다. 이 함수를 새로 호출하게 될 때도
 * 같은 관문을 통과시켜야 한다.
 */
export function resolveAccount(accountId: string, accountName: string): DartAccountRule | null {
  const byId = BY_ACCOUNT_ID[accountId.trim()];
  if (byId) return byId;
  return BY_ACCOUNT_NAME[accountName.replace(/\s/g, '')] ?? null;
}
