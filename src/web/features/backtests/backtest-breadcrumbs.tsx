import { Fragment } from "react";
import { Link } from "react-router";
import type { BacktestBreadcrumbEntry } from "@shared/schemas/backtest-experiments";
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator, BreadcrumbEllipsis } from "@/components/ui/breadcrumb";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useBacktestLineage } from "./experiment-api";
import { experimentPaths, type ExperimentMode } from "./experiment-paths";

export function ResultBreadcrumbs({ items }: { items: BacktestBreadcrumbEntry[] }) {
  const collapsed = items.length > 3;
  const render = (item: BacktestBreadcrumbEntry, current: boolean) => current ?
    <BreadcrumbPage className="break-words" title={item.description}>{item.label}</BreadcrumbPage> : item.href ?
      <BreadcrumbLink asChild><Link to={item.href} title={item.description}>{item.label}</Link></BreadcrumbLink> :
      <span title={item.description}>{item.label}</span>;
  return <Breadcrumb aria-label="백테스트 경로">
    <BreadcrumbList className="gap-1 text-xs sm:gap-1.5">
      {items.map((item, index) => {
        const hidden = collapsed && index > 0 && index < items.length - 1;
        return <Fragment key={`${index}:${item.href ?? item.label}`}>
          {collapsed && index === 1 ? <>
            <BreadcrumbSeparator className="sm:hidden" />
            <BreadcrumbItem className="sm:hidden">
              <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="상위 백테스트 경로 펼치기"><BreadcrumbEllipsis /></Button></PopoverTrigger>
                <PopoverContent align="start" className="max-h-80 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto p-2">
                  <ol className="space-y-1 text-sm">{items.slice(1, -1).map((ancestor, i) => <li key={i} className="rounded-md p-2 hover:bg-muted">{render(ancestor, false)}</li>)}</ol>
                </PopoverContent></Popover>
            </BreadcrumbItem>
          </> : null}
          {index > 0 ? <BreadcrumbSeparator className={hidden ? "hidden sm:block" : ""} /> : null}
          <BreadcrumbItem className={hidden ? "hidden sm:inline-flex" : "min-w-0"}>{render(item, index === items.length - 1)}</BreadcrumbItem>
        </Fragment>;
      })}
    </BreadcrumbList>
  </Breadcrumb>;
}

export function BacktestBreadcrumbs({ jobId, trail = [], mode = "daily" }: { jobId: string; trail?: BacktestBreadcrumbEntry[]; mode?: ExperimentMode }) {
  const query = useBacktestLineage(jobId, mode);
  const items = query.data?.items ?? [{ label: "백테스트", href: "/backtests" },
    { label: query.isError ? "경로 확인 불가" : "경로 불러오는 중", href: experimentPaths(mode).result(jobId) }];
  return <div className="space-y-1">
    <ResultBreadcrumbs items={[...items, ...trail]} />
    {query.isError ? <p className="text-xs text-destructive" role="alert">상위 결과 경로를 불러오지 못했습니다. <button className="underline" onClick={() => void query.refetch()}>다시 시도</button></p> : query.data?.complete === false ?
      <p className="text-xs text-muted-foreground">상위 기록이 삭제되었거나 연결을 확인할 수 없어 일부 경로만 표시합니다.</p> : null}
  </div>;
}
