import { useState } from "react";

export type ListSelectionRequest = { ids: string[] } | { all: true; excludeIds: string[] };

/** 전체 선택은 현재 페이지의 ID가 아니라 목록 전체와 제외 항목으로 표현한다. */
export function useListSelection() {
  const [selection, setSelection] = useState<{ all: boolean; ids: ReadonlySet<string> }>({ all: false, ids: new Set() });
  return {
    excludeIds: selection.all ? [...selection.ids] : [],
    forList: (items: readonly { id: string }[], total: number, selectionCount: number) => {
      const selectedIds = items.filter((item) => selection.ids.has(item.id)).map((item) => item.id);
      // 제외한 기록이 다른 탭의 삭제나 보관 만료로 사라질 수 있어 서버 집계를 사용한다.
      const count = selection.all ? selectionCount : selectedIds.length;
      return {
        count,
        checked: total > 0 && count === total ? true : count > 0 ? "indeterminate" as const : false,
        request: (): ListSelectionRequest => selection.all
          ? { all: true, excludeIds: [...selection.ids] }
          : { ids: selectedIds },
      };
    },
    isSelected: (id: string) => selection.all !== selection.ids.has(id),
    clear: () => setSelection({ all: false, ids: new Set() }),
    changePage: () => setSelection((previous) => previous.all ? previous : { all: false, ids: new Set() }),
    toggleAll: (checked: boolean | "indeterminate") => setSelection({ all: checked === true, ids: new Set() }),
    toggle: (id: string, checked: boolean | "indeterminate") => setSelection((previous) => {
      const ids = new Set(previous.ids);
      if (previous.all === (checked === true)) ids.delete(id);
      else ids.add(id);
      return { ...previous, ids };
    }),
  };
}
