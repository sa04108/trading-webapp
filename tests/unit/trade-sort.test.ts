import { describe, expect, it } from 'vitest';
import type { OpenPositionRow } from '../../src/web/features/backtests/open-position-rows.js';
import {
  ariaSortValue,
  DEFAULT_TRADE_SORT,
  nextTradeSort,
  sortOpenRows,
  TRADE_SORT_LABELS,
  tradeSortHint,
  tradeSortSummary,
  type TradeSort,
} from '../../src/web/features/backtests/trade-sort.js';
import { TRADE_SORT_KEYS } from '../../src/shared/schemas/trade-sort.js';

describe('DEFAULT_TRADE_SORT', () => {
  // 화면 기본값과 서버 기본값이 갈라지면 「청산 빠른 순」을 표시한 채 다른 순서를
  // 보여 준다 — 리터럴로 고정해 어느 쪽이 바뀌어도 잡는다
  it('서버 기본 정렬과 같다', () => {
    expect(DEFAULT_TRADE_SORT).toEqual({ key: 'EXIT_TS', direction: 'ASC' });
  });

  it('모든 축에 라벨이 있다', () => {
    for (const key of TRADE_SORT_KEYS) {
      expect(TRADE_SORT_LABELS[key]).toBeTruthy();
    }
  });
});

describe('nextTradeSort', () => {
  it('같은 축을 다시 누르면 방향만 뒤집는다', () => {
    const first = nextTradeSort(DEFAULT_TRADE_SORT, 'NET_PNL');
    expect(first).toEqual({ key: 'NET_PNL', direction: 'DESC' });
    expect(nextTradeSort(first, 'NET_PNL')).toEqual({ key: 'NET_PNL', direction: 'ASC' });
    expect(nextTradeSort({ key: 'NET_PNL', direction: 'ASC' }, 'NET_PNL')).toEqual({
      key: 'NET_PNL',
      direction: 'DESC',
    });
  });

  it('크기 축은 큰 값부터, 시각 축은 빠른 것부터 시작한다', () => {
    const from: TradeSort = { key: 'EXIT_TS', direction: 'DESC' };
    expect(nextTradeSort(from, 'QUANTITY').direction).toBe('DESC');
    expect(nextTradeSort(from, 'RETURN_PCT').direction).toBe('DESC');
    expect(nextTradeSort(from, 'HOLDING_TIME').direction).toBe('DESC');
    expect(nextTradeSort(from, 'ENTRY_TS').direction).toBe('ASC');
    // 축을 옮기면 이전 축의 방향을 물려받지 않는다
    expect(nextTradeSort({ key: 'QUANTITY', direction: 'ASC' }, 'ENTRY_TS').direction).toBe('ASC');
  });

  it('모든 축이 두 방향에 모두 도달한다', () => {
    for (const key of TRADE_SORT_KEYS) {
      const first = nextTradeSort({ key: 'EXIT_TS', direction: 'ASC' }, key);
      const second = nextTradeSort(first, key);
      expect(new Set([first.direction, second.direction])).toEqual(new Set(['ASC', 'DESC']));
    }
  });
});

describe('정렬 상태 표기', () => {
  it('aria-sort 는 고른 축에만 방향을 싣는다', () => {
    const sort: TradeSort = { key: 'NET_PNL', direction: 'DESC' };
    expect(ariaSortValue(sort, 'NET_PNL')).toBe('descending');
    expect(ariaSortValue({ key: 'NET_PNL', direction: 'ASC' }, 'NET_PNL')).toBe('ascending');
    expect(ariaSortValue(sort, 'QUANTITY')).toBe('none');
  });

  it('title 은 지금 상태가 아니라 누르면 될 상태를 적는다', () => {
    // 「청산 빠른 순」인 상태에서 청산을 누르면 느린 순이 된다
    expect(tradeSortHint({ key: 'EXIT_TS', direction: 'ASC' }, 'EXIT_TS')).toBe(
      '청산 느린 순으로 정렬',
    );
    // 아직 고르지 않은 축은 그 축의 첫 방향을 적는다
    expect(tradeSortHint({ key: 'EXIT_TS', direction: 'ASC' }, 'HOLDING_TIME')).toBe(
      '보유 긴 순으로 정렬',
    );
  });

  it('요약은 축을 부르는 말로 방향을 적는다', () => {
    expect(tradeSortSummary({ key: 'QUANTITY', direction: 'ASC' })).toBe('수량 낮은 순');
    expect(tradeSortSummary({ key: 'ENTRY_TS', direction: 'DESC' })).toBe('진입 느린 순');
  });
});

