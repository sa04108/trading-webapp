// 확장자 .js 와 별칭 없는 상대 경로는 실수가 아니다 — tests/unit/trade-sort.test.ts 가
// 이 모듈을 import 해 tsconfig.server.json 의 NodeNext 프로그램에 편입된다 (prefill.ts
// 와 같은 이유). 따라서 DOM 도 `@/` 도 쓰지 않는다.
import {
  DEFAULT_TRADE_SORT_DIRECTION,
  DEFAULT_TRADE_SORT_KEY,
  type SortDirection,
  type TradeSortKey,
} from '../../../shared/schemas/trade-sort.js';
import type { OpenPositionRow } from './open-position-rows.js';

export type { SortDirection, TradeSortKey };

export interface TradeSort {
  readonly key: TradeSortKey;
  readonly direction: SortDirection;
}

export const DEFAULT_TRADE_SORT: TradeSort = {
  key: DEFAULT_TRADE_SORT_KEY,
  direction: DEFAULT_TRADE_SORT_DIRECTION,
};

/** 열 머리글에 적히는 이름. 테이블 폭을 아끼려고 짧게 쓴다 */
export const TRADE_SORT_LABELS: Record<TradeSortKey, string> = {
  EXIT_TS: '청산',
  ENTRY_TS: '진입',
  QUANTITY: '수량',
  NET_PNL: '순손익',
  RETURN_PCT: '수익률',
  HOLDING_TIME: '보유',
};

/**
 * 방향을 사람 말로. 축마다 다르게 부른다 — 시각은 「빠른/느린」, 크기는 「높은/낮은」,
 * 기간은 「긴/짧은」이다. 「오름차순」으로 통일하면 시각이 오르는 것이 빠른 쪽인지
 * 머릿속에서 한 번 더 뒤집어야 한다.
 */
export const TRADE_SORT_DIRECTION_LABELS: Record<
  TradeSortKey,
  Record<SortDirection, string>
> = {
  EXIT_TS: { ASC: '빠른', DESC: '느린' },
  ENTRY_TS: { ASC: '빠른', DESC: '느린' },
  QUANTITY: { ASC: '낮은', DESC: '높은' },
  NET_PNL: { ASC: '낮은', DESC: '높은' },
  RETURN_PCT: { ASC: '낮은', DESC: '높은' },
  HOLDING_TIME: { ASC: '짧은', DESC: '긴' },
};

/**
 * 축을 처음 누를 때의 방향.
 *
 * 「수량」을 누르는 사람이 보려는 것은 큰 거래고, 「진입」을 누르는 사람이 보려는 것은
 * 처음 거래다 (종목 규모 정렬이 내림차순인 것과 같은 이유, D-038). 축마다 무조건
 * 오름차순으로 시작하면 사람마다 두 번 눌러야 하는 열이 생긴다.
 */
const FIRST_DIRECTION: Record<TradeSortKey, SortDirection> = {
  EXIT_TS: 'ASC',
  ENTRY_TS: 'ASC',
  QUANTITY: 'DESC',
  NET_PNL: 'DESC',
  RETURN_PCT: 'DESC',
  HOLDING_TIME: 'DESC',
};

/** 같은 축을 다시 누르면 방향만 뒤집고, 다른 축으로 옮기면 그 축의 첫 방향으로 간다 */
export function nextTradeSort(current: TradeSort, key: TradeSortKey): TradeSort {
  if (current.key !== key) return { key, direction: FIRST_DIRECTION[key] };
  return { key, direction: current.direction === 'ASC' ? 'DESC' : 'ASC' };
}

/** 누르면 어떻게 될지 — 버튼 `title` 이다. 지금 상태가 아니라 **다음** 상태를 적는다 */
export function tradeSortHint(current: TradeSort, key: TradeSortKey): string {
  const next = nextTradeSort(current, key);
  return `${TRADE_SORT_LABELS[key]} ${TRADE_SORT_DIRECTION_LABELS[key][next.direction]} 순으로 정렬`;
}

/** `<th aria-sort>` 값. 축이 아닌 열은 부르지 않는다 */
export function ariaSortValue(
  current: TradeSort,
  key: TradeSortKey,
): 'ascending' | 'descending' | 'none' {
  if (current.key !== key) return 'none';
  return current.direction === 'ASC' ? 'ascending' : 'descending';
}

/** 정렬 상태 한 줄 요약 — 표 밑에 지금 무슨 순서인지 적는다 */
export function tradeSortSummary(sort: TradeSort): string {
  return `${TRADE_SORT_LABELS[sort.key]} ${TRADE_SORT_DIRECTION_LABELS[sort.key][sort.direction]} 순`;
}

function openRowValue(row: OpenPositionRow, key: TradeSortKey): number | null {
  switch (key) {
    case 'QUANTITY':
      return row.quantity;
    case 'ENTRY_TS':
      return row.entryTsMs;
    case 'NET_PNL':
      // 청산 손익이 없으므로 평가 손익으로 줄을 세운다 — 열에 표시되는 값과 같다
      return row.unrealizedPnl;
    case 'RETURN_PCT':
      return row.returnPct;
    case 'HOLDING_TIME':
      return row.holdingTimeMs;
    // 청산 시각이 없다. 「미청산」끼리는 이 축에서 전부 동률이라 심볼 순으로 떨어진다
    case 'EXIT_TS':
      return null;
  }
}

/**
 * 미청산 행 정렬.
 *
 * 이 행들은 서버 페이징 밖이다 (재현 정보의 스냅샷에서 나오고 첫 페이지 위에 고정된다).
 * 청산 거래만 서버가 정렬하고 여기를 그대로 두면 「순손익 높은 순」을 골랐는데 맨 위
 * 몇 줄만 아무 순서인 표가 된다 — 같은 축으로 함께 정렬한다.
 *
 * 동률과 값 없는 축은 심볼 순으로 떨어뜨린다. 순서가 매 렌더 흔들리면 목록이 아니라
 * 셔플이다 (D-038 과 같은 이유).
 */
export function sortOpenRows(
  rows: readonly OpenPositionRow[],
  sort: TradeSort,
): OpenPositionRow[] {
  return [...rows].sort((a, b) => {
    const aValue = openRowValue(a, sort.key);
    const bValue = openRowValue(b, sort.key);
    if (aValue !== null && bValue !== null && aValue !== bValue) {
      return sort.direction === 'DESC' ? bValue - aValue : aValue - bValue;
    }
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
}
