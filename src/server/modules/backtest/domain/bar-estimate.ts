/**
 * 백테스트가 메모리에 올릴 봉 수 상한 (설계 2026-07-29-backtest-timeframe-design.md).
 * 실행부는 기간 내 전체 봉을 배열로 올린다 — 1m 소비를 열면서 OOM 을 막는 밸브다.
 * 2M 봉 ≈ 수백 MB JS 힙. 초과는 다운샘플 없이 명시적으로 거부한다.
 */
export const MAX_BACKTEST_BARS = 2_000_000;

export interface CoverageSpan {
  readonly symbol: string;
  readonly firstTsMs: number | null;
  readonly lastTsMs: number | null;
  readonly barCount: number;
}

/**
 * coverage 메타데이터만으로 소비 봉 수를 추정한다 (Parquet 을 읽지 않는다 — D-025).
 * 봉이 커버리지 구간에 고르게 있다고 가정한 선형 추정 + 배율(1h coverage 로 1m 소비를
 * 추정할 때 60). 상한 검사용이므로 과대추정이 안전한 방향이다.
 */
export function estimateBars(
  coverage: readonly CoverageSpan[],
  symbols: readonly string[],
  fromTsMs: number,
  toTsMs: number,
  multiplier: number,
): number {
  const bySymbol = new Map(coverage.map((row) => [row.symbol, row]));
  let total = 0;
  for (const symbol of symbols) {
    const row = bySymbol.get(symbol);
    if (!row || row.barCount === 0 || row.firstTsMs === null || row.lastTsMs === null) continue;
    const overlap = Math.min(row.lastTsMs, toTsMs) - Math.max(row.firstTsMs, fromTsMs);
    if (overlap < 0) continue;
    const span = row.lastTsMs - row.firstTsMs;
    const fraction = span <= 0 ? 1 : Math.min(1, overlap / span);
    total += Math.ceil(row.barCount * fraction * multiplier);
  }
  return total;
}
