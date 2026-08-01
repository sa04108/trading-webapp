/**
 * 페이지 창 계산 — 종목 목록과 데이터셋의 종목 편집이 같은 규칙을 쓴다.
 *
 * `currentPage` 를 따로 돌려주는 이유: 목록이 줄어들면(검색·제거) 보고 있던 페이지가
 * 사라져 빈 화면이 남는다. 그럴 때 마지막 페이지로 당기되 **`page` 자체는 고치지 않는다**
 * — 검색어를 지우면 원래 페이지로 돌아와야 한다. 호출부가 상태를 되쓰지 않도록 계산만
 * 여기서 하고, 규칙이 두 화면에서 갈라지지 않게 한 곳에 둔다.
 */
export interface PageWindow {
  readonly pageCount: number;
  /** 0-based. 목록 길이에 맞게 클램프된 값 */
  readonly currentPage: number;
  readonly from: number;
  readonly to: number;
}

export function pageWindow(total: number, pageSize: number, page: number): PageWindow {
  const size = Math.max(1, pageSize);
  // 빈 목록도 1페이지다 — 0페이지는 「0 / 0 페이지」 같은 표시를 만든다
  const pageCount = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const from = currentPage * size;
  return { pageCount, currentPage, from, to: Math.min(total, from + size) };
}
