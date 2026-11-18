import { useSyncExternalStore } from "react";

export const HISTORY_TABLE_COLUMNS = [
  { id: "return", label: "수익률" },
  { id: "cagr", label: "CAGR" },
  { id: "mdd", label: "MDD" },
  { id: "date", label: "실행일" },
  { id: "sharpe", label: "Sharpe" },
  { id: "validation", label: "검증" },
] as const;

export type HistoryColumnId = (typeof HISTORY_TABLE_COLUMNS)[number]["id"];
export type HistoryTablePreferences = {
  version: 1;
  order: HistoryColumnId[];
  visible: HistoryColumnId[];
};

const allIds: HistoryColumnId[] = HISTORY_TABLE_COLUMNS.map((column) => column.id);
export const DEFAULT_HISTORY_TABLE_PREFERENCES: HistoryTablePreferences = {
  version: 1,
  order: [...allIds],
  visible: ["return", "cagr", "mdd", "date"],
};

function knownIds(value: unknown): HistoryColumnId[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((id): id is HistoryColumnId =>
    typeof id === "string" && allIds.includes(id as HistoryColumnId),
  ))];
}

export function normalizeHistoryTablePreferences(value: unknown): HistoryTablePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value as { version?: unknown }).version !== 1) {
    return { version: 1, order: [...allIds], visible: [...DEFAULT_HISTORY_TABLE_PREFERENCES.visible] };
  }
  const input = value as { order?: unknown; visible?: unknown };
  const order = knownIds(input.order) ?? [];
  const visible = knownIds(input.visible) ?? [...DEFAULT_HISTORY_TABLE_PREFERENCES.visible];
  return { version: 1, order: [...order, ...allIds.filter((id) => !order.includes(id))], visible };
}

const storageKey = "history-table-columns";
let snapshot = DEFAULT_HISTORY_TABLE_PREFERENCES;
let initialized = false;
let listening = false;
const listeners = new Set<() => void>();

function readStored(onAccessError: HistoryTablePreferences): HistoryTablePreferences {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(storageKey);
  } catch {
    return onAccessError;
  }
  try {
    return normalizeHistoryTablePreferences(stored === null ? null : JSON.parse(stored));
  } catch {
    return normalizeHistoryTablePreferences(null);
  }
}

function getSnapshot(): HistoryTablePreferences {
  if (!initialized && typeof window !== "undefined") {
    snapshot = readStored(snapshot);
    initialized = true;
  }
  return snapshot;
}

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!listening && typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== storageKey && event.key !== null) return;
      snapshot = readStored(snapshot);
      notify();
    });
    listening = true;
  }
  return () => { listeners.delete(listener); };
}

function update(next: HistoryTablePreferences) {
  snapshot = next;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // 저장소를 사용할 수 없어도 현재 화면의 설정은 유지한다.
  }
  notify();
}

export function useHistoryTablePreferences() {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_HISTORY_TABLE_PREFERENCES);
  return {
    order: preferences.order,
    visible: preferences.visible,
    visibleColumns: preferences.order.flatMap((id) => {
      const column = HISTORY_TABLE_COLUMNS.find((item) => item.id === id);
      return column && preferences.visible.includes(id) ? [column] : [];
    }),
    setVisible(id: HistoryColumnId, visible: boolean) {
      const current = getSnapshot();
      update({ ...current, visible: visible
        ? [...new Set([...current.visible, id])]
        : current.visible.filter((item) => item !== id) });
    },
    setOrder(order: readonly HistoryColumnId[]) {
      const current = getSnapshot();
      update(normalizeHistoryTablePreferences({ ...current, order }));
    },
  };
}
