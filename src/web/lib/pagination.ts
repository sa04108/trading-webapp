export interface PageWindow {
  readonly pageCount: number;
  readonly currentPage: number;
  readonly from: number;
  readonly to: number;
}

export function pageWindow(total: number, pageSize: number, page: number): PageWindow {
  const size = Math.max(1, pageSize);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const from = currentPage * size;
  return { pageCount, currentPage, from, to: Math.min(total, from + size) };
}

export function visiblePageNumbers(
  currentPage: number,
  pageCount: number,
  maxVisible: number,
): number[] {
  const safePageCount = Math.max(1, Math.trunc(pageCount));
  const safeCurrentPage = Math.min(Math.max(0, Math.trunc(currentPage)), safePageCount - 1);
  const visibleCount = Math.min(safePageCount, Math.max(1, Math.trunc(maxVisible)));
  const half = Math.floor(visibleCount / 2);
  const start = Math.min(
    Math.max(0, safeCurrentPage - half),
    safePageCount - visibleCount,
  );

  return Array.from({ length: visibleCount }, (_, index) => start + index + 1);
}

export function pageNumberLimitForWidth(width: number): 5 | 7 | 9 {
  if (width < 640) return 5;
  if (width < 1024) return 7;
  return 9;
}
