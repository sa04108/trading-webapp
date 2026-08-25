/**
 * 거래 내역 정렬 축과 방향.
 *
 * 화면과 라우트가 **같은 문자열**을 써야 한다 — 한쪽만 이름을 바꾸면 그 어긋남은 조회
 * 400 으로만 드러난다. 값만 담고 zod 스키마는 두지 않는다: 상수 하나 때문에 zod 가
 * 웹 번들에 들어오면 안 된다. 라우트가 이 목록으로 enum 을 만든다.
 *
 * 정렬은 서버가 한다. 거래 내역은 서버 페이징이라 화면에서 정렬하면 보이는 한 페이지만
 * 뒤집혀 「전체 중 손익 1위」가 아니라 「이 10건 중 1위」가 나온다.
 */
export const TRADE_SORT_KEYS = [
  'EXIT_TS',
  'ENTRY_TS',
  'QUANTITY',
  'NET_PNL',
  'RETURN_PCT',
  'HOLDING_TIME',
] as const;

export type TradeSortKey = (typeof TRADE_SORT_KEYS)[number];

export const SORT_DIRECTIONS = ['ASC', 'DESC'] as const;

export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/**
 * 기본 정렬 — 매도 체결 시각 오름차순.
 *
 * 정렬 파라미터가 없던 시절의 순서 그대로다. 기본값을 바꾸면 저장된 링크와 export 가
 * 가리키는 순서가 달라지고, 그 차이는 어디에도 적혀 있지 않다.
 */
export const DEFAULT_TRADE_SORT_KEY: TradeSortKey = 'EXIT_TS';
export const DEFAULT_TRADE_SORT_DIRECTION: SortDirection = 'ASC';
