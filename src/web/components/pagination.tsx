import { usePaginationPosition } from "./use-pagination-position";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pageNumberLimitForWidth, visiblePageNumbers } from "@/lib/pagination";
import { cn } from "@/lib/utils";

export interface PaginationProps {
  readonly currentPage: number;
  readonly pageCount: number;
  readonly onPageChange: (nextPage: number) => void;
  readonly ariaLabel: string;
  readonly total?: { readonly count: number; readonly unit: string };
  /**
   * 페이지 번호 버튼 개수 상한 — 좁은 구획(사이드바)에서 쓴다. 화면 폭으로 정한
   * 자동값과 작은 쪽을 택한다. 자동값은 `window.innerWidth` 를 보는 탓에 넓은
   * 화면의 320px 사이드바에서도 9개를 내밀어 카드 밖으로 삐져나온다.
   */
  readonly maxPageNumbers?: number;
  readonly className?: string;
  readonly pending?: boolean;
}

function usePageNumberLimit(): 5 | 7 | 9 {
  const [limit, setLimit] = useState<5 | 7 | 9>(5);

  useEffect(() => {
    const update = (): void =>
      setLimit(pageNumberLimitForWidth(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return limit;
}

export function Pagination({
  currentPage,
  pageCount,
  onPageChange,
  ariaLabel,
  total,
  maxPageNumbers,
  className,
  pending = false,
}: PaginationProps) {
  const preservePosition = usePaginationPosition(currentPage, pending);
  const widthLimit = usePageNumberLimit();
  const maxVisible = Math.max(
    1,
    Math.min(widthLimit, maxPageNumbers ?? widthLimit),
  );
  const safePageCount = Math.max(1, Math.trunc(pageCount));
  const safeCurrentPage = Math.min(
    Math.max(0, Math.trunc(currentPage)),
    safePageCount - 1,
  );

  if (safePageCount <= 1) return null;

  const pageNumbers = visiblePageNumbers(
    safeCurrentPage,
    safePageCount,
    maxVisible,
  );
  const changePage = (nextPage: number, button: HTMLButtonElement): void => {
    const target = Math.min(Math.max(0, nextPage), safePageCount - 1);
    if (pending || target === safeCurrentPage) return;
    preservePosition(button);
    onPageChange(target);
  };

  return (
    <nav data-pagination-controls aria-busy={pending} aria-label={ariaLabel} className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="첫 페이지"
          disabled={pending || safeCurrentPage === 0}
          onClick={(event) => changePage(0, event.currentTarget)}
        >
          <ChevronsLeft aria-hidden />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="이전 페이지"
          disabled={pending || safeCurrentPage === 0}
          onClick={(event) => changePage(safeCurrentPage - 1, event.currentTarget)}
        >
          <ChevronLeft aria-hidden />
        </Button>

        {pageNumbers.map((pageNumber) => {
          const pageIndex = pageNumber - 1;
          const isCurrent = pageIndex === safeCurrentPage;
          return (
            <Button
              key={pageNumber}
              type="button"
              variant={isCurrent ? "secondary" : "ghost"}
              size="icon"
              aria-label={
                isCurrent
                  ? `현재 ${pageNumber}페이지`
                  : `${pageNumber}페이지로 이동`
              }
              disabled={pending}
              aria-current={isCurrent ? "page" : undefined}
              className={cn("text-xs tabular-nums", isCurrent && "font-bold")}
              onClick={(event) => changePage(pageIndex, event.currentTarget)}
            >
              {pageNumber}
            </Button>
          );
        })}

        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="다음 페이지"
          disabled={pending || safeCurrentPage === safePageCount - 1}
          onClick={(event) => changePage(safeCurrentPage + 1, event.currentTarget)}
        >
          <ChevronRight aria-hidden />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="마지막 페이지"
          disabled={pending || safeCurrentPage === safePageCount - 1}
          onClick={(event) => changePage(safePageCount - 1, event.currentTarget)}
        >
          <ChevronsRight aria-hidden />
        </Button>
      </div>
      {total ? (
        <p className="text-center text-xs text-muted-foreground">
          총 {total.count}
          {total.unit}
        </p>
      ) : null}
    </nav>
  );
}

export interface PageSizeInputProps {
  readonly value: string;
  readonly onChange: (nextValue: string) => void;
  readonly label: string;
  readonly unit: "종목" | "건";
}

export function PageSizeInput({
  value,
  onChange,
  label,
  unit,
}: PageSizeInputProps) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      페이지당
      <Input
        type="number"
        min={1}
        max={200}
        value={value}
        className="h-8 w-20"
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
      {unit}
    </label>
  );
}
