import { useState } from "react";

interface HistoryEditState {
  editing: boolean;
  selected: ReadonlySet<string>;
}
const EMPTY: HistoryEditState = { editing: false, selected: new Set() };

export function toggleHistorySelection(selected: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  return ids.length > 0 && ids.every((id) => selected.has(id)) ? new Set() : new Set(ids);
}

/** 다른 전략의 편집·페이지 전환·삭제가 현재 전략의 선택을 지우지 않게 한다. */
export function useHistoryEditing() {
  const [groups, setGroups] = useState<Record<string, HistoryEditState>>({});
  const update = (id: string, change: (state: HistoryEditState) => HistoryEditState) =>
    setGroups((previous) => ({ ...previous, [id]: change(previous[id] ?? EMPTY) }));
  return {
    state: (id: string) => groups[id] ?? EMPTY,
    setEditing: (id: string, editing: boolean) => update(id, () => ({ editing, selected: new Set() })),
    clear: (id?: string) => {
      if (id !== undefined) update(id, (state) => ({ ...state, selected: new Set() }));
      else setGroups((previous) => Object.fromEntries(Object.entries(previous).map(([key, state]) => [key, { ...state, selected: new Set<string>() }])));
    },
    toggleOne: (groupId: string, id: string) => update(groupId, (state) => {
      const selected = new Set(state.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { ...state, selected };
    }),
    toggleAll: (id: string, ids: readonly string[]) => update(id, (state) => ({ ...state, selected: toggleHistorySelection(state.selected, ids) })),
  };
}
