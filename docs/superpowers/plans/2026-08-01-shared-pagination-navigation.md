# 공통 게시판형 페이지 이동 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프론트엔드의 기존 페이징 5곳을 처음·이전·반응형 페이지 번호·다음·마지막 버튼이 있는 공통 게시판형 UI로 바꾼다.

**Architecture:** 순수 페이지 계산은 `src/web/lib/pagination.ts`에 둔다. controlled React UI는 `src/web/components/pagination.tsx`에 두고 서버 페이징과 클라이언트 페이징 소비자가 같은 props로 사용한다. 화면별 데이터 조회·검색·정렬·선택 상태는 그대로 유지한다.

**Tech Stack:** TypeScript 5.9, React 19, Tailwind CSS 4, lucide-react, Vitest 4, Playwright 1.62, pnpm 10

## Global Constraints

- 모든 작업은 `C:\Work\trading-webapp\.worktrees\pagination-navigation`의 `feature/shared-pagination-navigation` 브랜치에서 수행한다.
- 기준 설계는 `docs/superpowers/specs/2026-08-01-shared-pagination-navigation-design.md`이다.
- 적용 범위는 종목 목록, 데이터셋 만들기·편집의 종목 선택, 백테스트 거래 내역, 백테스트 경고 목록이다.
- 백테스트 전략·결과 목록과 위저드 단계 버튼은 바꾸지 않는다.
- 내부 페이지 값은 0-based, 화면 번호는 1-based를 유지한다.
- 페이지 번호는 너비 640px 미만에서 5개, 640px 이상 1024px 미만에서 7개, 1024px 이상에서 9개를 표시한다.
- 서버 API, DB 스키마, URL query parameter, 기본 페이지당 표시 수는 바꾸지 않는다.
- 새 runtime·test dependency를 추가하지 않는다. 순수 계산은 Vitest, 렌더링과 상호작용은 Playwright로 검증한다.
- PowerShell 실행 정책 때문에 검증 명령은 `pnpm` 대신 `pnpm.cmd`를 사용한다.
- 한국어 문서·주석은 저장소의 `CLAUDE.md` 규칙을 따른다.

---

## File Map

- Create `src/web/lib/pagination.ts`: 페이지 범위, 표시 번호 창, 화면 너비별 번호 개수를 계산한다.
- Create `src/web/components/pagination.tsx`: 공통 `Pagination`과 `PageSizeInput`을 렌더링한다.
- Create `tests/unit/pagination.test.ts`: 공통 계산 계약을 검증한다.
- Delete `src/web/features/datasets/symbol-paging.ts`: feature 전용 계산을 공통 lib로 대체한다.
- Delete `tests/unit/symbol-paging.test.ts`: 사례를 공통 계산 테스트로 옮긴다.
- Modify `src/web/features/datasets/symbol-list.tsx`: 종목 전용 파일에서 공통 입력·내비게이션 UI를 제거한다.
- Modify `src/web/features/datasets/symbol-check-list.tsx`: 공통 계산과 UI를 사용한다.
- Modify `src/web/features/datasets/symbols-panel.tsx`: 공통 계산과 UI를 사용한다.
- Modify `src/web/features/backtests/backtest-detail-page.tsx`: 거래·경고 페이징을 공통 계산과 UI로 교체한다.
- Modify `tests/e2e/mvp-flow.spec.ts`: 번호 이동, 경계 비활성화, 접근성 상태, mobile overflow를 검증한다.

---

### Task 1: 공통 페이지 계산

**Files:**
- Create: `src/web/lib/pagination.ts`
- Create: `tests/unit/pagination.test.ts`
- Modify: `src/web/features/datasets/symbol-check-list.tsx:14`
- Modify: `src/web/features/datasets/symbols-panel.tsx:44`
- Delete: `src/web/features/datasets/symbol-paging.ts`
- Delete: `tests/unit/symbol-paging.test.ts`

**Interfaces:**
- Consumes: 숫자 `total`, `pageSize`, `page`, `currentPage`, `pageCount`, `maxVisible`, `width`.
- Produces: `PageWindow`, `pageWindow(total, pageSize, page)`, `visiblePageNumbers(currentPage, pageCount, maxVisible)`, `pageNumberLimitForWidth(width)`.

