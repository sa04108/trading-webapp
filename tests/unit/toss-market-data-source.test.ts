import { describe, expect, it, vi } from 'vitest';
import { createTossMarketDataSource } from '../../src/server/modules/broker/infrastructure/toss/toss-market-data-source.js';
import { StockInfoSourceNotConfiguredError } from '../../src/server/modules/market-data/application/ports.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';

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

describe('createTossMarketDataSource (스펙 §13 — 종목 이름 조회 전용)', () => {
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
    const { stocks, failedSymbols } = await buildSource(fetchImpl).getStockInfo([
      '005930',
      'AAPL',
    ]);

    const [stocksUrl] = fetchImpl.mock.calls[1] as [string];
    const url = new URL(stocksUrl);
    expect(url.pathname).toBe('/api/v1/stocks');
    expect(url.searchParams.get('symbols')).toBe('005930,AAPL');
    expect(failedSymbols).toEqual([]);
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
    const { stocks } = await buildSource(fetchImpl).getStockInfo(['005930', '000660']);
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

    const { stocks, failedSymbols } = await buildSource(fetchImpl).getStockInfo(symbols);

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
    // 실패한 청크(첫 200건)는 failedSymbols 로 보고된다 — 호출부가 이 코드들을
    // "모른다" 로 부정 캐시하지 않고 다음 조회에서 재시도하게 하기 위해서다.
    expect(failedSymbols).toEqual(symbols.slice(0, 200));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'toss.get-stock-info.chunk-failed' }),
      expect.any(String),
    );
    warn.mockRestore();
  });

  it('getStockInfo rejects when not configured and returns [] for empty input', async () => {
    const unconfigured = createTossMarketDataSource(null, logger);
    await expect(unconfigured.getStockInfo(['005930'])).rejects.toBeInstanceOf(
      StockInfoSourceNotConfiguredError,
    );

    const fetchImpl = vi.fn();
    const result = await buildSource(fetchImpl).getStockInfo([]);
    expect(result).toEqual({ stocks: [], failedSymbols: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
