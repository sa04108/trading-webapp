import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import type { Market } from '../domain/candle.js';
import {
  MarketDataSourceNotConfiguredError,
  type MarketRankingEntry,
  type MarketRankingMetric,
  type MarketRankingSource,
  type StockQuoteSource,
} from './ports.js';
import type { SymbolInfoService } from './symbol-info-service.js';

/** 정렬이 읽는 지표 한 벌. 모르는 값은 null 이다 — 0 이 아니다 */
export interface SymbolMetrics {
  readonly code: string;
  /** 시가총액 = 발행주식수 × 현재가 */
  readonly marketCap: number | null;
  /** 거래대금 (1거래일 누적) */
  readonly tradingValue: number | null;
  /** 거래량 (1거래일 누적) */
  readonly tradingVolume: number | null;
}

export interface SymbolMetricsResult {
  readonly metrics: SymbolMetrics[];
  /**
   * 거래대금·거래량이 **시장 상위 랭킹 밖 종목에는 없다** 는 사실을 화면이 말할 수 있게
   * 실어 보낸다. 그 자리에 빈 값만 그리면 사용자는 데이터가 깨진 것으로 읽는다.
   */
  readonly rankingLimit: number;
}

const PRICE_TTL_MS = 60_000; // 정렬 순서가 스크롤 도중 뒤집히지 않을 만큼은 붙잡는다
const RANKING_TTL_MS = 60_000;

interface CacheEntry<T> {
  readonly value: T;
  readonly cachedAtMs: number;
}

/**
 * 종목 정렬 지표 (설계 2026-08-01-symbol-sort-design.md).
 *
 * 소스가 **시가총액을 주지 않는다**. 발행주식수(`/stocks`)와 현재가(`/prices`)를 곱해
 * 만든다 — 둘 중 하나라도 없으면 null 이고, 그 종목은 정렬에서 뒤로 간다.
 *
 * 거래대금·거래량은 사정이 다르다. 소스는 **시장 전체 상위 100위 랭킹**만 제공하고
 * "이 200종목의 거래대금" 을 묻는 API 는 없다. 그래서 랭킹 밖 종목의 값은 모른다 —
 * 0 으로 채우지 않고 null 로 남겨 화면이 「집계 없음」이라고 말하게 한다. 0 으로 채우면
 * 거래가 없던 종목과 순위에 못 든 삼성전자가 같은 칸에 놓인다.
 *
 * 실패는 에러가 아니다. 자격 증명 미설정·조회 실패는 정렬을 못 하게 만들 뿐 종목 목록
 * 자체를 막아서는 안 된다 — `SymbolInfoService` 가 이름에 대해 하는 것과 같은 태도다.
 */
export class SymbolMetricsService {
  private readonly priceCache = new Map<string, CacheEntry<number | null>>();
  private readonly rankingCache = new Map<Market, CacheEntry<Map<string, MarketRankingEntry>>>();

  constructor(
    /** 발행주식수는 이름과 같은 응답에서 온다 — 24시간 캐시를 그대로 나눠 쓴다 */
    private readonly symbolInfo: SymbolInfoService,
    private readonly quoteSource: StockQuoteSource,
    private readonly rankingSource: MarketRankingSource,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly priceTtlMs: number = PRICE_TTL_MS,
    private readonly rankingTtlMs: number = RANKING_TTL_MS,
  ) {}

  /** 랭킹이 덮는 범위 — 화면이 「상위 N위 밖은 집계 없음」이라고 적을 근거다 */
  get rankingLimit(): number {
    return 100;
  }

  async getMetrics(
    symbols: readonly { readonly code: string; readonly market: Market }[],
  ): Promise<SymbolMetricsResult> {
    if (symbols.length === 0) return { metrics: [], rankingLimit: this.rankingLimit };

    // 셋을 독립적으로 받는다 — 랭킹이 실패해도 시가총액은 나와야 하고 그 반대도 같다
    const codes = symbols.map((symbol) => symbol.code);
    const [shares, prices, rankings] = await Promise.all([
      this.loadSharesOutstanding(codes),
      this.loadPrices(codes),
      this.loadRankings([...new Set(symbols.map((symbol) => symbol.market))]),
    ]);

    return {
      metrics: symbols.map((symbol) => {
        const shareCount = shares.get(symbol.code) ?? null;
        const price = prices.get(symbol.code) ?? null;
        const ranked = rankings.get(symbol.market)?.get(symbol.code);
        return {
          code: symbol.code,
          marketCap: shareCount !== null && price !== null ? shareCount * price : null,
          tradingValue: ranked?.tradingValue ?? null,
          tradingVolume: ranked?.tradingVolume ?? null,
        };
      }),
      rankingLimit: this.rankingLimit,
    };
  }

