export type BacktestDataExclusionCategory =
  | 'KRX_CLASSIFICATION'
  | 'KRX_SELECTION_METRIC'
  | 'KRX_PRICE'
  | 'DART_FINANCIAL'
  | 'DART_CORPORATE_ACTION';

/**
 * 외부 API 요청은 정상적으로 끝났지만 종목 하나의 입력을 완전하게 만들 수 없었던 경우.
 * 준비 단계는 이 종목을 전 기간 후보에서 제외해 순위를 다시 계산하고, 이 원인을
 * preview와 최종 backtest warning에 그대로 고정한다.
 */
export interface BacktestDataExclusion {
  readonly symbol: string;
  readonly category: BacktestDataExclusionCategory;
  /** 날짜, 연도 또는 재무 period처럼 원인을 다시 찾을 수 있는 최소 범위. */
  readonly periodKey: string;
  readonly reason: string;
}

export function backtestDataExclusionKey(exclusion: BacktestDataExclusion): string {
  return [
    exclusion.symbol,
    exclusion.category,
    exclusion.periodKey,
    exclusion.reason,
  ].join('\0');
}

function categoryLabel(category: BacktestDataExclusionCategory): string {
  switch (category) {
    case 'KRX_CLASSIFICATION': return 'KRX 종목 분류';
    case 'KRX_SELECTION_METRIC': return 'KRX 선정 지표';
    case 'KRX_PRICE': return 'KRX 가격';
    case 'DART_FINANCIAL': return 'DART 재무';
    case 'DART_CORPORATE_ACTION': return '자본변동';
  }
}

export function backtestDataExclusionWarnings(
  exclusions: readonly BacktestDataExclusion[],
): string[] {
  const grouped = new Map<string, BacktestDataExclusion[]>();
  for (const exclusion of exclusions) {
    const key = `${exclusion.symbol}\0${exclusion.category}`;
    const values = grouped.get(key) ?? [];
    if (!values.some((value) => backtestDataExclusionKey(value) === backtestDataExclusionKey(exclusion))) {
      values.push(exclusion);
      grouped.set(key, values);
    }
  }
  return [...grouped.values()]
    .sort((left, right) => (
      left[0]!.symbol.localeCompare(right[0]!.symbol)
      || left[0]!.category.localeCompare(right[0]!.category)
    ))
    .map((values) => {
      const first = values[0]!;
      const causes = values
        .sort((left, right) => (
          left.periodKey.localeCompare(right.periodKey)
          || left.reason.localeCompare(right.reason)
        ))
        .map((value) => `${value.periodKey}: ${value.reason}`)
        .join('; ');
      return `${categoryLabel(first.category)} 정보를 온전히 확보할 수 없어 종목 `
        + `${first.symbol}을 매매 대상에서 제외했습니다 — ${causes}.`;
    });
}
