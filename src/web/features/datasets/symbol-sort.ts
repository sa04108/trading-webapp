/**
 * 종목 목록 정렬 — 가나다순과 규모 지표(시가총액·거래대금·거래량).
 *
 * `Intl.Collator('ko')` 를 쓰는 이유: 로케일 없는 `localeCompare` 는 엔진·플랫폼마다
 * 결과가 달라 목록 순서가 브라우저에 따라 바뀐다. 한글 자모 순서는 코드포인트 순서와
 * 일치하지 않는 구간이 있어 단순 비교로도 어긋난다.
 *
 * 이름을 못 받은 종목은 코드로 섞지 않고 **뒤로 몰아 둔다** — '005930' 과 '삼성전자' 를
 * 한 축에서 비교하면 사용자에게는 임의 순서로 보인다. 값이 없는 종목을 뒤로 보내는 것은
 * 규모 정렬도 마찬가지다: 시가총액을 모르는 종목을 0원으로 치면 "거래 없는 종목" 과
 * "값을 못 받은 종목" 이 같은 칸에 놓인다.
 *
 * 규모 정렬은 **내림차순**이다. 「시가총액순」을 고르는 사람이 보려는 것은 큰 종목이고,
 * 백테스트 상한을 넘는 데이터셋에서 상위 N종목을 자를 때 쓰는 순서도 이것이다.
 */
export interface SortableSymbol {
  readonly code: string;
  readonly name: string | null;
}

/** 정렬 축. 서버가 주는 지표(`GET /symbols/metrics`)와 짝이다 */
export type SymbolSortKey = 'NAME' | 'MARKET_CAP' | 'TRADING_VALUE' | 'TRADING_VOLUME';

export const SYMBOL_SORT_KEYS: readonly SymbolSortKey[] = [
  'MARKET_CAP',
  'TRADING_VALUE',
  'TRADING_VOLUME',
  'NAME',
];

export const SYMBOL_SORT_LABELS: Record<SymbolSortKey, string> = {
  MARKET_CAP: '시가총액순',
  TRADING_VALUE: '거래대금순',
  TRADING_VOLUME: '거래량순',
  NAME: '가나다순',
};

/** 한 종목의 지표. 모르는 값은 null 이다 — 0 과 구분한다 */
export interface SymbolMetrics {
  readonly marketCap: number | null;
  readonly tradingValue: number | null;
  readonly tradingVolume: number | null;
}

export type SymbolMetricsMap = ReadonlyMap<string, SymbolMetrics>;

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

export function compareSymbols(a: SortableSymbol, b: SortableSymbol): number {
  const aNamed = a.name !== null && a.name.length > 0;
  const bNamed = b.name !== null && b.name.length > 0;
  if (aNamed !== bNamed) return aNamed ? -1 : 1;
  if (aNamed && bNamed) {
    const byName = collator.compare(a.name!, b.name!);
    if (byName !== 0) return byName;
  }
  // 이름이 같거나 둘 다 없으면 코드로 — 순서가 매 렌더 흔들리지 않게 완전순서를 만든다
  return collator.compare(a.code, b.code);
}

export function metricValue(metrics: SymbolMetrics | undefined, key: SymbolSortKey): number | null {
  if (metrics === undefined || key === 'NAME') return null;
  const value =
    key === 'MARKET_CAP'
      ? metrics.marketCap
      : key === 'TRADING_VALUE'
        ? metrics.tradingValue
        : metrics.tradingVolume;
  // NaN·Infinity 는 비교에서 순서를 무너뜨린다 — "모름" 과 같이 다룬다
  return value !== null && Number.isFinite(value) ? value : null;
}

/**
 * 정렬. `key` 를 생략하면 가나다순이다.
 *
 * 값이 같거나 둘 다 없으면 가나다순으로 떨어뜨린다 — 랭킹 밖 종목 900개가 매 렌더
 * 다른 순서로 보이면 목록이 아니라 셔플이 된다.
 */
export function sortSymbols<T extends SortableSymbol>(
  symbols: readonly T[],
  key: SymbolSortKey = 'NAME',
  metrics?: SymbolMetricsMap,
): T[] {
  if (key === 'NAME' || metrics === undefined) return [...symbols].sort(compareSymbols);
  return [...symbols].sort((a, b) => {
    const aValue = metricValue(metrics.get(a.code), key);
    const bValue = metricValue(metrics.get(b.code), key);
    if (aValue === null || bValue === null) {
      if (aValue !== bValue) return aValue === null ? 1 : -1;
    } else if (aValue !== bValue) {
      return bValue - aValue;
    }
    return compareSymbols(a, b);
  });
}

/** 지표를 가진 종목 수 — 「N종목은 집계 없음」을 적을 근거다 */
export function countWithMetric(
  codes: readonly string[],
  key: SymbolSortKey,
  metrics: SymbolMetricsMap,
): number {
  if (key === 'NAME') return codes.length;
  return codes.filter((code) => metricValue(metrics.get(code), key) !== null).length;
}
