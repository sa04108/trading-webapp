/**
 * 봉 수 상한의 실제 정의는 src/server/shared/backtest-limits.ts 에 있다 —
 * market-data 모듈(분봉 백필 사전 계획)도 같은 상한을 참조해야 해서, backtest 의
 * domain 에 두면 market-data → backtest 의존이 생겨 §7 의존 방향이 깨진다.
 * 여기서는 기존 import 경로(`bar-estimate.js` 에서 MAX_BACKTEST_BARS 를 가져오던
 * 코드)를 깨지 않기 위해 그대로 re-export 한다.
 */
export { MAX_BACKTEST_BARS } from '../../../shared/backtest-limits.js';

export interface CoverageSpan {
  readonly symbol: string;
  readonly firstTsMs: number | null;
  readonly lastTsMs: number | null;
  readonly barCount: number;
}

/**
 * coverage 메타데이터만으로 소비 봉 수를 추정한다 (Parquet 을 읽지 않는다 — D-025).
 * 봉이 커버리지 구간에 고르게 있다고 가정한 선형 추정이다. 상한 검사용이므로
 * 과대추정이 안전한 방향이다.
 */
export function estimateBars(
  coverage: readonly CoverageSpan[],
  symbols: readonly string[],
  fromTsMs: number,
  toTsMs: number,
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
    total += Math.ceil(row.barCount * fraction);
  }
  return total;
}
