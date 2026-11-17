import { Copy, Download, SlidersHorizontal, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ResultActions({ onClone, clonePending, searchHref, reconfigureHref, exportHref, onDelete }: {
  onClone: () => void;
  clonePending: boolean;
  searchHref: string;
  reconfigureHref: string;
  exportHref?: string;
  onDelete: () => void;
}) {
  return <>
    <div className="grid w-full grid-cols-2 overflow-hidden rounded-lg border border-input sm:w-auto sm:auto-cols-max sm:grid-flow-col sm:grid-cols-none" role="group" aria-label="백테스트 복제">
      <Button className="h-11 min-w-0 rounded-none border-0 focus-visible:z-10 focus-visible:ring-inset" onClick={onClone} disabled={clonePending}>
        <Copy data-icon="inline-start" />그대로 복제
      </Button>
      <Button variant="outline" className="h-11 min-w-0 rounded-none border-0 border-l border-input focus-visible:z-10 focus-visible:ring-inset" asChild>
        <Link to={searchHref}><SlidersHorizontal data-icon="inline-start" />설정 탐색 실험</Link>
      </Button>
      <Button variant="outline" className={cn("h-11 min-w-0 rounded-none border-0 border-input focus-visible:z-10 focus-visible:ring-inset", "col-span-2 border-t sm:col-span-1 sm:border-l sm:border-t-0")} asChild>
        <Link to={reconfigureHref}><SlidersHorizontal data-icon="inline-start" />재설정 및 복제</Link>
      </Button>
    </div>
    {exportHref ? <Button variant="outline" className="h-11" asChild><a href={exportHref} download><Download data-icon="inline-start" />Export</a></Button> : null}
    <Button variant="ghost" className="h-11" onClick={onDelete}><Trash2 data-icon="inline-start" />삭제</Button>
  </>;
}