- [ ] **Step 1: 공통 계산의 실패 테스트를 작성한다**

`tests/unit/pagination.test.ts`를 다음 내용으로 만든다. 기존 `symbol-paging.test.ts`의 계약을 모두 옮기고 새 번호 창·breakpoint 계약을 함께 적는다.

```ts
import { describe, expect, it } from 'vitest';
import {
  pageNumberLimitForWidth,
  pageWindow,
  visiblePageNumbers,
} from '../../src/web/lib/pagination.js';

describe('pageWindow', () => {
  it('첫 페이지는 앞에서 pageSize 만큼 자른다', () => {
    expect(pageWindow(100, 10, 0)).toEqual({ pageCount: 10, currentPage: 0, from: 0, to: 10 });
  });

  it('마지막 페이지는 남은 만큼만 자른다', () => {
    expect(pageWindow(95, 10, 9)).toEqual({ pageCount: 10, currentPage: 9, from: 90, to: 95 });
  });

  it('빈 목록도 계산상 1페이지다', () => {
    expect(pageWindow(0, 10, 0)).toEqual({ pageCount: 1, currentPage: 0, from: 0, to: 0 });
  });

  it('빈 목록에서 큰 페이지를 가리켜도 0페이지로 당긴다', () => {
    expect(pageWindow(0, 10, 7)).toEqual({ pageCount: 1, currentPage: 0, from: 0, to: 0 });
  });

  it('나누어떨어지면 빈 마지막 페이지를 만들지 않는다', () => {
    expect(pageWindow(20, 10, 0).pageCount).toBe(2);
    expect(pageWindow(10, 10, 0).pageCount).toBe(1);
  });

  it('목록이 줄어 현재 페이지가 사라지면 마지막 페이지로 당긴다', () => {
    expect(pageWindow(15, 10, 5)).toEqual({ pageCount: 2, currentPage: 1, from: 10, to: 15 });
  });

  it('음수 page와 0 이하 pageSize를 유효 범위로 올린다', () => {
    expect(pageWindow(100, 10, -3).currentPage).toBe(0);
    expect(pageWindow(3, 0, 0)).toEqual({ pageCount: 3, currentPage: 0, from: 0, to: 1 });
    expect(pageWindow(3, -5, 2)).toEqual({ pageCount: 3, currentPage: 2, from: 2, to: 3 });
  });

  it('페이지당 표시 수가 목록보다 크면 한 페이지에 전부 담는다', () => {
    expect(pageWindow(7, 200, 0)).toEqual({ pageCount: 1, currentPage: 0, from: 0, to: 7 });
  });

  it('1000종목을 10개씩 나누면 100페이지다', () => {
    expect(pageWindow(1000, 10, 99)).toEqual({
      pageCount: 100,
      currentPage: 99,
      from: 990,
      to: 1000,
    });
  });
});

describe('visiblePageNumbers', () => {
  it('전체 페이지가 최대 개수보다 적으면 모든 번호를 표시한다', () => {
    expect(visiblePageNumbers(0, 4, 5)).toEqual([1, 2, 3, 4]);
  });

  it('처음 구간은 1페이지에 붙인다', () => {
    expect(visiblePageNumbers(1, 100, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('중간 구간은 현재 페이지를 가운데에 둔다', () => {
    expect(visiblePageNumbers(49, 100, 9)).toEqual([46, 47, 48, 49, 50, 51, 52, 53, 54]);
  });

  it('마지막 구간은 전체 페이지 수에 붙인다', () => {
    expect(visiblePageNumbers(98, 100, 9)).toEqual([92, 93, 94, 95, 96, 97, 98, 99, 100]);
  });

  it('범위를 벗어난 현재 페이지를 먼저 제한한다', () => {
    expect(visiblePageNumbers(-4, 10, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(visiblePageNumbers(50, 10, 5)).toEqual([6, 7, 8, 9, 10]);
  });
});

describe('pageNumberLimitForWidth', () => {
  it('640px과 1024px 경계에서 5·7·9개를 선택한다', () => {
    expect(pageNumberLimitForWidth(639)).toBe(5);
    expect(pageNumberLimitForWidth(640)).toBe(7);
    expect(pageNumberLimitForWidth(1023)).toBe(7);
    expect(pageNumberLimitForWidth(1024)).toBe(9);
  });
});
```

