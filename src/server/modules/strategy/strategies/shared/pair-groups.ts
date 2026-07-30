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

/**
 * 워밍업 누적 상태 — 종가를 **봉 시각으로** 들고 있는다.
 *
 * 배열 인덱스로 누적하면 안 된다: 종목마다 봉이 있는 시점이 다르면(중간 상장,
 * 거래정지 — 엔진은 정상 입력으로 취급한다) 인덱스가 어긋나 서로 다른 날의
 * 수익률을 비교하게 된다. 한 봉만 밀려도 완전 역상관(−1)이 ≈+1 로 뒤집혀
 * 레버리지·인버스가 병합되지 않고 양쪽을 동시에 보유한다 — 조용히.
 */
export interface CorrelationWarmup {
  /** 심볼 → (봉 시각 → 종가) */
  readonly closesBySymbol: Map<string, Map<number, number>>;
}

export function newCorrelationWarmup(): CorrelationWarmup {
  return { closesBySymbol: new Map() };
}

export function recordClose(
  warmup: CorrelationWarmup,
  symbol: string,
  tsMs: number,
  close: number,
): void {
  let closes = warmup.closesBySymbol.get(symbol);
  if (!closes) {
    closes = new Map();
    warmup.closesBySymbol.set(symbol, closes);
  }
  closes.set(tsMs, close);
}

/**
 * 유니버스 **전 종목에 공통으로 존재하는** 봉 시각이 correlationBars 개 이상
 * 쌓였으면 그 시각들(가장 최근 correlationBars 개, 오름차순)만으로 상관 그룹을
 * 만든다. 아직이면 null — 호출자가 다음 봉에 다시 시도한다.
 *
 * 봉이 아예 없는 종목이 유니버스에 있으면 공통 시각이 영영 쌓이지 않아 그룹이
 * 확정되지 않는다. 그러면 진입이 영영 없고 경고도 나오지 않는다 (전략에는 경고
 * 채널이 없다 — 거래 0건으로 끝난다). 봉 없는 종목을 유니버스에 넣지 말라는 뜻이다.
 */
export function tryBuildGroups(
  warmup: CorrelationWarmup,
  symbols: readonly string[],
  correlationBars: number,
  threshold: number,
): Map<string, string> | null {
  const perSymbol: Map<number, number>[] = [];
  for (const symbol of symbols) {
    const closes = warmup.closesBySymbol.get(symbol);
    if (!closes) return null;
    perSymbol.push(closes);
  }

  const first = perSymbol[0];
  if (first === undefined) return new Map();

  const aligned: number[] = [];
  for (const tsMs of first.keys()) {
    if (perSymbol.every((closes) => closes.has(tsMs))) aligned.push(tsMs);
  }
  if (aligned.length < correlationBars) return null;

  aligned.sort((a, b) => a - b);
  const window = aligned.slice(-correlationBars);
  const closesBySymbol = new Map<string, readonly number[]>(
    symbols.map((symbol, index) => [
      symbol,
      window.map((tsMs) => (perSymbol[index] as Map<number, number>).get(tsMs) as number),
    ]),
  );
  return buildCorrelationGroups(closesBySymbol, threshold);
}