describe('sortOpenRows', () => {
  function row(symbol: string, overrides: Partial<OpenPositionRow> = {}): OpenPositionRow {
    return {
      symbol,
      quantity: 10,
      entryTsMs: 1_000,
      entryPrice: 100,
      lastPrice: 110,
      unrealizedPnl: 100,
      returnPct: 10,
      holdingTimeMs: 5_000,
      ...overrides,
    };
  }

  const rows = [
    row('000660', { quantity: 5, entryTsMs: 3_000, unrealizedPnl: -50, returnPct: -5 }),
    row('005930', { quantity: 30, entryTsMs: 1_000, unrealizedPnl: 900, returnPct: 12 }),
    row('035720', { quantity: 12, entryTsMs: 2_000, unrealizedPnl: 40, returnPct: 1 }),
  ];
  const codes = (result: readonly OpenPositionRow[]): string[] => result.map((r) => r.symbol);

  it('입력을 변형하지 않는다', () => {
    const before = codes(rows);
    sortOpenRows(rows, { key: 'QUANTITY', direction: 'ASC' });
    expect(codes(rows)).toEqual(before);
  });

  it('수량·수익률·보유기간을 두 방향으로 정렬한다', () => {
    expect(codes(sortOpenRows(rows, { key: 'QUANTITY', direction: 'DESC' }))).toEqual([
      '005930',
      '035720',
      '000660',
    ]);
    expect(codes(sortOpenRows(rows, { key: 'QUANTITY', direction: 'ASC' }))).toEqual([
      '000660',
      '035720',
      '005930',
    ]);
    expect(codes(sortOpenRows(rows, { key: 'RETURN_PCT', direction: 'DESC' }))).toEqual([
      '005930',
      '035720',
      '000660',
    ]);
  });

  it('순손익 축은 평가 손익으로 줄을 세운다 (청산 손익이 없다)', () => {
    expect(codes(sortOpenRows(rows, { key: 'NET_PNL', direction: 'ASC' }))).toEqual([
      '000660',
      '035720',
      '005930',
    ]);
  });

  it('진입 시각은 빠른 것부터가 오름차순이다', () => {
    expect(codes(sortOpenRows(rows, { key: 'ENTRY_TS', direction: 'ASC' }))).toEqual([
      '005930',
      '035720',
      '000660',
    ]);
  });

  it('청산 시각 축에서는 전부 동률이라 심볼 순으로 떨어진다', () => {
    // 미청산 행에는 청산 시각이 없다. 방향을 바꿔도 순서가 흔들리지 않아야 한다 —
    // 흔들리면 「청산 빠른 순 / 느린 순」을 번갈아 누를 때 고정 행이 춤춘다
    expect(codes(sortOpenRows(rows, { key: 'EXIT_TS', direction: 'ASC' }))).toEqual([
      '000660',
      '005930',
      '035720',
    ]);
    expect(codes(sortOpenRows(rows, { key: 'EXIT_TS', direction: 'DESC' }))).toEqual([
      '000660',
      '005930',
      '035720',
    ]);
  });

  it('값이 같으면 심볼 순으로 떨어져 완전순서가 된다', () => {
    const tied = [row('035720'), row('000660'), row('005930')];
    expect(codes(sortOpenRows(tied, { key: 'HOLDING_TIME', direction: 'DESC' }))).toEqual([
      '000660',
      '005930',
      '035720',
    ]);
  });
});