- [ ] **Step 2: 새 모듈이 없어서 테스트가 실패하는지 확인한다**

Run:

```powershell
pnpm.cmd exec vitest run tests/unit/pagination.test.ts
```

Expected: FAIL. `../../src/web/lib/pagination.js`를 찾지 못한다.

- [ ] **Step 3: 공통 계산을 최소 구현한다**

`src/web/lib/pagination.ts`를 다음 내용으로 만든다.

```ts
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
```

두 종목 소비자의 import를 다음처럼 바꾼다.

```ts
import { pageWindow } from '@/lib/pagination';
```

`src/web/features/datasets/symbol-paging.ts`와 `tests/unit/symbol-paging.test.ts`는 새 공통 파일과 테스트에 내용이 모두 옮겨졌으므로 삭제한다.

- [ ] **Step 4: 공통 계산 테스트와 웹 typecheck가 통과하는지 확인한다**

Run:

```powershell
pnpm.cmd exec vitest run tests/unit/pagination.test.ts
pnpm.cmd typecheck
```

Expected: pagination 테스트 전체 PASS, server·web typecheck 모두 exit 0.

- [ ] **Step 5: 공통 계산을 커밋한다**

```powershell
git add src/web/lib/pagination.ts src/web/features/datasets/symbol-check-list.tsx src/web/features/datasets/symbols-panel.tsx tests/unit/pagination.test.ts
git add -u -- src/web/features/datasets/symbol-paging.ts tests/unit/symbol-paging.test.ts
git commit -m "refactor(web): 페이지 계산을 공통 모듈로 옮긴다"
```

---

### Task 2: 공통 페이지 UI와 종목 화면 적용

**Files:**
- Create: `src/web/components/pagination.tsx`
- Modify: `src/web/features/datasets/symbol-list.tsx:1-5,279-340`
- Modify: `src/web/features/datasets/symbol-check-list.tsx:4-14,114-122,203-208`
- Modify: `src/web/features/datasets/symbols-panel.tsx:30-44,285-293,398-403`
- Modify: `tests/e2e/mvp-flow.spec.ts:248-270`

**Interfaces:**
- Consumes: Task 1의 `visiblePageNumbers(currentPage, pageCount, maxVisible)`와 `pageNumberLimitForWidth(width)`.
- Produces: `PaginationProps`, `Pagination`, `PageSizeInputProps`, `PageSizeInput`.

- [ ] **Step 1: 종목 선택 화면의 실패 E2E를 작성한다**

`tests/e2e/mvp-flow.spec.ts`의 데이터셋 편집 페이징 블록을 다음 흐름으로 바꾼다. 기존 전체·페이지내 선택 assertion은 유지하고 이동 assertion만 새 UI 계약으로 교체한다.

```ts
  await pagedDialog.getByLabel('종목 선택 페이지당 표시 수').fill('1');
  await expect(pagedDialog.getByText('총 3종목')).toBeVisible();
  await expect(pagedDialog.getByRole('checkbox')).toHaveCount(1);

  const pagination = pagedDialog.getByRole('navigation', { name: '종목 선택 페이지 이동' });
  const currentPage = pagination.getByRole('button', { name: '현재 1페이지' });
  await expect(currentPage).toHaveAttribute('aria-current', 'page');
  await expect(currentPage).toHaveClass(/font-bold/);
  await expect(pagination.getByRole('button', { name: '첫 페이지' })).toBeDisabled();
  await expect(pagination.getByRole('button', { name: '이전 페이지' })).toBeDisabled();

  const paginationOverflow = await pagination.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(paginationOverflow, '종목 선택 페이지 이동 가로 스크롤').toBeLessThanOrEqual(0);

  await expect(pagedDialog.getByRole('button', { name: '페이지내 해제' })).toBeVisible();
  await pagination.getByRole('button', { name: '2페이지로 이동' }).click();
  await expect(pagination.getByRole('button', { name: '현재 2페이지' })).toBeVisible();
  await pagedDialog.getByRole('button', { name: '페이지내 전체 선택' }).click();
  await expect(pagedDialog.getByText('2개 선택')).toBeVisible();

  await pagination.getByRole('button', { name: '마지막 페이지' }).click();
  await expect(pagination.getByRole('button', { name: '현재 3페이지' })).toBeVisible();
  await expect(pagination.getByRole('button', { name: '다음 페이지' })).toBeDisabled();
  await expect(pagination.getByRole('button', { name: '마지막 페이지' })).toBeDisabled();

  await pagedDialog.getByRole('button', { name: '전체 선택' }).click();
  await expect(pagedDialog.getByText('3개 선택')).toBeVisible();
```

