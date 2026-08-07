import { describe, expect, it, vi } from 'vitest';
import {
  createTossMarketDataSource,
  UnsupportedTimeframeError,
} from '../../src/server/modules/broker/infrastructure/toss/toss-market-data-source.js';
import { BrokerNotConfiguredError } from '../../src/server/modules/broker/infrastructure/errors.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';
import type { FetchCandleRequest } from '../../src/server/modules/market-data/application/ports.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));

const CONFIG = {
  baseUrl: 'https://openapi.toss.test',
  clientId: 'c_test',
  clientSecret: 's_test',
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN_RESPONSE = {
  access_token: 'toss-token-1',
  token_type: 'Bearer',
  expires_in: 86400,
};

/** 2026-03-25 09:31/09:32 KST 1분봉 2개 (API 는 최신순으로 반환) */
const CANDLE_PAGE = {
  result: {
    candles: [
      {
        timestamp: '2026-03-25T09:32:00+09:00',
        openPrice: '72000',
        highPrice: '72100',
        lowPrice: '71950',
        closePrice: '72050',
        volume: '15200',
        currency: 'KRW',
      },
      {
        timestamp: '2026-03-25T09:31:00+09:00',
        openPrice: '71950',
        highPrice: '72050',
        lowPrice: '71900',
        closePrice: '72000',
        volume: '18400',
        currency: 'KRW',
      },
    ],
    nextBefore: '2026-03-25T09:31:00+09:00',
  },
};

const KST_0931_MS = Date.parse('2026-03-25T09:31:00+09:00');
const KST_0932_MS = Date.parse('2026-03-25T09:32:00+09:00');

const REQUEST: FetchCandleRequest = {
  market: 'KR',
  timeframe: '1m',
  symbol: '005930',
  fromTsMs: Date.parse('2026-03-25T09:00:00+09:00'),
  toTsMs: KST_0932_MS,
};

/** 첫 호출(토큰 발급)과 이후 호출(API)을 순서대로 응답하는 fetch mock */
function buildFetch(responses: Response[]) {
  const fetchImpl = vi.fn();
  fetchImpl.mockResolvedValueOnce(jsonResponse(200, TOKEN_RESPONSE));
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response);
  return fetchImpl;
}

function buildSource(fetchImpl: ReturnType<typeof vi.fn>) {
  return createTossMarketDataSource(CONFIG, logger, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => {},
  });
}

