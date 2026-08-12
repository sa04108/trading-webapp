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

  return buildGroups(symbols, (left, right) => {
    const correlation = pearsonCorrelation(
      returns.get(left) ?? [],
      returns.get(right) ?? [],
    );
    return correlation !== null && correlation <= -threshold;
  });
}

function buildGroups(
  symbols: readonly string[],
  shouldMerge: (left: string, right: string) => boolean,
): Map<string, string> {
  const sorted = [...symbols].sort();

  const parent = new Map<string, string>(sorted.map((symbol) => [symbol, symbol]));
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

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const left = sorted[i] as string;
      const right = sorted[j] as string;
      if (shouldMerge(left, right)) union(left, right);
    }
  }

  return new Map(sorted.map((symbol) => [symbol, find(symbol)]));
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
 * 한 종목의 누적 종가를 자본변동 비율만큼 모두 내린다.
 *
 * 여기 쌓인 값은 전부 가격이고, `buildCorrelationGroups` 는 이 값의 로그수익률을 본다.
 * 내리지 않으면 분할 봉 하나가 −80% 짜리 수익률로 창에 남는다.
 * 그 한 점이 상관계수를 통째로 끌고 가 역상관 짝이 갈리거나 없던 짝이 묶인다.
 * 그러면 같은 묶음에서 한 종목만 보유한다는 규칙 자체가 엉뚱한 짝에 걸린다.
 *
 * 다른 종목의 종가는 건드리지 않는다 — 분할은 그 종목 하나의 사건이다.
 */
export function scaleWarmupCloses(
  warmup: CorrelationWarmup,
  symbol: string,
  ratio: number,
): void {
  const closes = warmup.closesBySymbol.get(symbol);
  if (!closes) return;
  for (const [tsMs, close] of closes) closes.set(tsMs, close / ratio);
}

/** 동적 유니버스 재계산용 종가를 종목별 최근 N개로 제한한다. */
export function pruneWarmupCloses(
  warmup: CorrelationWarmup,
  maxEntriesPerSymbol: number,
): void {
  const limit = Math.max(0, Math.floor(maxEntriesPerSymbol));
  for (const closes of warmup.closesBySymbol.values()) {
    const excess = closes.size - limit;
    if (excess <= 0) continue;
    const oldest = [...closes.keys()].sort((a, b) => a - b).slice(0, excess);
    for (const tsMs of oldest) closes.delete(tsMs);
  }
}

/**
 * 어느 한 종목이라도 correlationBars 개를 확보하면 초기 그룹을 만든다. 상관은
 * 종목 pair마다 둘에 공통인 최근 시각만 맞춰 계산한다. 공통 봉이 부족한 pair는
 * 판정하지 않아 각각 단독 그룹으로 남긴다 — 짧은 이력 종목 하나가 유니버스 전체의
 * 진입을 막지 않게 하려는 것이다.
 */
export function tryBuildGroups(
  warmup: CorrelationWarmup,
  symbols: readonly string[],
  correlationBars: number,
  threshold: number,
): Map<string, string> | null {
  if (symbols.length === 0) return new Map();
  const ready = symbols.some(
    (symbol) => (warmup.closesBySymbol.get(symbol)?.size ?? 0) >= correlationBars,
  );
  if (!ready) return null;

  return buildGroups(symbols, (leftSymbol, rightSymbol) => {
    const left = warmup.closesBySymbol.get(leftSymbol);
    const right = warmup.closesBySymbol.get(rightSymbol);
    if (left === undefined || right === undefined) return false;

    const commonTs = [...left.keys()]
      .filter((tsMs) => right.has(tsMs))
      .sort((a, b) => a - b)
      .slice(-correlationBars);
    if (commonTs.length < correlationBars) return false;

    const correlation = pearsonCorrelation(
      logReturns(commonTs.map((tsMs) => left.get(tsMs) as number)),
      logReturns(commonTs.map((tsMs) => right.get(tsMs) as number)),
    );
    return correlation !== null && correlation <= -threshold;
  });
}
