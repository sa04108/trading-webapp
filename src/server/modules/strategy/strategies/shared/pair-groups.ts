/**
 * 역상관 종목 그룹핑 — "같은 기초자산의 레버리지·인버스" 를 상품 메타데이터 없이
 * 가격 움직임만으로 찾는다. 그룹당 1종목 보유 제한의 근거가 되는 유일한 계산.
 *
 * 결정성: 심볼 사전순으로만 순회·병합한다 — 입력 Map 순서에 결과가 의존하면
 * 같은 요청을 두 번 돌려도 결과가 달라진다 (재현성, rank.ts 와 같은 원칙).
 */

/** 로그수익률. 0 이하 가격이 끼면 그 구간은 건너뛴다 — NaN 이 상관을 오염시키지 않게 */
function logReturns(closes: readonly number[]): number[] {
  const returns: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const prev = closes[index - 1] as number;
    const current = closes[index] as number;
    if (prev > 0 && current > 0) returns.push(Math.log(current / prev));
  }
  return returns;
}

/** 표본 < 2 또는 한쪽 분산 0 이면 null — 판정 불가를 0 상관으로 위장하지 않는다 */
export function pearsonCorrelation(
  a: readonly number[],
  b: readonly number[],
): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < n; index += 1) {
    meanA += (a[index] as number) / n;
    meanB += (b[index] as number) / n;
  }
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let index = 0; index < n; index += 1) {
    const da = (a[index] as number) - meanA;
    const db = (b[index] as number) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

/**
 * 로그수익률 상관 ≤ −threshold 인 쌍을 전이적으로 병합해 심볼 → 그룹 id 를 반환.
 * 그룹 id 는 그룹 내 사전순 최소 심볼 — 실행마다 같은 이름이 나온다.
 */
export function buildCorrelationGroups(
  closesBySymbol: ReadonlyMap<string, readonly number[]>,
  threshold: number,
): Map<string, string> {
  const symbols = [...closesBySymbol.keys()].sort();
  const returns = new Map(
    symbols.map((symbol) => [symbol, logReturns(closesBySymbol.get(symbol) ?? [])]),
  );

  const parent = new Map<string, string>(symbols.map((symbol) => [symbol, symbol]));
  const find = (symbol: string): string => {
    let root = symbol;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // 사전순 작은 쪽이 루트 — 그룹 id 가 입력 순서와 무관해진다
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  };

  for (let i = 0; i < symbols.length; i += 1) {
    for (let j = i + 1; j < symbols.length; j += 1) {
      const correlation = pearsonCorrelation(
        returns.get(symbols[i] as string) ?? [],
        returns.get(symbols[j] as string) ?? [],
      );
      if (correlation !== null && correlation <= -threshold) {
        union(symbols[i] as string, symbols[j] as string);
      }
    }
  }

  return new Map(symbols.map((symbol) => [symbol, find(symbol)]));
}
