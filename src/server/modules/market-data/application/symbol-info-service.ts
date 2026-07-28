import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import { SYMBOL_PATTERN } from '../domain/candle.js';
import {
  MarketDataSourceNotConfiguredError,
  type StockInfo,
  type StockInfoSource,
} from './ports.js';

const DEFAULT_TTL_MS = 24 * 3600 * 1000; // 종목명은 사실상 불변 — 상장폐지 반영 정도면 충분

interface CacheEntry {
  readonly info: StockInfo | null; // null = 소스가 모르는 심볼 (negative cache)
  readonly cachedAtMs: number;
}

/**
 * 종목 코드 → 이름 조회 (설계 2026-07-28-broker-sync-design.md 후속).
 * 소스는 코드 → 이름만 제공한다(이름 검색 없음). UI 의 표시·입력 확인용이므로
 * 소스 미설정은 에러가 아니라 빈 결과다 — 코드만으로도 모든 기능이 동작해야 한다.
 */
export class SymbolInfoService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly source: StockInfoSource,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async lookup(symbols: readonly string[]): Promise<StockInfo[]> {
    const unique = [...new Set(symbols)];
    for (const symbol of unique) {
      if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`invalid symbol: ${symbol}`);
    }

    const now = this.clock.now();
    const misses = unique.filter((symbol) => {
      const entry = this.cache.get(symbol);
      return !entry || entry.cachedAtMs + this.ttlMs <= now;
    });

    if (misses.length > 0) {
      try {
        const fetched = await this.source.getStockInfo(misses);
        const bySymbol = new Map(fetched.map((info) => [info.symbol, info]));
        for (const symbol of misses) {
          this.cache.set(symbol, { info: bySymbol.get(symbol) ?? null, cachedAtMs: now });
        }
      } catch (error) {
        if (error instanceof MarketDataSourceNotConfiguredError) {
          // 미설정은 캐시하지 않는다 — 설정 후 재시도가 가능해야 한다
          return this.fromCache(unique);
        }
        this.logger.warn(
          { module: 'market-data', event: 'symbol-info.lookup.failed', err: error },
          'stock info lookup failed — returning cached names only',
        );
        return this.fromCache(unique);
      }
    }

    return this.fromCache(unique);
  }

  private fromCache(symbols: readonly string[]): StockInfo[] {
    const result: StockInfo[] = [];
    for (const symbol of symbols) {
      const info = this.cache.get(symbol)?.info;
      if (info) result.push(info);
    }
    return result;
  }
}
