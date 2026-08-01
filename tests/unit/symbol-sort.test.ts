import { describe, expect, it } from 'vitest';
import {
  countWithMetric,
  metricValue,
  sortSymbols,
  type SymbolMetricsMap,
} from '../../src/web/features/datasets/symbol-sort.js';

const SYMBOLS = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '035720', name: '카카오' },
  { code: '999999', name: null },
];

const METRICS: SymbolMetricsMap = new Map([
  ['005930', { marketCap: 400e12, tradingValue: 1e12, tradingVolume: 18_000_000 }],
  ['000660', { marketCap: 130e12, tradingValue: 9e11, tradingVolume: 4_800_000 }],
  // 카카오는 시가총액만 있고 거래 지표는 랭킹 밖이라 없다
  ['035720', { marketCap: 20e12, tradingValue: null, tradingVolume: null }],
]);

const codes = (rows: ReadonlyArray<{ code: string }>): string[] => rows.map((row) => row.code);

/** 한국어 collator 기준 이름 순서: 삼성전자 < 카카오 < SK하이닉스 < (이름 없음) */
const BY_NAME = ['005930', '035720', '000660', '999999'];

describe('sortSymbols', () => {
  it('기본은 가나다순이고 이름 없는 종목은 뒤로 간다', () => {
    expect(codes(sortSymbols(SYMBOLS))).toEqual(BY_NAME);
  });

  it('규모 지표는 내림차순이다', () => {
    expect(codes(sortSymbols(SYMBOLS, 'MARKET_CAP', METRICS))).toEqual([
      '005930',
      '000660',
      '035720',
      '999999',
    ]);
    expect(codes(sortSymbols(SYMBOLS, 'TRADING_VOLUME', METRICS))).toEqual([
      '005930',
      '000660',
      // 값 없는 둘은 뒤에서 가나다순 — 카카오(이름 있음)가 999999(이름 없음)보다 앞
      '035720',
      '999999',
    ]);
  });

  // 값 없는 종목을 0 으로 치면 "거래 없는 종목" 과 "랭킹 밖 종목" 이 같은 칸에 놓인다
  it('지표가 없는 종목은 값이 아무리 작은 종목보다도 뒤에 온다', () => {
    const metrics: SymbolMetricsMap = new Map([
      ['035720', { marketCap: null, tradingValue: null, tradingVolume: null }],
      ['005930', { marketCap: 1, tradingValue: null, tradingVolume: null }],
    ]);
    // 시가총액 1원인 삼성전자만 앞으로 나오고, 나머지는 값이 없어 가나다순으로 뒤에 선다
    expect(codes(sortSymbols(SYMBOLS, 'MARKET_CAP', metrics))).toEqual([
      '005930',
      '035720',
      '000660',
      '999999',
    ]);
  });

  it('값이 같으면 가나다순으로 떨어져 순서가 렌더마다 흔들리지 않는다', () => {
    const tied: SymbolMetricsMap = new Map([
      ['005930', { marketCap: 100, tradingValue: null, tradingVolume: null }],
      ['000660', { marketCap: 100, tradingValue: null, tradingVolume: null }],
      ['035720', { marketCap: 100, tradingValue: null, tradingVolume: null }],
    ]);
    const once = codes(sortSymbols(SYMBOLS, 'MARKET_CAP', tied));
    expect(once).toEqual(BY_NAME);
    // 입력 순서가 달라도 같은 결과 — 완전순서라 렌더마다 뒤집히지 않는다
    expect(codes(sortSymbols([...SYMBOLS].reverse(), 'MARKET_CAP', tied))).toEqual(once);
  });

  it('지표 맵이 없으면 가나다순으로 떨어진다', () => {
    expect(codes(sortSymbols(SYMBOLS, 'TRADING_VALUE'))).toEqual(codes(sortSymbols(SYMBOLS)));
  });

  it('원본 배열을 바꾸지 않는다', () => {
    const original = [...SYMBOLS];
    sortSymbols(SYMBOLS, 'MARKET_CAP', METRICS);
    expect(SYMBOLS).toEqual(original);
  });
});

describe('metricValue', () => {
  it('NaN·Infinity 는 모름으로 접는다 — 비교에서 순서를 무너뜨린다', () => {
    const broken = { marketCap: Number.NaN, tradingValue: Infinity, tradingVolume: 0 };
    expect(metricValue(broken, 'MARKET_CAP')).toBeNull();
    expect(metricValue(broken, 'TRADING_VALUE')).toBeNull();
    // 0 은 값이다 — 모름과 구분한다
    expect(metricValue(broken, 'TRADING_VOLUME')).toBe(0);
  });

  it('가나다순에는 지표가 없다', () => {
    expect(metricValue(METRICS.get('005930'), 'NAME')).toBeNull();
    expect(metricValue(undefined, 'MARKET_CAP')).toBeNull();
  });
});

describe('countWithMetric', () => {
  it('지표를 가진 종목만 센다', () => {
    const all = codes(SYMBOLS);
    expect(countWithMetric(all, 'MARKET_CAP', METRICS)).toBe(3);
    expect(countWithMetric(all, 'TRADING_VALUE', METRICS)).toBe(2);
    // 가나다순은 전 종목을 덮는다 — 「N종목 집계 없음」 문구가 뜨지 않아야 한다
    expect(countWithMetric(all, 'NAME', METRICS)).toBe(all.length);
  });
});
