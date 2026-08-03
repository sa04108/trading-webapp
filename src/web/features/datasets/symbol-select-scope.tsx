import { Button } from '@/components/ui/button';
import type { SymbolSummary } from './symbol-types';

/**
 * 두 범위의 전체 선택 버튼 — 종목 탭 편집 모드와 데이터셋의 종목 선택 목록이 공유한다.
 *
 * 두 범위를 따로 둔다. 「전체 선택」은 검색 결과 전체(1,000종목일 수 있다), 「페이지내
 * 전체 선택」은 지금 보이는 것만이다. 하나로 합치면 검색 없이 누른 사용자가 의도보다
 * 훨씬 많이 담게 되거나, 반대로 페이지를 넘겨 가며 100번 눌러야 한다.
 *
 * 범위 밖의 선택은 건드리지 않는다 — 검색어를 바꿔 가며 고른 것을 새 검색이 지우면 안 된다.
 *
 * 검색 중이면 대상이 검색 결과임을 라벨에 적는다 — 「전체 선택」이 200종목을 담을
 * 것처럼 보이는데 12종목만 담기면 그것도 거짓말이다.
 */
export function SymbolSelectScopeButtons({
  filtered,
  visible,
  pageCount,
  selected,
  query,
  onChange,
}: {
  /** 검색 결과 전체 — 「전체 선택」의 대상 */
  filtered: readonly SymbolSummary[];
  /** 지금 페이지에 보이는 행 — 「페이지내 전체 선택」의 대상 */
  visible: readonly SymbolSummary[];
  pageCount: number;
  selected: ReadonlySet<string>;
  query: string;
  onChange: (next: Set<string>) => void;
}) {
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((symbol) => selected.has(symbol.code));
  const allPageSelected =
    visible.length > 0 && visible.every((symbol) => selected.has(symbol.code));

  const setMany = (rows: readonly SymbolSummary[], select: boolean): void => {
    const next = new Set(selected);
    for (const symbol of rows) {
      if (select) next.add(symbol.code);
      else next.delete(symbol.code);
    }
    onChange(next);
  };

  return (
    <>
      {/* 대상이 비면 잠근다 — 「검색 결과 0종목 선택」 은 눌러도 아무 일이 없는 버튼이다 */}
      <Button
        variant="ghost"
        size="sm"
        className="h-9"
        disabled={filtered.length === 0}
        onClick={() => setMany(filtered, !allFilteredSelected)}
      >
        {allFilteredSelected
          ? '전체 해제'
          : query.trim().length > 0
            ? `검색 결과 ${filtered.length}종목 선택`
            : '전체 선택'}
      </Button>
      {/* 페이지가 하나면 「전체 선택」과 같은 동작이라 버튼을 둘 둘 이유가 없다 */}
      {pageCount > 1 ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-9"
          onClick={() => setMany(visible, !allPageSelected)}
        >
          {allPageSelected ? '페이지내 해제' : '페이지내 전체 선택'}
        </Button>
      ) : null}
    </>
  );
}
