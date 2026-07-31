/**
 * 종목 목록 정렬 — 가나다순.
 *
 * `Intl.Collator('ko')` 를 쓰는 이유: 로케일 없는 `localeCompare` 는 엔진·플랫폼마다
 * 결과가 달라 목록 순서가 브라우저에 따라 바뀐다. 한글 자모 순서는 코드포인트 순서와
 * 일치하지 않는 구간이 있어 단순 비교로도 어긋난다.
 *
 * 이름을 못 받은 종목은 코드로 섞지 않고 **뒤로 몰아 둔다** — '005930' 과 '삼성전자' 를
 * 한 축에서 비교하면 사용자에게는 임의 순서로 보인다. 정렬·필터 기능 자체는 나중이지만
 * (지금은 가나다순 고정), 순서가 흔들리지 않는 것이 그 전제다.
 */
export interface SortableSymbol {
  readonly code: string;
  readonly name: string | null;
}

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

export function sortSymbols<T extends SortableSymbol>(symbols: readonly T[]): T[] {
  return [...symbols].sort(compareSymbols);
}
