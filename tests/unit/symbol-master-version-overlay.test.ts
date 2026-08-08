import { describe, expect, it } from 'vitest';
import type { SymbolMasterEntry } from '../../src/server/modules/market-data/domain/symbol-master.js';
import {
  overlayVersionTimeline,
  type SymbolMasterVersionSegment,
} from '../../src/server/modules/market-data/domain/symbol-master-version.js';

function entry(overrides: Partial<SymbolMasterEntry> = {}): SymbolMasterEntry {
  return {
    standardCode: 'KR7005930003',
    shortCode: '005930',
    name: '삼성전자',
    market: 'KOSPI',
    sharesOutstanding: '100',
    instrumentType: 'COMMON_STOCK',
    listedDate: '1975-06-11',
    ...overrides,
  };
}

function segment(
  validFromDate: string,
  validToDate: string | null,
  value: SymbolMasterEntry = entry(),
  recordedAtMs = 10,
): SymbolMasterVersionSegment {
  return { validFromDate, validToDate, entry: value, recordedAtMs };
}

describe('overlayVersionTimeline', () => {
  it('중간 구간만 새 상태로 덮고 앞뒤 상태를 보존한다', () => {
    const original = entry();
    const changed = entry({ sharesOutstanding: '150' });

    expect(overlayVersionTimeline(
      [segment('2023-01-01', null, original)],
      '2023-02-01',
      '2023-03-01',
      changed,
      20,
    )).toEqual([
      segment('2023-01-01', '2023-02-01', original),
      segment('2023-02-01', '2023-03-01', changed, 20),
      segment('2023-03-01', null, original),
    ]);
  });

  it('새 상태가 다음 버전과 같으면 경계를 앞당겨 한 버전으로 합친다', () => {
    const original = entry();
    const changed = entry({ name: '삼성전자우' });

    expect(overlayVersionTimeline(
      [
        segment('2023-01-01', '2023-03-01', original, 10),
        segment('2023-03-01', null, changed, 20),
      ],
      '2023-02-01',
      '2023-03-01',
      changed,
      30,
    )).toEqual([
      segment('2023-01-01', '2023-02-01', original, 10),
      segment('2023-02-01', null, changed, 20),
    ]);
  });

  it('기존 상태와 같은 값을 덮으면 인접 구간을 합쳐 행 수가 늘지 않는다', () => {
    const original = entry();

    expect(overlayVersionTimeline(
      [segment('2023-01-01', null, original, 10)],
      '2023-02-01',
      '2023-03-01',
      original,
      20,
    )).toEqual([
      segment('2023-01-01', null, original, 10),
    ]);
  });

  it('desired가 없으면 해당 구간을 부재 상태로 만들고 양쪽 버전을 분리한다', () => {
    const original = entry();

    expect(overlayVersionTimeline(
      [segment('2023-01-01', null, original)],
      '2023-02-01',
      '2023-03-01',
      undefined,
      20,
    )).toEqual([
      segment('2023-01-01', '2023-02-01', original),
      segment('2023-03-01', null, original),
    ]);
  });

  it('종료일 없는 부재 overlay는 기존 열린 버전을 종료한다', () => {
    const original = entry();

    expect(overlayVersionTimeline(
      [segment('2023-01-01', null, original)],
      '2023-02-01',
      null,
      undefined,
      20,
    )).toEqual([
      segment('2023-01-01', '2023-02-01', original),
    ]);
  });

  it('빈 구간이나 역전된 구간을 거부한다', () => {
    expect(() => overlayVersionTimeline([], '2023-02-01', '2023-02-01', entry(), 20))
      .toThrow('잘못된 종목 버전 덮어쓰기 구간');
    expect(() => overlayVersionTimeline([], '2023-03-01', '2023-02-01', entry(), 20))
      .toThrow('잘못된 종목 버전 덮어쓰기 구간');
  });
});
