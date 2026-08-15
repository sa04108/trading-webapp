import { shuffleInPlace, type Rng } from '../../../backtest/domain/seeded-rng.js';

export interface Scored {
  readonly symbol: string;
  readonly score: number;
}

/**
 * 큰 값이 1위. RNG를 받으면 동점 묶음만 seeded shuffle하고, 없으면 공용
 * 헬퍼의 기본값으로 심볼 코드 오름차순을 쓴다. 어느 경우든 입력 순서에는
 * 의존하지 않으며, 등록 전략은 context.rng를 넘겨 seed별 동점 실험을 가능하게 한다.
 */
export function rankDescending(items: readonly Scored[], rng?: Rng): Map<string, number> {
  const sorted = [...items].sort((a, b) =>
    a.score === b.score ? (a.symbol < b.symbol ? -1 : 1) : b.score - a.score,
  );
  if (rng !== undefined) {
    for (let start = 0; start < sorted.length;) {
      let end = start + 1;
      while (end < sorted.length && sorted[end]?.score === sorted[start]?.score) end += 1;
      if (end - start > 1) {
        const tied = sorted.slice(start, end);
        shuffleInPlace(tied, rng);
        sorted.splice(start, tied.length, ...tied);
      }
      start = end;
    }
  }
  const ranks = new Map<string, number>();
  sorted.forEach((item, index) => ranks.set(item.symbol, index + 1));
  return ranks;
}
