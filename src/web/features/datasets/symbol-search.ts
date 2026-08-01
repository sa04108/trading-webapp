/**
 * 종목 목록 검색 — 이름과 코드 두 가지로 찾는다.
 *
 * 두 축을 하나의 입력으로 받는 이유: 사용자는 "삼성전자" 를 떠올리거나 "005930" 을
 * 떠올리지, 어느 칸에 넣어야 하는지를 먼저 고르지 않는다. 입력 하나로 둘 다 맞히면
 * 검색 방식을 고르는 단계가 사라진다.
 *
 * 부분 일치를 쓴다 — 코드 앞자리만 아는 경우(`0059`)와 이름 일부만 아는 경우(`하이닉스`)가
 * 둘 다 흔하다. 대소문자는 무시한다: 해외 티커를 소문자로 치는 것을 실패로 만들 이유가 없다.
 * 한글 초성 검색은 하지 않는다 — 자모 분해가 필요하고, 그건 서버 검색으로 갈 때 할 일이다.
 */
export interface SearchableSymbol {
  readonly code: string;
  readonly name: string | null;
}

export function matchesSymbolQuery(symbol: SearchableSymbol, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (symbol.code.toLowerCase().includes(needle)) return true;
  return symbol.name !== null && symbol.name.toLowerCase().includes(needle);
}

export function filterSymbols<T extends SearchableSymbol>(
  symbols: readonly T[],
  query: string,
): readonly T[] {
  // 빈 검색어에 새 배열을 만들지 않는다 — 목록이 200종목이고 매 렌더 돌아간다
  if (query.trim().length === 0) return symbols;
  return symbols.filter((symbol) => matchesSymbolQuery(symbol, query));
}
