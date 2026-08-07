import { describe, expect, it, vi } from 'vitest';
import { SymbolMetricsService } from '../../src/server/modules/market-data/application/symbol-metrics-service.js';
import { SymbolInfoService } from '../../src/server/modules/market-data/application/symbol-info-service.js';
import {
  MarketDataSourceNotConfiguredError,
  type MarketRankingEntry,
  type MarketRankingMetric,
  type StockInfo,
} from '../../src/server/modules/market-data/application/ports.js';
import type { Market } from '../../src/server/modules/market-data/domain/candle.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));

function stock(symbol: string, sharesOutstanding: number | null): StockInfo {
  return {
    symbol,
    name: symbol,
    englishName: null,
    market: 'KOSPI',
    status: 'ACTIVE',
    sharesOutstanding,
  };
}

interface Harness {
  readonly service: SymbolMetricsService;
  readonly getStockInfo: ReturnType<typeof vi.fn>;
  readonly getQuotes: ReturnType<typeof vi.fn>;
  readonly getRanking: ReturnType<typeof vi.fn>;
  readonly nowRef: { now: number };
}

function build(options: {
  stocks?: StockInfo[];
  quotes?: Array<{ symbol: string; lastPrice: number }>;
  rankings?: Partial<Record<MarketRankingMetric, MarketRankingEntry[]>>;
} = {}): Harness {
  const nowRef = { now: 0 };
  const clock = { now: () => nowRef.now };
  const getStockInfo = vi.fn(async () => ({
    stocks: options.stocks ?? [],
    failedSymbols: [],
  }));
  const getQuotes = vi.fn(async () => options.quotes ?? []);
  const getRanking = vi.fn(
    async (_market: Market, metric: MarketRankingMetric) => options.rankings?.[metric] ?? [],
  );
  const symbolInfo = new SymbolInfoService({ getStockInfo }, clock, logger);
  return {
    service: new SymbolMetricsService(
      symbolInfo,
      { getQuotes },
      { getRanking },
      clock,
      logger,
    ),
    getStockInfo,
    getQuotes,
    getRanking,
    nowRef,
  };
}

const SAMSUNG = { code: '005930', market: 'KR' as const };
const HYNIX = { code: '000660', market: 'KR' as const };