- [ ] **Step 2: 기존 UI에는 navigation과 번호 버튼이 없어 E2E가 실패하는지 확인한다**

Run:

```powershell
pnpm.cmd build
pnpm.cmd exec playwright test tests/e2e/mvp-flow.spec.ts --project=mobile --grep "full MVP flow"
```

Expected: FAIL. `종목 선택 페이지 이동` navigation을 찾지 못한다.

- [ ] **Step 3: 공통 `Pagination`과 `PageSizeInput`을 구현한다**

`src/web/components/pagination.tsx`를 다음 내용으로 만든다.

```tsx
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { pageNumberLimitForWidth, visiblePageNumbers } from '@/lib/pagination';
import { cn } from '@/lib/utils';

export interface PaginationProps {
  readonly currentPage: number;
  readonly pageCount: number;
  readonly onPageChange: (nextPage: number) => void;
  readonly ariaLabel: string;
  readonly total?: { readonly count: number; readonly unit: string };
  readonly className?: string;
}

function usePageNumberLimit(): 5 | 7 | 9 {
  const [limit, setLimit] = useState<5 | 7 | 9>(5);

  useEffect(() => {
    const update = (): void => setLimit(pageNumberLimitForWidth(window.innerWidth));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return limit;
}

export function Pagination({
  currentPage,
  pageCount,
  onPageChange,
  ariaLabel,
  total,
  className,
}: PaginationProps) {
  const maxVisible = usePageNumberLimit();
  const safePageCount = Math.max(1, Math.trunc(pageCount));
  const safeCurrentPage = Math.min(Math.max(0, Math.trunc(currentPage)), safePageCount - 1);

  if (safePageCount <= 1) return null;

  const pageNumbers = visiblePageNumbers(safeCurrentPage, safePageCount, maxVisible);
  const changePage = (nextPage: number): void => {
    onPageChange(Math.min(Math.max(0, nextPage), safePageCount - 1));
  };

  return (
    <nav aria-label={ariaLabel} className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="첫 페이지"
          disabled={safeCurrentPage === 0}
          onClick={() => changePage(0)}
        >
          <ChevronsLeft aria-hidden />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="이전 페이지"
          disabled={safeCurrentPage === 0}
          onClick={() => changePage(safeCurrentPage - 1)}
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
              variant={isCurrent ? 'secondary' : 'ghost'}
              size="icon"
              aria-label={isCurrent ? `현재 ${pageNumber}페이지` : `${pageNumber}페이지로 이동`}
              aria-current={isCurrent ? 'page' : undefined}
              className={cn('text-xs tabular-nums', isCurrent && 'font-bold')}
              onClick={() => changePage(pageIndex)}
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
          disabled={safeCurrentPage === safePageCount - 1}
          onClick={() => changePage(safeCurrentPage + 1)}
        >
          <ChevronRight aria-hidden />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="마지막 페이지"
          disabled={safeCurrentPage === safePageCount - 1}
          onClick={() => changePage(safePageCount - 1)}
        >
          <ChevronsRight aria-hidden />
        </Button>
      </div>
      {total ? (
        <p className="text-center text-xs text-muted-foreground">
          총 {total.count}{total.unit}
        </p>
      ) : null}
    </nav>
  );
}

export interface PageSizeInputProps {
  readonly value: string;
  readonly onChange: (nextValue: string) => void;
  readonly label: string;
  readonly unit: '종목' | '건';
}

export function PageSizeInput({ value, onChange, label, unit }: PageSizeInputProps) {
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
```

- [ ] **Step 4: 종목 소비자를 공통 UI로 교체한다**

`symbol-list.tsx`에서 `Button` import와 `PageSizeInput`·`PageNav` 함수 전체를 제거한다. 검색 입력이 `Input`을 계속 쓰므로 `Input` import는 남긴다.

