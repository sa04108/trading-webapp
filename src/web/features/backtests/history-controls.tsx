import { usePaginationPosition } from "@/components/use-pagination-position";
import { useCallback, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  Table2,
} from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { HistoryColumnPicker } from "./history-column-picker";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
        { replace: true, preventScrollReset: true },
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
  actions,
  children,
}: {
  name: string;
  description?: string;
  total: number;
  collapsed: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible open={!collapsed} onOpenChange={onToggle} asChild>
      <section className="space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="flex min-w-0 flex-1 basis-40 items-center gap-1.5">
            <h3 className="min-w-0 truncate font-semibold">{name}</h3>
            <InfoHint
              label={`${name} 전략 설명`}
              className="flex size-8 shrink-0 items-center justify-center"
            >
              <p className="font-medium">{name}</p>
              {description ? <p>{description}</p> : null}
            </InfoHint>
            <span className="ml-1 shrink-0 text-xs text-muted-foreground">
              {total}건
            </span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {actions}
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${name} ${collapsed ? "펼치기" : "접기"}`}
              >
                {collapsed ? <ChevronRight /> : <ChevronDown />}
              </Button>
            </CollapsibleTrigger>
          </div>
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
  const viewLabel =
    controls.view === "table" ? "카드 보기로 전환" : "표 보기로 전환";
  const sortLabels: Record<HistorySort, string> = {
    createdAt: controls.dir === "desc" ? "최신순" : "오래된 순",
    periodEnd: `종료일 · ${controls.dir === "desc" ? "최근순" : "과거순"}`,
    duration: `기간 · ${controls.dir === "desc" ? "긴 순" : "짧은 순"}`,
    returnPct: `수익률 · ${controls.dir === "desc" ? "높은 순" : "낮은 순"}`,
    cagrPct: `CAGR · ${controls.dir === "desc" ? "높은 순" : "낮은 순"}`,
  };
  const compactSortLabels: Record<HistorySort, string> = {
    createdAt: sortLabels.createdAt,
    periodEnd: "종료일",
    duration: "기간",
    returnPct: "수익률",
    cagrPct: "CAGR",
  };
  return (
    <div
      className="flex items-center gap-1 max-[360px]:gap-0.5 sm:gap-2"
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
          className="min-h-11 min-w-0 text-xs max-[360px]:gap-1 max-[360px]:px-1 sm:min-h-8 sm:text-sm"
        >
          <SelectValue>
            <span className="sm:hidden">{compactSortLabels[controls.sort]}</span>
            <span className="hidden sm:inline">{sortLabels[controls.sort]}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {sorts.map((sort) => (
            <SelectItem key={sort} value={sort} disabled={intraday && sort === "cagrPct"}>
              {sortLabels[sort]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="icon"
        variant="outline"
        className="size-11 sm:size-8"
        aria-label={
          controls.dir === "desc" ? "오름차순으로 변경" : "내림차순으로 변경"
        }
        onClick={() => {
          controls.setDir(controls.dir === "desc" ? "asc" : "desc");
          onChange?.();
        }}
      >
        {controls.dir === "desc" ? (
          <ArrowDown aria-hidden />
        ) : (
          <ArrowUp aria-hidden />
        )}
      </Button>
      <HistoryColumnPicker enabled={controls.view === "table"}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Switch
              className="h-11 w-20 aria-checked:bg-muted aria-[checked=false]:bg-muted sm:h-8 sm:w-14 [&_[data-slot=switch-thumb]]:size-9 sm:[&_[data-slot=switch-thumb]]:size-6"
              trackContent={
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 grid grid-cols-2 items-center justify-items-center text-muted-foreground"
                >
                  <Table2 className="size-4" />
                  <LayoutGrid className="size-4" />
                </span>
              }
              aria-label="카드 보기"
              checked={controls.view === "cards"}
              onCheckedChange={(checked) => {
                controls.setView(checked ? "cards" : "table");
                onChange?.();
              }}
            >
              {controls.view === "table" ? <Table2 aria-hidden /> : <LayoutGrid aria-hidden />}
            </Switch>
          </TooltipTrigger>
          <TooltipContent>{viewLabel}</TooltipContent>
        </Tooltip>
      </HistoryColumnPicker>
    </div>
  );
}
export function HistoryPager({
  strategyName,
  page,
  total,
  limit,
  pending = false,
  onPage,
}: {
  strategyName: string;
  page: number;
  total: number;
  limit: number;
  pending?: boolean;
  onPage: (page: number) => void;
}) {
  const preservePosition = usePaginationPosition(page, pending);
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav
      data-pagination-controls
      aria-busy={pending}
      aria-label={`${strategyName} 이력 페이지`}
      className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
    >
      <span>
        {total}건 · {page} / {pages}
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || page <= 1}
          onClick={(event) => { preservePosition(event.currentTarget); onPage(page - 1); }}
        >
          이전
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || page >= pages}
          onClick={(event) => { preservePosition(event.currentTarget); onPage(page + 1); }}
        >
          다음
        </Button>
      </div>
    </nav>
  );
}

export function HistoryEditActions({
  editing,
  onEditingChange,
  total,
  selected,
  pending,
  selectionDisabled = false,
  onToggleAll,
  onRemoveSelected,
}: {
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  total: number;
  selected: number;
  pending: boolean;
  selectionDisabled?: boolean;
  onToggleAll: () => void;
  onRemoveSelected: () => void;
}) {
  return (
    <>
      {editing ? (
        <>
          <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
            <Checkbox
              checked={selected > 0 && selected < total ? "indeterminate" : total > 0 && selected === total}
              disabled={pending || selectionDisabled || total === 0}
              onCheckedChange={onToggleAll}
              aria-label="전체 선택"
            />
            전체 선택
          </label>
          <Button variant="destructive" size="sm" disabled={!selected || pending || selectionDisabled} onClick={onRemoveSelected}>
            삭제 ({selected})
          </Button>
        </>
      ) : null}
      <Button variant="outline" size="sm" disabled={pending} aria-pressed={editing} onClick={() => onEditingChange(!editing)}>
        {editing ? "완료" : "편집"}
      </Button>
    </>
  );
}

export function historyPeriod(from: string, to: string) {
  return `${from.slice(2).replaceAll("-", ".")} – ${to.slice(2).replaceAll("-", ".")}`;
}
