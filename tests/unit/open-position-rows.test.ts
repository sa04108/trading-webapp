import { describe, expect, it } from 'vitest';
import { openPositionRows } from '../../src/web/features/backtests/open-position-rows.js';

const ENTRY_1 = Date.parse('2026-03-30T10:00:00+09:00');
const ENTRY_2 = Date.parse('2026-03-31T14:00:00+09:00');

const snapshotJson = JSON.stringify([
  {
    symbol: '005930',
    quantity: 10,
    avgEntryPrice: 70_000,
    entryTsMs: ENTRY_1,
    lastPrice: 71_000,
    unrealizedPnl: 10_000,
    returnPct: 1.43,
  },
  {
    symbol: '000660',
    quantity: 5,
    avgEntryPrice: 200_000,
    entryTsMs: ENTRY_2,
    lastPrice: 190_000,
    unrealizedPnl: -50_000,
    returnPct: -5,
  },
]);

describe('openPositionRows', () => {
  it('JSON 이 null 이면 빈 배열을 반환한다', () => {
    expect(openPositionRows(null, 'ALL', '2026-03-31')).toEqual([]);
  });

  it('JSON 이 깨져 있으면 빈 배열을 반환한다', () => {
    expect(openPositionRows('{not json', 'ALL', '2026-03-31')).toEqual([]);
  });

  it('전체 심볼: 스냅샷을 행으로 변환하고 보유 시간은 기간 종료(당일 23:59:59 KST) 기준으로 계산한다', () => {
    const rows = openPositionRows(snapshotJson, 'ALL', '2026-03-31');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      symbol: '005930',
      quantity: 10,
      entryTsMs: ENTRY_1,
      entryPrice: 70_000,
      lastPrice: 71_000,
      unrealizedPnl: 10_000,
      returnPct: 1.43,
      holdingTimeMs: Date.parse('2026-03-31T23:59:59+09:00') - ENTRY_1,
    });
  });

  it('심볼 필터가 ALL 이 아니면 해당 심볼만 남긴다', () => {
    const rows = openPositionRows(snapshotJson, '000660', '2026-03-31');
    expect(rows.map((r) => r.symbol)).toEqual(['000660']);
  });

  it('진입 시각이 기간 종료 이후여도 보유 시간은 0 미만이 되지 않는다', () => {
    const rows = openPositionRows(snapshotJson, '005930', '2026-03-29');
    expect(rows[0].holdingTimeMs).toBe(0);
  });
});