describe('SymbolMetricsService (종목 정렬 지표)', () => {
  it('시가총액을 발행주식수 × 현재가로 만든다', async () => {
    const { service } = build({
      stocks: [stock('005930', 5_000_000_000)],
      quotes: [{ symbol: '005930', lastPrice: 72_000 }],
    });

    const { metrics } = await service.getMetrics([SAMSUNG]);
    expect(metrics[0]?.marketCap).toBe(360_000_000_000_000);
  });

  // 0 으로 채우면 "시가총액 0원인 종목" 이 되어 정렬 맨 끝에 조용히 박힌다
  it('발행주식수나 현재가가 없으면 시가총액은 null 이다', async () => {
    const { service } = build({
      stocks: [stock('005930', null), stock('000660', 700_000_000)],
      quotes: [{ symbol: '005930', lastPrice: 72_000 }],
    });

    const { metrics } = await service.getMetrics([SAMSUNG, HYNIX]);
    expect(metrics.map((metric) => metric.marketCap)).toEqual([null, null]);
  });

  it('거래대금·거래량 랭킹 두 축을 합쳐 넓게 덮는다', async () => {
    const { service, getRanking } = build({
      rankings: {
        TRADING_VALUE: [{ symbol: '005930', tradingValue: 1_000, tradingVolume: 10 }],
        TRADING_VOLUME: [{ symbol: '000660', tradingValue: 500, tradingVolume: 90 }],
      },
    });

    const { metrics } = await service.getMetrics([SAMSUNG, HYNIX]);
    expect(getRanking).toHaveBeenCalledTimes(2);
    expect(metrics[0]).toMatchObject({ tradingValue: 1_000, tradingVolume: 10 });
    // 거래대금 상위에 없어도 거래량 상위에 있으면 두 값을 모두 얻는다
    expect(metrics[1]).toMatchObject({ tradingValue: 500, tradingVolume: 90 });
  });

  // 랭킹은 시장 상위 100위까지다 — 밖의 종목을 0 으로 채우면 "거래 없음" 과 구분되지 않는다
  it('랭킹 밖 종목의 거래 지표는 null 이다', async () => {
    const { service } = build({
      rankings: { TRADING_VALUE: [{ symbol: '005930', tradingValue: 1_000, tradingVolume: 10 }] },
    });

    const { metrics } = await service.getMetrics([HYNIX]);
    expect(metrics[0]).toMatchObject({ tradingValue: null, tradingVolume: null });
  });

  it('시세를 TTL 동안 캐시해 목록을 다시 그려도 다시 묻지 않는다', async () => {
    const harness = build({ quotes: [{ symbol: '005930', lastPrice: 72_000 }] });

    await harness.service.getMetrics([SAMSUNG]);
    await harness.service.getMetrics([SAMSUNG]);
    expect(harness.getQuotes).toHaveBeenCalledTimes(1);

    harness.nowRef.now = 60_001;
    await harness.service.getMetrics([SAMSUNG]);
    expect(harness.getQuotes).toHaveBeenCalledTimes(2);
  });

  // 소스가 모르는 코드를 캐시하지 않으면 5초마다 갱신되는 목록이 매번 호출을 낸다
  it('시세를 못 받은 코드도 캐시한다', async () => {
    const harness = build({ quotes: [] });

    await harness.service.getMetrics([SAMSUNG]);
    await harness.service.getMetrics([SAMSUNG]);
    expect(harness.getQuotes).toHaveBeenCalledTimes(1);
  });

  it('한 소스가 실패해도 나머지 지표는 그대로 낸다', async () => {
    const { service } = build({
      stocks: [stock('005930', 5_000_000_000)],
      quotes: [{ symbol: '005930', lastPrice: 72_000 }],
    });
    // 랭킹만 죽은 상황
    const failing = new SymbolMetricsService(
      new SymbolInfoService(
        { getStockInfo: async () => ({ stocks: [stock('005930', 5_000_000_000)], failedSymbols: [] }) },
        { now: () => 0 },
        logger,
      ),
      { getQuotes: async () => [{ symbol: '005930', lastPrice: 72_000 }] },
      { getRanking: async () => Promise.reject(new Error('boom')) },
      { now: () => 0 },
      logger,
    );

    expect((await service.getMetrics([SAMSUNG])).metrics[0]?.marketCap).toBe(
      360_000_000_000_000,
    );
    const { metrics } = await failing.getMetrics([SAMSUNG]);
    expect(metrics[0]?.marketCap).toBe(360_000_000_000_000);
    expect(metrics[0]?.tradingValue).toBeNull();
  });

  it('자격 증명 미설정은 에러가 아니라 전부 null 이다', async () => {
    const notConfigured = () => Promise.reject(new MarketDataSourceNotConfiguredError());
    const service = new SymbolMetricsService(
      new SymbolInfoService({ getStockInfo: notConfigured }, { now: () => 0 }, logger),
      { getQuotes: notConfigured },
      { getRanking: notConfigured },
      { now: () => 0 },
      logger,
    );

    const { metrics } = await service.getMetrics([SAMSUNG]);
    expect(metrics).toEqual([
      { code: '005930', marketCap: null, tradingValue: null, tradingVolume: null },
    ]);
  });

  // 빈 결과를 1분 붙잡으면 일시 장애가 그 시간 내내 「집계 없음」으로 보인다
  it('랭킹을 한 축도 못 받으면 캐시하지 않고 다음 호출에 다시 시도한다', async () => {
    let failing = true;
    const getRanking = vi.fn(async () => {
      if (failing) throw new Error('boom');
      return [{ symbol: '005930', tradingValue: 1_000, tradingVolume: 10 }];
    });
    const service = new SymbolMetricsService(
      new SymbolInfoService(
        { getStockInfo: async () => ({ stocks: [], failedSymbols: [] }) },
        { now: () => 0 },
        logger,
      ),
      { getQuotes: async () => [] },
      { getRanking },
      { now: () => 0 },
      logger,
    );

    expect((await service.getMetrics([SAMSUNG])).metrics[0]?.tradingValue).toBeNull();
    failing = false;
    expect((await service.getMetrics([SAMSUNG])).metrics[0]?.tradingValue).toBe(1_000);
  });

  it('종목이 없으면 소스를 부르지 않는다', async () => {
    const harness = build();
    const { metrics } = await harness.service.getMetrics([]);
    expect(metrics).toEqual([]);
    expect(harness.getQuotes).not.toHaveBeenCalled();
    expect(harness.getRanking).not.toHaveBeenCalled();
  });
});
