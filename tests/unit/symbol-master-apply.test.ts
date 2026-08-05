import { describe, expect, it } from 'vitest';
import {
  applyEventsBackward, applyEventsForward, diffUniverse,
  type SymbolMasterEntry, type UniverseState,
} from '../../src/server/modules/market-data/domain/symbol-master.js';

// entry()/state() 헬퍼는 diff 테스트와 동일하게 정의한다
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

describe('이벤트 적용', () => {
  const a = state(
    entry(),
    entry({ standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스' }),
  );
  const b = state(
    entry({ sharesOutstanding: '90', name: '삼성전자(변경)' }),
    entry({ standardCode: 'KR7999999999', shortCode: '999999', name: '신규상장' }),
  );

  it('apply(diff(a,b), a) == b — 순방향 왕복', () => {
    const events = diffUniverse(a, b, META);
    expect(applyEventsForward(a, events)).toEqual(b);
  });

  it('applyBackward(diff(a,b), b) == a — 역방향 왕복', () => {
    const events = diffUniverse(a, b, META);
    expect(applyEventsBackward(b, events)).toEqual(a);
  });

  it('같은 이벤트를 두 번 적용해도 결과가 같다 — 절대값 멱등성', () => {
    const events = diffUniverse(a, b, META);
    const once = applyEventsForward(a, events);
    expect(applyEventsForward(once, events)).toEqual(once);
  });
});
