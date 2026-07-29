export interface Scored {
  readonly symbol: string;
  readonly score: number;
}

/**
 * 큰 값이 1위. 동점은 심볼 코드 오름차순으로 깬다 — 순위가 입력 순서에 의존하면
 * 같은 요청을 두 번 돌려도 결과가 달라진다 (재현성, 스펙 §9.5).
 */
export function rankDescending(items: readonly Scored[]): Map<string, number> {
  const sorted = [...items].sort((a, b) =>
    a.score === b.score ? (a.symbol < b.symbol ? -1 : 1) : b.score - a.score,
  );
  const ranks = new Map<string, number>();
  sorted.forEach((item, index) => ranks.set(item.symbol, index + 1));
  return ranks;
}