describe('createTossMarketDataSource (스펙 §13 — 2차 어댑터)', () => {
  it('rejects with BrokerNotConfiguredError when config is null', async () => {
    const source = createTossMarketDataSource(null, logger);
    await expect(source.fetchCandles(REQUEST)).rejects.toBeInstanceOf(BrokerNotConfiguredError);
  });

  it('issues an OAuth2 token as form-urlencoded client_credentials', async () => {
    const fetchImpl = buildFetch([jsonResponse(200, CANDLE_PAGE)]);
    await buildSource(fetchImpl).fetchCandles(REQUEST);

    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe('https://openapi.toss.test/oauth2/token');
    expect(tokenInit.method).toBe('POST');
    expect((tokenInit.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const params = new URLSearchParams(tokenInit.body as string);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_id')).toBe('c_test');
    expect(params.get('client_secret')).toBe('s_test');

    const [, candleInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect((candleInit.headers as Record<string, string>).authorization).toBe(
      'Bearer toss-token-1',
    );
  });

  it('requests /api/v1/candles with symbol, interval, count and URL-encoded before cursor', async () => {
    const fetchImpl = buildFetch([jsonResponse(200, CANDLE_PAGE)]);
    await buildSource(fetchImpl).fetchCandles(REQUEST);

    const [candleUrl] = fetchImpl.mock.calls[1] as [string];
    const url = new URL(candleUrl);
    expect(url.pathname).toBe('/api/v1/candles');
    expect(url.searchParams.get('symbol')).toBe('005930');
    expect(url.searchParams.get('interval')).toBe('1m');
    expect(url.searchParams.get('count')).toBe('200');
    // before 는 toTsMs 를 ISO 8601 UTC 로 — '+' 없는 Z 표기라 인코딩 문제를 피한다
    expect(url.searchParams.get('before')).toBe(new Date(KST_0932_MS).toISOString());
  });

  it('maps decimal-string candles to domain candles in ascending time order', async () => {
    const fetchImpl = buildFetch([jsonResponse(200, CANDLE_PAGE)]);
    const result = await buildSource(fetchImpl).fetchCandles(REQUEST);

    expect(result.candles).toHaveLength(2);
    const [first, second] = result.candles;
    expect(first).toEqual({
      symbol: '005930',
      market: 'KR',
      timeframe: '1m',
      tsMs: KST_0931_MS,
      open: 71950,
      high: 72050,
      low: 71900,
      close: 72000,
      volume: 18400,
    });
    expect(second?.tsMs).toBe(KST_0932_MS);
  });

  it('maps interval to 1d for daily requests', async () => {
    const fetchImpl = buildFetch([jsonResponse(200, { result: { candles: [], nextBefore: null } })]);
    await buildSource(fetchImpl).fetchCandles({ ...REQUEST, timeframe: '1d' });

    const [candleUrl] = fetchImpl.mock.calls[1] as [string];
    expect(new URL(candleUrl).searchParams.get('interval')).toBe('1d');
  });

  it('rejects 1h requests without calling the API (시간봉은 1분봉 집계로 생성, 스펙 §13)', async () => {
    const fetchImpl = vi.fn();
    const source = buildSource(fetchImpl);
    await expect(source.fetchCandles({ ...REQUEST, timeframe: '1h' })).rejects.toBeInstanceOf(
      UnsupportedTimeframeError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports hasMore=true when nextBefore is still inside the requested range', async () => {
    const fetchImpl = buildFetch([jsonResponse(200, CANDLE_PAGE)]);
    const result = await buildSource(fetchImpl).fetchCandles(REQUEST);
    // nextBefore(09:31 KST) >= fromTsMs(09:00 KST) → 더 과거 데이터가 남아 있다
    expect(result.hasMore).toBe(true);
  });

  it('reports hasMore=false on the last page (nextBefore null)', async () => {
    const page = { result: { candles: CANDLE_PAGE.result.candles, nextBefore: null } };
    const fetchImpl = buildFetch([jsonResponse(200, page)]);
    const result = await buildSource(fetchImpl).fetchCandles(REQUEST);
    expect(result.hasMore).toBe(false);
  });

  it('drops candles older than fromTsMs and reports hasMore=false', async () => {
    const fetchImpl = buildFetch([jsonResponse(200, CANDLE_PAGE)]);
    const result = await buildSource(fetchImpl).fetchCandles({
      ...REQUEST,
      fromTsMs: KST_0932_MS, // 09:31 봉은 범위 밖
    });
    expect(result.candles.map((c) => c.tsMs)).toEqual([KST_0932_MS]);
    expect(result.hasMore).toBe(false);
  });

  it('rejects non-numeric price payloads instead of ingesting NaN (조용한 오데이터 차단)', async () => {
    const page = {
      result: {
        candles: [{ ...CANDLE_PAGE.result.candles[0], closePrice: 'not-a-number' }],
        nextBefore: null,
      },
    };
    const fetchImpl = buildFetch([jsonResponse(200, page)]);
    await expect(buildSource(fetchImpl).fetchCandles(REQUEST)).rejects.toThrow(/closePrice/);
  });

  it('rejects malformed envelopes (result.candles 누락)', async () => {
    const fetchImpl = buildFetch([jsonResponse(200, { result: {} })]);
    await expect(buildSource(fetchImpl).fetchCandles(REQUEST)).rejects.toThrow(/candles/);
  });

  it('fetches stock names and shares outstanding in one batched call (getStockInfo)', async () => {
    const fetchImpl = buildFetch([
      jsonResponse(200, {
        result: [
          {
            symbol: '005930',
            name: '삼성전자',
            englishName: 'SamsungElec',
            market: 'KOSPI',
            status: 'ACTIVE',
            sharesOutstanding: '5919637922',
          },
          {
            symbol: 'AAPL',
            name: '애플',
            englishName: 'APPLE INC',
            market: 'NASDAQ',
            status: 'ACTIVE',
            sharesOutstanding: '14702703000',
          },
        ],
      }),
    ]);
    const stocks = await buildSource(fetchImpl).getStockInfo(['005930', 'AAPL']);

    const [stocksUrl] = fetchImpl.mock.calls[1] as [string];
    const url = new URL(stocksUrl);
    expect(url.pathname).toBe('/api/v1/stocks');
    expect(url.searchParams.get('symbols')).toBe('005930,AAPL');
    expect(stocks).toEqual([
      {
        symbol: '005930',
        name: '삼성전자',
        englishName: 'SamsungElec',
        market: 'KOSPI',
        status: 'ACTIVE',
        sharesOutstanding: 5_919_637_922,
      },
      {
        symbol: 'AAPL',
        name: '애플',
        englishName: 'APPLE INC',
        market: 'NASDAQ',
        status: 'ACTIVE',
        sharesOutstanding: 14_702_703_000,
      },
    ]);
  });

  // 발행주식수가 없다고 종목명까지 버릴 이유는 없다 — 시가총액만 못 만든다
  it('keeps the row when sharesOutstanding is missing or unparsable', async () => {
    const fetchImpl = buildFetch([
      jsonResponse(200, {
        result: [
          { symbol: '005930', name: '삼성전자', market: 'KOSPI', status: 'ACTIVE' },
          { symbol: '000660', name: 'SK하이닉스', status: 'ACTIVE', sharesOutstanding: '없음' },
        ],
      }),
    ]);
    const stocks = await buildSource(fetchImpl).getStockInfo(['005930', '000660']);
    expect(stocks.map((stock) => stock.sharesOutstanding)).toEqual([null, null]);
    expect(stocks.map((stock) => stock.name)).toEqual(['삼성전자', 'SK하이닉스']);
  });

  // 원인 2: 청크(최대 200건) 하나가 상장폐지 코드 등으로 실패해도, 같은 요청의 다른
  // 청크는 그대로 살아야 한다. 이름을 못 받은 청크는 SymbolInfoService 의 로컬 폴백이 메운다.
  it('isolates a failed chunk instead of discarding the whole batch (청크 격리)', async () => {
    const symbols = Array.from({ length: 201 }, (_, index) => String(index).padStart(6, '0'));
    const fetchImpl = buildFetch([
      jsonResponse(404, { error: '상장폐지 코드가 섞여 있음' }), // 첫 청크(200건) 실패
      jsonResponse(200, {
        result: [{ symbol: symbols[200], name: '마지막종목', market: 'KOSPI', status: 'ACTIVE' }],
      }), // 두 번째 청크(1건)는 정상
    ]);
    const warn = vi.spyOn(logger, 'warn');

    const stocks = await buildSource(fetchImpl).getStockInfo(symbols);

    expect(stocks).toEqual([
      {
        symbol: symbols[200],
        name: '마지막종목',
        englishName: null,
        market: 'KOSPI',
        status: 'ACTIVE',
        sharesOutstanding: null,
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'toss.get-stock-info.chunk-failed' }),
      expect.any(String),
    );
    warn.mockRestore();
  });

  it('getStockInfo rejects when not configured and returns [] for empty input', async () => {
    const unconfigured = createTossMarketDataSource(null, logger);
    await expect(unconfigured.getStockInfo(['005930'])).rejects.toBeInstanceOf(
      BrokerNotConfiguredError,
    );

    const fetchImpl = vi.fn();
    const stocks = await buildSource(fetchImpl).getStockInfo([]);
    expect(stocks).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches current prices in batches of 200 (getQuotes)', async () => {
    const symbols = Array.from({ length: 201 }, (_, index) =>
      String(index).padStart(6, '0'),
    );
    const fetchImpl = buildFetch([
      jsonResponse(200, {
        result: symbols.slice(0, 200).map((symbol) => ({ symbol, lastPrice: '1000' })),
      }),
      jsonResponse(200, { result: [{ symbol: symbols[200], lastPrice: '2000' }] }),
    ]);
    const quotes = await buildSource(fetchImpl).getQuotes(symbols);

    const [firstUrl] = fetchImpl.mock.calls[1] as [string];
    expect(new URL(firstUrl).pathname).toBe('/api/v1/prices');
    expect(new URL(firstUrl).searchParams.get('symbols')?.split(',')).toHaveLength(200);
    expect(quotes).toHaveLength(201);
    expect(quotes.at(-1)).toEqual({ symbol: symbols[200], lastPrice: 2000 });
  });

  // 시세를 못 읽은 종목을 0 으로 채우면 시가총액 0원이 되어 정렬 맨 끝에 조용히 박힌다
  it('drops quotes without a parsable lastPrice instead of zero-filling', async () => {
    const fetchImpl = buildFetch([
      jsonResponse(200, {
        result: [
          { symbol: '005930', lastPrice: '72000' },
          { symbol: '000660', lastPrice: null },
          { symbol: '035720' },
        ],
      }),
    ]);
    const quotes = await buildSource(fetchImpl).getQuotes(['005930', '000660', '035720']);
    expect(quotes).toEqual([{ symbol: '005930', lastPrice: 72000 }]);
  });

  it('maps ranking metrics onto the API type parameter (getRanking)', async () => {
    const fetchImpl = buildFetch([
      jsonResponse(200, {
        result: {
          rankedAt: '2026-06-10T14:30:00+09:00',
          rankings: [
            {
              rank: 1,
              symbol: '005930',
              price: { lastPrice: '56500' },
              tradingVolume: '18432100',
              tradingAmount: '1041436650000',
            },
          ],
        },
      }),
    ]);
    const entries = await buildSource(fetchImpl).getRanking('KR', 'TRADING_VALUE');

    const [rankingUrl] = fetchImpl.mock.calls[1] as [string];
    const url = new URL(rankingUrl);
    expect(url.pathname).toBe('/api/v1/rankings');
    expect(url.searchParams.get('type')).toBe('MARKET_TRADING_AMOUNT');
    expect(url.searchParams.get('marketCountry')).toBe('KR');
    expect(url.searchParams.get('duration')).toBe('1d');
    expect(entries).toEqual([
      { symbol: '005930', tradingValue: 1_041_436_650_000, tradingVolume: 18_432_100 },
    ]);
  });

  it('getRanking asks for the volume ranking when the metric is TRADING_VOLUME', async () => {
    const fetchImpl = buildFetch([
      jsonResponse(200, { result: { rankedAt: null, rankings: [] } }),
    ]);
    const entries = await buildSource(fetchImpl).getRanking('US', 'TRADING_VOLUME');

    const [rankingUrl] = fetchImpl.mock.calls[1] as [string];
    expect(new URL(rankingUrl).searchParams.get('type')).toBe('MARKET_TRADING_VOLUME');
    expect(new URL(rankingUrl).searchParams.get('marketCountry')).toBe('US');
    // 집계가 없는 조합은 에러가 아니라 빈 배열이다 (API 계약)
    expect(entries).toEqual([]);
  });

  it('rejects malformed ranking envelopes (result.rankings 누락)', async () => {
    const fetchImpl = buildFetch([jsonResponse(200, { result: {} })]);
    await expect(buildSource(fetchImpl).getRanking('KR', 'TRADING_VALUE')).rejects.toThrow(
      /rankings/,
    );
  });
});
