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
});
