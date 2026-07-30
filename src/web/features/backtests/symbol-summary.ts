/**
 * 종목 표기 규칙의 단일 출처.
 *
 * 코드를 외우고 있는 사람만 결과를 읽을 수 있으면 안 된다 — 이름을 주로, 코드를
 * 괄호에 둔다. 형식을 한 가지로 통일하는 이유는 자리마다 다르면 규칙도 테스트도
 * 둘이 되기 때문이다.
 *
 * 렌더링(잘림 처리)은 `components/symbol-label.tsx` 가 맡는다. 이 파일은 문자열만
 * 다루므로 컴포넌트 테스트 환경 없이 단위 테스트할 수 있다.
 */

/** Description 에 나열할 종목 수. 200종목을 다 나열하면 화면 여러 줄을 잡아먹는다 */
export const SYMBOL_SUMMARY_LIMIT = 5;

/**
 * 요약에 넣을 이름 길이 상한. 긴 이름이 옆 라벨 자리를 밀어내지 않게 이름 쪽에서
 * 먼저 줄인다 — 최종 폭 맞춤은 호출부의 `truncate` 가 하고, 줄이지 않은 전체
 * 문자열은 `title` 로 남긴다.
 */
export const SYMBOL_NAME_MAX_CHARS = 20;

/** 상한을 넘는 이름만 '…' 로 줄인다. null·빈 이름은 그대로 흘려 코드만 남게 한다 */
export function clampSymbolName(
  name: string | null,
  maxChars = SYMBOL_NAME_MAX_CHARS,
): string | null {
  if (!name || name.length <= maxChars) return name;
  return `${name.slice(0, maxChars - 1)}…`;
}

/** '삼성전자 (005930)' / 이름을 모르면 '005930' — 빈 괄호를 만들지 않는다 */
export function formatSymbolLabel(symbol: string, name: string | null): string {
  return name ? `${name} (${symbol})` : symbol;
}

/**
 * 앞 `limit` 개를 나열하고 나머지는 개수로 접는다. 전체 목록은 거래 내역의 종목
 * 필터와 종목별 성과 표에 있으므로 여기서 잃어도 접근성이 사라지지 않는다.
 */
export function formatSymbolSummary(
  symbols: readonly string[],
  nameOf: (symbol: string) => string | null,
  limit = SYMBOL_SUMMARY_LIMIT,
): string {
  if (symbols.length === 0) return '';
  const shown = symbols
    .slice(0, limit)
    .map((symbol) => formatSymbolLabel(symbol, nameOf(symbol)))
    .join(', ');
  const rest = symbols.length - limit;
  return rest > 0 ? `${shown} 외 ${rest}종목` : shown;
}
