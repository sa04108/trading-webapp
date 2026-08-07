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
 * 증권사가 모르는(또는 조회에 실패한) 코드를 메우는 폴백 소스. 로컬 종목 마스터가
 * 채워 둔 이름을 쓴다 — 유니버스 미리보기 자동 등록이 이미 그 이름을 `symbols.name`
 * 에 심어 뒀는데 조회 경로가 그걸 안 보면, 멀쩡히 상장된 종목도 이름을 잃는다.
 */
export interface LocalSymbolNameSource {
  getLocalNames(codes: readonly string[]): ReadonlyMap<string, { name: string; market: string }>;
}

const NO_LOCAL_NAMES: LocalSymbolNameSource = { getLocalNames: () => new Map() };

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
    private readonly localNames: LocalSymbolNameSource = NO_LOCAL_NAMES,
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
        if (!(error instanceof MarketDataSourceNotConfiguredError)) {
          this.logger.warn(
            { module: 'market-data', event: 'symbol-info.lookup.failed', err: error },
            'stock info lookup failed — returning cached names only',
          );
        }
        // 미설정·조회 실패 모두 misses 는 캐시하지 않는다 — 재시도가 가능해야 한다.
        // 이번 호출에서 못 채운 이름은 아래 로컬 폴백이 메운다 — 여기서 바로 반환하지
        // 않고 공통 경로(withLocalFallback)로 흘려보내야, 예외가 나든 안 나든 폴백이
        // 똑같이 적용된다. 분기마다 따로 반환하면 한쪽에서 폴백 적용을 빠뜨리기 쉽다.
      }
    }

    return this.withLocalFallback(unique);
  }

  /**
   * 캐시(증권사 조회 결과)에 없는 코드를 로컬 종목 마스터의 이름·시장으로 메운다.
   * 폴백은 캐시 **뒤**에 온다 — 증권사가 실제로 아는 값은 그대로 쓰고, 모르거나
   * 조회에 실패한 코드만 로컬 값으로 채운다. status 등 증권사 전용 필드는 로컬에
   * 없으므로 빈 값으로 둔다 — 화면은 이름만 쓴다.
   */
  private withLocalFallback(symbols: readonly string[]): StockInfo[] {
    const result: StockInfo[] = [];
    const uncovered: string[] = [];
    for (const symbol of symbols) {
      const info = this.cache.get(symbol)?.info;
      if (info) {
        result.push(info);
      } else {
        uncovered.push(symbol);
      }
    }
    if (uncovered.length > 0) {
      const local = this.localNames.getLocalNames(uncovered);
      for (const symbol of uncovered) {
        const found = local.get(symbol);
        if (found) {
          result.push({
            symbol,
            name: found.name,
            englishName: null,
            market: found.market,
            status: '',
            sharesOutstanding: null,
          });
        }
      }
    }
    return result;
  }
}
