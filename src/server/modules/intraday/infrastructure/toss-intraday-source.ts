import {
  intradayBarSchema,
  intradaySymbolSchema,
  MINUTE_MS,
  type IntradayBar,
} from "../../../../shared/schemas/intraday.js";
import type { TossClient } from "../../broker/infrastructure/toss/toss-client.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("토스 분봉 응답이 올바르지 않습니다");
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\.0+)?$/.test(value))
    throw new Error("토스 분봉 숫자가 올바르지 않습니다");
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("토스 분봉 숫자 범위가 올바르지 않습니다");
  return result;
}

export class TossIntradaySource {
  constructor(
    private readonly client: Pick<TossClient, "request">,
    private readonly now: () => number = Date.now,
  ) {}

  async fetch(
    symbol: string,
    fromMs: number,
    toMs: number,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: {
        pages: number;
        fetchedBars: number;
        oldestEndMs: number | null;
      }) => void;
    } = {},
  ): Promise<IntradayBar[]> {
    intradaySymbolSchema.parse(symbol);
    if (
      !Number.isSafeInteger(fromMs) ||
      !Number.isSafeInteger(toMs) ||
      fromMs > toMs
    )
      throw new Error("분봉 조회 범위가 올바르지 않습니다");
    const upper = Math.min(toMs, this.now() - MINUTE_MS);
    if (upper < fromMs) return [];
    let before = new Date(upper).toISOString();
    const seen = new Set<string>();
    const bars = new Map<number, IntradayBar>();
    let previousOldest = Infinity;
    for (let page = 0; page < 2500; page++) {
      options.signal?.throwIfAborted();
      const query = new URLSearchParams({
        symbol,
        interval: "1m",
        count: "200",
        adjusted: "false",
        before,
      });
      const response = object(
        await this.client.request(
          `/api/v1/candles?${query}`,
          { signal: options.signal },
        ),
      );
      options.signal?.throwIfAborted();
      const data = object(response.result);
      if (
        !Array.isArray(data.candles) ||
        !(
          data.nextBefore === undefined ||
          data.nextBefore === null ||
          typeof data.nextBefore === "string"
        )
      )
        throw new Error("토스 분봉 페이지가 올바르지 않습니다");
      let oldest = Infinity;
      let prior = Infinity;
      for (const value of data.candles) {
        const row = object(value);
        if (
          typeof row.timestamp !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            row.timestamp,
          ) ||
          row.currency !== "KRW"
        )
          throw new Error("토스 분봉 시각 또는 통화가 올바르지 않습니다");
        const endMs = Date.parse(row.timestamp);
        if (
          !Number.isSafeInteger(endMs) ||
          endMs > prior ||
          endMs > Date.parse(before)
        )
          throw new Error("토스 분봉 순서가 올바르지 않습니다");
        prior = endMs;
        oldest = Math.min(oldest, endMs);
        const bar = intradayBarSchema.parse({
          endMs,
          open: number(row.openPrice),
          high: number(row.highPrice),
          low: number(row.lowPrice),
          close: number(row.closePrice),
          volume: number(row.volume),
        });
        if (endMs >= fromMs && endMs <= upper) {
          const previous = bars.get(endMs);
          if (previous && JSON.stringify(previous) !== JSON.stringify(bar))
            throw new Error("중복 분봉이 서로 다릅니다");
          bars.set(endMs, bar);
        }
      }
      options.onProgress?.({
        pages: page + 1,
        fetchedBars: bars.size,
        oldestEndMs: Number.isFinite(oldest) ? oldest : null,
      });
      if (oldest <= fromMs || data.nextBefore == null)
        return [...bars.values()].sort((a, b) => a.endMs - b.endMs);
      if (
        !data.candles.length ||
        oldest >= previousOldest ||
        !data.nextBefore ||
        !Number.isFinite(Date.parse(data.nextBefore)) ||
        Date.parse(data.nextBefore) > oldest ||
        seen.has(data.nextBefore)
      )
        throw new Error("토스 분봉 페이지가 진행되지 않습니다");
      previousOldest = oldest;
      seen.add(data.nextBefore);
      before = data.nextBefore;
    }
    throw new Error("토스 분봉 조회 페이지 한도를 초과했습니다");
  }
}