`symbol-check-list.tsx`와 `symbols-panel.tsx`에 다음 import를 추가하고 `symbol-list.tsx` import 목록에서는 `PageNav`와 `PageSizeInput`을 뺀다.

```ts
import { PageSizeInput, Pagination } from '@/components/pagination';
```

두 파일의 페이지당 입력에 `unit="종목"`을 추가한다. `SymbolCheckList`의 이동 UI는 다음으로 바꾼다.

```tsx
      <Pagination
        ariaLabel="종목 선택 페이지 이동"
        currentPage={currentPage}
        pageCount={pageCount}
        total={{ count: filtered.length, unit: '종목' }}
        onPageChange={setPage}
      />
```

`SymbolsPanel`의 이동 UI는 다음으로 바꾼다.

```tsx
      <Pagination
        ariaLabel="종목 목록 페이지 이동"
        currentPage={currentPage}
        pageCount={pageCount}
        total={{ count: filtered.length, unit: '종목' }}
        onPageChange={setPage}
      />
```

- [ ] **Step 5: 종목 화면 검증을 실행한다**

Run:

```powershell
pnpm.cmd exec vitest run tests/unit/pagination.test.ts tests/unit/page-size.test.ts
pnpm.cmd typecheck
pnpm.cmd build
pnpm.cmd exec playwright test tests/e2e/mvp-flow.spec.ts --project=mobile --grep "full MVP flow"
```

Expected: 두 unit 파일 PASS, typecheck·build exit 0, mobile `full MVP flow` PASS.

- [ ] **Step 6: 공통 UI와 종목 화면 적용을 커밋한다**

```powershell
git add src/web/components/pagination.tsx src/web/features/datasets/symbol-list.tsx src/web/features/datasets/symbol-check-list.tsx src/web/features/datasets/symbols-panel.tsx tests/e2e/mvp-flow.spec.ts
git commit -m "feat(web): 게시판형 페이지 이동을 종목 화면에 적용한다"
```

---

### Task 3: 백테스트 상세 적용과 전체 검증

**Files:**
- Modify: `src/web/features/backtests/backtest-detail-page.tsx:1-44,112-371`
- Modify: `tests/e2e/mvp-flow.spec.ts:114-140`

**Interfaces:**
- Consumes: Task 1의 `pageWindow`, Task 2의 `Pagination`과 `PageSizeInput`.
- Produces: 거래 내역·경고 목록의 공통 페이지 이동 UI. 새 export는 만들지 않는다.

- [ ] **Step 1: 거래 내역과 경고 목록의 실패 E2E를 작성한다**

`tests/e2e/mvp-flow.spec.ts`에서 거래 행을 확인한 뒤 다음 assertion을 넣는다. E2E fixture는 거래 20건과 서로 다른 경고 2건을 만들므로 기본 거래 페이지는 2개이고 경고 페이지당 값을 1로 바꾸면 2페이지가 된다.

```ts
  const tradesPagination = page.getByRole('navigation', {
    name: '거래 내역 페이지 이동',
  });
  await expect(tradesPagination.getByRole('button', { name: '현재 1페이지' })).toBeVisible();
  await tradesPagination.getByRole('button', { name: '마지막 페이지' }).click();
  await expect(tradesPagination.getByRole('button', { name: '현재 2페이지' })).toBeVisible();
  await tradesPagination.getByRole('button', { name: '첫 페이지' }).click();
  await expect(tradesPagination.getByRole('button', { name: '현재 1페이지' })).toBeVisible();

  await expect(page.getByRole('navigation', { name: '경고 목록 페이지 이동' })).toHaveCount(0);
  await page.getByLabel('경고 목록 페이지당 표시 수').fill('1');
  const warningsPagination = page.getByRole('navigation', {
    name: '경고 목록 페이지 이동',
  });
  await expect(warningsPagination.getByRole('button', { name: '현재 1페이지' })).toBeVisible();
  await warningsPagination.getByRole('button', { name: '2페이지로 이동' }).click();
  await expect(warningsPagination.getByRole('button', { name: '현재 2페이지' })).toBeVisible();
```

