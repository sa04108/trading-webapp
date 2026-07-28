import type { Logger } from '../../../../shared/logger.js';
import type { Timeframe } from '../../../market-data/domain/candle.js';
import type {
  FetchCandleRequest,
  FetchCandleResult,
  MarketDataSource,
} from '../../../market-data/application/ports.js';
import {
  MarketDataSourceNotConfiguredError,
  UnsupportedTimeframeError,
  type StockInfo,
  type StockInfoSource,
} from '../../../market-data/application/ports.js';
import { BrokerRestClient, type TokenProvider } from '../rest-client.js';

export { UnsupportedTimeframeError } from '../../../market-data/application/ports.js';

export interface TossConfig {
  readonly baseUrl: string; // https://openapi.tossinvest.com — 실전 환경만 제공 (모의 없음)
  readonly clientId: string;
  readonly clientSecret: string;
}

interface TossCandle {
  readonly timestamp: string; // ISO 8601 with offset
  readonly openPrice: string; // decimal string
  readonly highPrice: string;
  readonly lowPrice: string;
  readonly closePrice: string;
  readonly volume: string;
}

interface TossCandlePage {
  readonly result?: {
    readonly candles?: readonly TossCandle[];
    readonly nextBefore?: string | null;
  };
}

const INTERVAL_BY_TIMEFRAME: Partial<Record<Timeframe, '1m' | '1d'>> = {
  '1m': '1m',
  '1d': '1d',
};

const PAGE_SIZE = 200; // API 상한

function parseDecimal(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`toss candle 응답의 ${field} 가 숫자가 아닙니다: ${String(value)}`);
  }
  return parsed;
}

function parseTimestamp(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`toss candle 응답의 ${field} 가 ISO 8601 이 아닙니다: ${String(value)}`);
  }
  return parsed;
}

export interface TossSourceOptions {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * 토스증권 Open API 어댑터 (2차 증권사 어댑터, 스펙 §13).
 *
 * - 인증: POST /oauth2/token — OAuth2 client_credentials, form-urlencoded (키움과 달리 JSON 아님).
 *   재발급 시 이전 토큰이 즉시 무효화되므로 프로세스당 클라이언트 1개로 캐싱을 공유한다.
 * - 캔들: GET /api/v1/candles — interval 은 1m/1d 만 제공. 최신순 페이지(최대 200개)를
 *   before(inclusive) 커서로 과거 방향으로 넘긴다. fetchCandles 호출 1회 = 1페이지이며,
 *   hasMore 면 호출자가 toTsMs 를 반환된 가장 오래된 봉 직전으로 좁혀 이어받는다.
 * - Rate limit: MARKET_DATA 그룹 초당 10회 — 여유를 두고 150ms 간격.
 */
export function createTossMarketDataSource(
  config: TossConfig | null,
  logger: Logger,
  options: TossSourceOptions = {},
): MarketDataSource & StockInfoSource {
  if (!config) {
    return {
      fetchCandles(): Promise<FetchCandleResult> {
        return Promise.reject(new MarketDataSourceNotConfiguredError());
      },
      getStockInfo(): Promise<StockInfo[]> {
        return Promise.reject(new MarketDataSourceNotConfiguredError());
      },
    };
  }

  const tokenProvider: TokenProvider = {
    async issueToken(fetchImpl) {
      const response = await fetchImpl(`${config.baseUrl}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }).toString(),
      });
      if (!response.ok) {
        throw new Error(`toss token issue failed: ${response.status}`);
      }
      const body = (await response.json()) as { access_token?: string; expires_in?: number };
      if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
        throw new Error('toss token 응답에 access_token/expires_in 이 없습니다');
      }
      return {
        accessToken: body.access_token,
        expiresAtMs: Date.now() + body.expires_in * 1000,
      };
    },
  };

  const client = new BrokerRestClient({
    baseUrl: config.baseUrl,
    tokenProvider,
    logger,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    groupMinIntervalMs: { chart: 150, default: 150 },
  });

  return {
    async fetchCandles(request: FetchCandleRequest): Promise<FetchCandleResult> {
      const interval = INTERVAL_BY_TIMEFRAME[request.timeframe];
      if (!interval) {
        throw new UnsupportedTimeframeError(request.timeframe);
      }

      const query = new URLSearchParams({
        symbol: request.symbol,
        interval,
        count: String(PAGE_SIZE),
        // inclusive 커서 — Z(UTC) 표기로 보내 '+' 인코딩 실수 여지를 없앤다
        before: new Date(request.toTsMs).toISOString(),
      });
      const page = await client.request<TossCandlePage>('chart', `/api/v1/candles?${query}`);

      const rawCandles = page.result?.candles;
      if (!Array.isArray(rawCandles)) {
        throw new Error('toss candles 응답에 result.candles 가 없습니다');
      }

      const candles = rawCandles
        .map((raw) => ({
          symbol: request.symbol,
          market: request.market,
          timeframe: request.timeframe,
          tsMs: parseTimestamp(raw.timestamp, 'timestamp'),
          open: parseDecimal(raw.openPrice, 'openPrice'),
          high: parseDecimal(raw.highPrice, 'highPrice'),
          low: parseDecimal(raw.lowPrice, 'lowPrice'),
          close: parseDecimal(raw.closePrice, 'closePrice'),
          volume: parseDecimal(raw.volume, 'volume'),
        }))
        .filter((candle) => candle.tsMs >= request.fromTsMs && candle.tsMs <= request.toTsMs)
        .sort((a, b) => a.tsMs - b.tsMs);

      const droppedOlderThanFrom = candles.length < rawCandles.length;
      const nextBefore = page.result?.nextBefore ?? null;
      const hasMore =
        !droppedOlderThanFrom &&
        nextBefore !== null &&
        parseTimestamp(nextBefore, 'nextBefore') >= request.fromTsMs;

      return { candles, hasMore };
    },

    async getStockInfo(symbols: readonly string[]): Promise<StockInfo[]> {
      const stocks: StockInfo[] = [];
      // GET /api/v1/stocks 는 콤마 구분 최대 200건
      for (let offset = 0; offset < symbols.length; offset += 200) {
        const chunk = symbols.slice(offset, offset + 200);
        const query = new URLSearchParams({ symbols: chunk.join(',') });
        const page = await client.request<{ result?: readonly Record<string, unknown>[] }>(
          'stock',
          `/api/v1/stocks?${query}`,
        );
        if (!Array.isArray(page.result)) {
          throw new Error('toss stocks 응답에 result 배열이 없습니다');
        }
        for (const raw of page.result) {
          if (typeof raw.symbol !== 'string' || typeof raw.name !== 'string') {
            throw new Error('toss stocks 응답 항목에 symbol/name 이 없습니다');
          }
          stocks.push({
            symbol: raw.symbol,
            name: raw.name,
            englishName: typeof raw.englishName === 'string' ? raw.englishName : null,
            market: typeof raw.market === 'string' ? raw.market : '',
            status: typeof raw.status === 'string' ? raw.status : '',
          });
        }
      }
      return stocks;
    },
  };
}
