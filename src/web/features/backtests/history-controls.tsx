import { useCallback, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  HistorySort,
  HistoryDirection,
} from "../../../shared/schemas/backtest-history";

const sorts: HistorySort[] = [
  "createdAt",
  "periodEnd",
  "duration",
  "returnPct",
  "cagrPct",
];
export type HistoryView = "table" | "cards";
export function useHistoryControls(intraday = false) {
  const [search, setSearch] = useSearchParams();
  const saved = (key: string) => {
    try {
      return localStorage.getItem(`history-${key}`);
    } catch {
      return null;
    }
  };
  const requestedSort = search.get("sort") ?? saved("sort");
  const sort: HistorySort =
    sorts.includes(requestedSort as HistorySort) &&
    !(intraday && requestedSort === "cagrPct")
      ? (requestedSort as HistorySort)
      : "createdAt";
  const dir: HistoryDirection =
    (search.get("dir") ?? saved("dir")) === "asc" ? "asc" : "desc";
  const requestedView = search.get("view") ?? saved("view");
  const view: HistoryView =
    requestedView === "table" || requestedView === "cards"
      ? requestedView
      : typeof window !== "undefined" &&
          window.matchMedia("(max-width: 639px)").matches
        ? "table"
        : "cards";
  const page = (id: string) => {
    const raw = search.get(`page.${id}`);
    if (!raw || !/^[1-9]\d*$/.test(raw)) return 1;
    const value = Number(raw);
    return Number.isSafeInteger(value) &&
      value <= Math.floor(Number.MAX_SAFE_INTEGER / 10)
      ? value
      : 1;
  };
  const collapsed = (id: string) => search.getAll("collapsed").includes(id);
  const update = useCallback(
    (fn: (next: URLSearchParams) => void) => {
      setSearch(
        (previous) => {
          const next = new URLSearchParams(previous);
          fn(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearch],
  );
  const correctPages = useCallback(
    (corrections: Array<{ id: string; page: number }>) => {
      update((next) => {
        for (const correction of corrections) {
          if (correction.page <= 1) next.delete(`page.${correction.id}`);
          else next.set(`page.${correction.id}`, String(correction.page));
        }
      });
    },
    [update],
  );
  const clearPages = (next: URLSearchParams) => {
    for (const key of [...next.keys()])
      if (key.startsWith("page.")) next.delete(key);
  };
  const preference = (key: string, value: string) => {
    try {
      localStorage.setItem(`history-${key}`, value);
    } catch {
      /* 저장소를 사용할 수 없어도 화면 설정은 유지한다. */
    }
  };
  return {
    sort,
    dir,
    view,
    page,
    collapsed,
    correctPages,
    setSort(value: HistorySort) {
      preference("sort", value);
      update((p) => {
        p.set("sort", value);
        clearPages(p);
      });
    },
    setDir(value: HistoryDirection) {
      preference("dir", value);
      update((p) => {
        p.set("dir", value);
        clearPages(p);
      });
    },
    setView(value: HistoryView) {
      preference("view", value);
      update((p) => {
        p.set("view", value);
        clearPages(p);
      });
    },
    setPage(id: string, value: number) {
      update((p) => {
        if (value <= 1) p.delete(`page.${id}`);
        else p.set(`page.${id}`, String(value));
      });
    },
    toggle(id: string) {
      update((p) => {
        const values = p.getAll("collapsed");
        p.delete("collapsed");
        for (const value of values)
          if (value !== id) p.append("collapsed", value);
        if (!values.includes(id)) p.append("collapsed", id);
      });
    },
  };
}
export type HistoryControlsState = ReturnType<typeof useHistoryControls>;
export function HistoryStrategyGroup({
  name,
  description,
  total,
  collapsed,
  onToggle,
  children,
}: {
  name: string;
  description?: string;
  total: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={!collapsed} onOpenChange={onToggle} asChild>
      <section className="space-y-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="min-w-0 truncate font-semibold">{name}</h3>
          {description ? (
            <InfoHint label={`${name} 전략 설명`}>
              <p>{description}</p>
            </InfoHint>
          ) : null}
          <span className="ml-1 shrink-0 text-xs text-muted-foreground">
            {total}건
          </span>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label={`${name} ${collapsed ? "펼치기" : "접기"}`}
            >
              {collapsed ? <ChevronRight /> : <ChevronDown />}
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="space-y-3">
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export function HistoryToolbar({
  controls,
  intraday,
  onChange,
}: {
  controls: HistoryControlsState;
  intraday?: boolean;
  onChange?: () => void;
}) {
  return (
    <div
      className="flex items-center gap-1 sm:gap-2"
      aria-label="이력 표시 설정"
    >
      <Select
        value={controls.sort}
        onValueChange={(value) => {
          controls.setSort(value as HistorySort);
          onChange?.();
        }}
      >
        <SelectTrigger
          aria-label="전략 내 기록 정렬"
          className="min-w-0 text-xs sm:text-sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="createdAt">
            {controls.dir === "desc" ? "최신순" : "오래된 순"}
          </SelectItem>
          <SelectItem value="periodEnd">
            종료일 · {controls.dir === "desc" ? "최근순" : "과거순"}
          </SelectItem>
          <SelectItem value="duration">
            기간 · {controls.dir === "desc" ? "긴 순" : "짧은 순"}
          </SelectItem>
          <SelectItem value="returnPct">
            수익률 · {controls.dir === "desc" ? "높은 순" : "낮은 순"}
          </SelectItem>
          <SelectItem value="cagrPct" disabled={intraday}>
            CAGR · {controls.dir === "desc" ? "높은 순" : "낮은 순"}
          </SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        aria-label={
          controls.dir === "desc" ? "오름차순으로 변경" : "내림차순으로 변경"
        }
        onClick={() => {
          controls.setDir(controls.dir === "desc" ? "asc" : "desc");
          onChange?.();
        }}
      >
        {controls.dir === "desc" ? "↓" : "↑"}
      </Button>
      <div
        className="ml-auto flex shrink-0 gap-1"
        role="group"
        aria-label="보기 방식"
      >
        {(["table", "cards"] as const).map((view) => (
          <Button
            key={view}
            size="sm"
            className="px-2 text-xs sm:px-3"
            variant={controls.view === view ? "default" : "outline"}
            aria-pressed={controls.view === view}
            onClick={() => {
              controls.setView(view);
              onChange?.();
            }}
          >
            {view === "table" ? "표 보기" : "카드 보기"}
          </Button>
        ))}
      </div>
    </div>
  );
}
export function HistoryPager({
  page,
  total,
  limit,
  onPage,
}: {
  page: number;
  total: number;
  limit: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {total}건 · {page} / {pages}
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          이전
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          다음
        </Button>
      </div>
    </div>
  );
}

export function historyPeriod(from: string, to: string) {
  return `${from.slice(2).replaceAll("-", ".")} – ${to.slice(2).replaceAll("-", ".")}`;
}