- [ ] **Step 2: 백테스트 상세가 아직 공통 UI를 쓰지 않아 E2E가 실패하는지 확인한다**

Run:

```powershell
pnpm.cmd build
pnpm.cmd exec playwright test tests/e2e/mvp-flow.spec.ts --project=mobile --grep "full MVP flow"
```

Expected: FAIL. `거래 내역 페이지 이동` navigation을 찾지 못한다.

- [ ] **Step 3: 거래 내역과 경고 목록을 공통 UI로 교체한다**

`backtest-detail-page.tsx`에서 `Input` import를 제거하고 다음 import를 추가한다. `Button`은 상세 화면의 다른 동작에 계속 쓰므로 남긴다.

```ts
import { PageSizeInput, Pagination } from '@/components/pagination';
import { pageWindow } from '@/lib/pagination';
```

거래 내역의 직접 작성한 label·`Input`을 다음으로 바꾼다.

```tsx
          <PageSizeInput
            value={pageSizeText}
            label="거래 내역 페이지당 표시 수"
            unit="건"
            onChange={(nextValue) => {
              setPageSizeText(nextValue);
              setPage(0);
            }}
          />
```

거래 내역 하단의 이전·현재/전체·다음 묶음을 다음으로 바꾼다.

```tsx
        <Pagination
          className="mt-3"
          ariaLabel="거래 내역 페이지 이동"
          currentPage={page}
          pageCount={pageCount}
          onPageChange={setPage}
        />
```

경고 목록의 페이지 계산을 공통 함수로 바꾼다.

```ts
  const rows = grouped ? groupWarnings(warnings).map((group) => group.label) : warnings;
  const { pageCount, currentPage, from, to } = pageWindow(rows.length, pageSize, page);
  const visible = rows.slice(from, to);
```

경고 목록의 직접 작성한 label·`Input`을 다음으로 바꾼다.

```tsx
          <PageSizeInput
            value={pageSizeText}
            label="경고 목록 페이지당 표시 수"
            unit="건"
            onChange={(nextValue) => {
              setPageSizeText(nextValue);
              setPage(0);
            }}
          />
```

경고 목록 하단의 조건부 이전·현재/전체·다음 묶음을 다음으로 바꾼다. `Pagination`이 1페이지일 때 스스로 숨으므로 호출부 조건은 두지 않는다.

```tsx
        <Pagination
          className="mt-3"
          ariaLabel="경고 목록 페이지 이동"
          currentPage={currentPage}
          pageCount={pageCount}
          onPageChange={setPage}
        />
```

- [ ] **Step 4: 백테스트 상세 E2E가 통과하는지 확인한다**

Run:

```powershell
pnpm.cmd typecheck
pnpm.cmd build
pnpm.cmd exec playwright test tests/e2e/mvp-flow.spec.ts --project=mobile --grep "full MVP flow"
```

Expected: typecheck·build exit 0, mobile `full MVP flow` PASS.

- [ ] **Step 5: 전체 정적·단위·통합 검증을 실행한다**

Run:

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
```

Expected: 모든 명령 exit 0. Vitest는 최소 기준선인 82개 test file·814개 test보다 줄지 않고 새 pagination 사례가 추가된다.

- [ ] **Step 6: 두 지원 viewport의 전체 E2E를 실행한다**

Run:

```powershell
pnpm.cmd test:e2e
```

Expected: mobile 390×844와 desktop 1440×900 프로젝트 모두 PASS. mobile 전용 overflow 검증도 PASS.

- [ ] **Step 7: 중복 제거와 diff 상태를 확인한다**

Run:

```powershell
rg -n "PageNav|^\s*(이전|다음)\s*$| / .* 페이지" src/web/features/datasets src/web/features/backtests/backtest-detail-page.tsx
git diff --check
git status --short
```

Expected: 첫 명령은 기존 페이징 UI 중복을 찾지 못한다. `git diff --check`는 출력 없이 exit 0이다. status에는 Task 3의 두 수정 파일만 표시된다.

- [ ] **Step 8: 백테스트 상세 적용을 커밋한다**

```powershell
git add src/web/features/backtests/backtest-detail-page.tsx tests/e2e/mvp-flow.spec.ts
git commit -m "feat(web): 공통 페이지 이동을 백테스트 상세에 적용한다"
```
