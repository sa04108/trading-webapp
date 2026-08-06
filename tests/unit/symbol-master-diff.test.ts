import { describe, expect, it } from 'vitest';
import {
  diffUniverse,
  type SymbolMasterEntry,
  type UniverseState,
} from '../../src/server/modules/market-data/domain/symbol-master.js';

function entry(overrides: Partial<SymbolMasterEntry> = {}): SymbolMasterEntry {
  return {
    standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자',
    market: 'KOSPI', sharesOutstanding: '100', instrumentType: 'COMMON_STOCK',
    listedDate: '1975-06-11', ...overrides,
  };
}
function state(...entries: SymbolMasterEntry[]): UniverseState {
  return new Map(entries.map((e) => [e.standardCode, e]));
}
const META = { effectiveDate: '2023-01-03', observedSpanStart: '2023-01-02' };

describe('diffUniverse', () => {
  it('변화가 없으면 이벤트가 없다', () => {
    expect(diffUniverse(state(entry()), state(entry()), META)).toEqual([]);
  });

  it('신규 종목은 LISTED, newValue 에 entry 전체를 담는다', () => {
    const e = entry();
    const events = diffUniverse(state(), state(e), META);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'LISTED', standardCode: e.standardCode,
      oldValue: null, effectiveDate: '2023-01-03', observedSpanStart: '2023-01-02',
    });
    expect(JSON.parse(events[0]!.newValue!)).toEqual(e);
  });

  it('사라진 종목은 DELISTED, oldValue 에 entry 전체를 담는다', () => {
    const e = entry();
    const events = diffUniverse(state(e), state(), META);
    expect(events[0]).toMatchObject({ eventType: 'DELISTED', newValue: null });
    expect(JSON.parse(events[0]!.oldValue!)).toEqual(e);
  });

  it('필드 변경은 필드별 이벤트를 만든다', () => {
    const prev = entry();
    const next = entry({ sharesOutstanding: '90', market: 'KOSDAQ' });
    const events = diffUniverse(state(prev), state(next), META);
    const types = events.map((ev) => ev.eventType).sort();
    expect(types).toEqual(['MARKET_MOVED', 'SHARES_CHANGED']);
    const shares = events.find((ev) => ev.eventType === 'SHARES_CHANGED')!;
    expect(JSON.parse(shares.oldValue!)).toBe('100');
    expect(JSON.parse(shares.newValue!)).toBe('90');
  });

  it('이름·유형 변경도 감지한다', () => {
    const next = entry({ name: '삼성전자우', instrumentType: 'PREFERRED_STOCK' });
    const types = diffUniverse(state(entry()), state(next), META)
      .map((ev) => ev.eventType).sort();
    expect(types).toEqual(['NAME_CHANGED', 'TYPE_CHANGED']);
  });
});