  private async loadSharesOutstanding(
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, number | null>> {
    try {
      const infos = await this.symbolInfo.lookup(codes);
      return new Map(infos.map((info) => [info.symbol, info.sharesOutstanding]));
    } catch (error) {
      this.warn('shares', error);
      return new Map();
    }
  }

  /**
   * 현재가. 캐시 미스만 묻고, 조회 실패한 심볼도 **null 로 캐시한다** — 그러지 않으면
   * 소스가 모르는 코드(상장폐지 등)를 5초마다 다시 물어 정렬할 때마다 호출이 나간다.
   */
  private async loadPrices(codes: readonly string[]): Promise<ReadonlyMap<string, number | null>> {
    const now = this.clock.now();
    const misses = codes.filter((code) => {
      const entry = this.priceCache.get(code);
      return !entry || entry.cachedAtMs + this.priceTtlMs <= now;
    });

    if (misses.length > 0) {
      try {
        const quotes = await this.quoteSource.getQuotes(misses);
        const byCode = new Map(quotes.map((quote) => [quote.symbol, quote.lastPrice]));
        for (const code of misses) {
          this.priceCache.set(code, { value: byCode.get(code) ?? null, cachedAtMs: now });
        }
      } catch (error) {
        // 미설정은 캐시하지 않는다 — 자격 증명을 넣은 뒤 바로 동작해야 한다
        if (!(error instanceof MarketDataSourceNotConfiguredError)) this.warn('prices', error);
      }
    }

    const result = new Map<string, number | null>();
    for (const code of codes) result.set(code, this.priceCache.get(code)?.value ?? null);
    return result;
  }

  /**
   * 시장별 랭킹. 거래대금 상위와 거래량 상위는 **서로 다른 100종목**이라 둘 다 받아
   * 합친다 — 한쪽만 받으면 거래량 상위에만 든 종목의 거래대금이 비어 정렬이 그 종목을
   * 근거 없이 뒤로 민다. 두 응답 모두 두 값을 함께 실어 준다.
   */
  private async loadRankings(
    markets: readonly Market[],
  ): Promise<ReadonlyMap<Market, ReadonlyMap<string, MarketRankingEntry>>> {
    const now = this.clock.now();
    const result = new Map<Market, ReadonlyMap<string, MarketRankingEntry>>();

    for (const market of markets) {
      const cached = this.rankingCache.get(market);
      if (cached && cached.cachedAtMs + this.rankingTtlMs > now) {
        result.set(market, cached.value);
        continue;
      }

      const metrics: MarketRankingMetric[] = ['TRADING_VALUE', 'TRADING_VOLUME'];
      const merged = new Map<string, MarketRankingEntry>();
      let anySucceeded = false;
      for (const metric of metrics) {
        try {
          for (const entry of await this.rankingSource.getRanking(market, metric)) {
            merged.set(entry.symbol, entry);
          }
          anySucceeded = true;
        } catch (error) {
          if (!(error instanceof MarketDataSourceNotConfiguredError)) this.warn('ranking', error);
        }
      }

      // 한 축도 못 받았으면 캐시하지 않는다 — 빈 결과를 1분 붙잡으면 일시 장애가
      // 그 시간 내내 「집계 없음」으로 보인다
      if (anySucceeded) this.rankingCache.set(market, { value: merged, cachedAtMs: now });
      result.set(market, merged);
    }

    return result;
  }

  private warn(stage: string, error: unknown): void {
    this.logger.warn(
      { module: 'market-data', event: 'symbol-metrics.failed', stage, err: error },
      'symbol metrics lookup failed — sorting falls back to name order',
    );
  }
}
