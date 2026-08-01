import { Checkbox } from '@/components/ui/checkbox';
import { sliceLabel } from './dataset-slices';
import { sortSymbols } from './symbol-sort';
import type { SymbolSummary } from './symbol-types';

/**
 * 등록된 종목에서 골라 담는 목록. 데이터셋 생성과 참조 편집이 같은 컴포넌트를 쓴다 —
 * 두 화면이 갈라지면 한쪽만 "데이터 없음" 을 표시하거나 정렬이 달라진다.
 *
 * 보유 봉을 함께 적는 이유: 봉이 없는 종목을 참조에 넣으면 제출 단계에서야 걸린다
 * (D-034 의 소비 봉 해소). 고르는 자리에서 미리 보이면 그 왕복이 사라진다.
 */
export function SymbolPicker({
  symbols,
  selected,
  onToggle,
  emptyMessage = '등록된 종목이 없습니다 — 종목 탭에서 먼저 추가하세요.',
  idPrefix,
}: {
  symbols: readonly SymbolSummary[];
  selected: ReadonlySet<string>;
  onToggle: (code: string) => void;
  emptyMessage?: string;
  /** 같은 화면에 두 목록이 뜰 수 있어 체크박스 id 가 충돌하지 않게 한다 */
  idPrefix: string;
}) {
  if (symbols.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
      {sortSymbols(symbols).map((symbol) => {
        const held = symbol.slices.filter((slice) => slice.hasData).map((slice) => sliceLabel(slice.slice));
        const id = `${idPrefix}-${symbol.code}`;
        return (
          <div key={symbol.code} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={selected.has(symbol.code)}
              onCheckedChange={() => onToggle(symbol.code)}
            />
            <label htmlFor={id} className="flex min-w-0 flex-1 items-center gap-1 text-sm">
              <span className="truncate">{symbol.name ?? symbol.code}</span>
              {symbol.name ? (
                <span className="shrink-0 text-xs text-muted-foreground">{symbol.code}</span>
              ) : null}
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {held.length > 0 ? held.join('·') : '데이터 없음'}
              </span>
            </label>
          </div>
        );
      })}
    </div>
  );
}
