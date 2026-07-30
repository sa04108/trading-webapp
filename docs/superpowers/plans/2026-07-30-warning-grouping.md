# 경고 그룹핑·페이지네이션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스트 상세의 경고·한계 목록을 같은 종류끼리 묶어 보고(기본 켜짐), 페이지네이션(페이지당 표시 수 입력, 기본 20)으로 탐색한다.

**Architecture:** 프론트엔드만 (스펙 `docs/superpowers/specs/2026-07-30-warning-grouping-design.md`). 그룹핑은 순수 헬퍼로 분리해 단위 테스트하고, `RunMetadataCard` 의 경고 Alert 는 헬퍼 결과를 그린다.

**Tech Stack:** React 19 + TypeScript, shadcn/ui (Checkbox·Input·Button 존재 확인됨), vitest.

## Global Constraints

- 순수 헬퍼·테스트 파일은 `@/` 별칭 금지 (vitest 별칭 없음) — 상대 경로 + `.js` 확장자.
- 화면 문자열 한국어. 체크박스 라벨은 정확히 `묶어 보기`, 기본 **켜짐**.
- 페이지당 표시 수 기본 20, 1~200 클램프.
- 검증: `pnpm test && pnpm typecheck && pnpm lint`.
- 커밋: `type(scope): 한국어 서술형`.

---

### Task 1: 그룹핑 헬퍼

**Files:**
- Create: `src/web/features/backtests/warning-groups.ts`
- Test: `tests/unit/warning-groups.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `groupWarnings(warnings: readonly string[]): Array<{ label: string; count: number }>` — Task 2 가 사용. count > 1 이면 label = `정규화 메시지 (N건)`, count = 1 이면 label = 원본.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/warning-groups.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { groupWarnings } from '../../src/web/features/backtests/warning-groups.js';

describe('groupWarnings', () => {
  it('종목·시각만 다른 현금 부족 경고를 한 그룹으로 묶고 건수를 센다', () => {
    const groups = groupWarnings([
      '005930 매수 거부: 현금 부족 (2026-01-03T05:00:00.000Z)',
      '000660 매수 거부: 현금 부족 (2026-01-04T02:30:00.000Z)',
      '005930 매수 거부: 현금 부족 (2026-01-05T01:00:00.000Z)',
    ]);
    expect(groups).toEqual([{ label: '매수 거부: 현금 부족 (3건)', count: 3 }]);
  });

  it('1회성 요약 라인은 원본 그대로 count 1 로 남는다', () => {
    const original = '기간 종료 시점에 미청산 포지션 1건이 남아 있습니다 (평가금액에는 반영됨).';
    expect(groupWarnings([original])).toEqual([{ label: original, count: 1 }]);
  });

  it('그룹 순서는 첫 등장 순서를 따른다', () => {
    const groups = groupWarnings([
      '생존 편향, 공휴일 캘린더, 배당, 권리락은 이 백테스트에서 보정하지 않습니다.',
      '005930 매수 거부: 현금 부족 (2026-01-03T05:00:00.000Z)',
      '000660 매수 거부: 현금 부족 (2026-01-04T02:30:00.000Z)',
    ]);
    expect(groups.map((g) => g.count)).toEqual([1, 2]);
    expect(groups[0]?.label).toContain('생존 편향');
  });

  it('빈 배열이면 빈 배열', () => {
    expect(groupWarnings([])).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/unit/warning-groups.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/web/features/backtests/warning-groups.ts`:

```ts
/**
 * 경고 목록을 같은 종류끼리 묶는다 (설계 2026-07-30-warning-grouping-design.md).
 * 정규화 키 = ISO 타임스탬프 괄호와 종목 코드 프리픽스를 지운 문자열.
 * 한글로 시작하는 1회성 요약 라인은 두 패턴에 걸리지 않아 자기 자신이 키다.
 */
const TIMESTAMP_PAREN = /\s*\(\d{4}-\d{2}-\d{2}T[^)]*\)/g;
const SYMBOL_PREFIX = /^[A-Za-z0-9._-]{1,20} /;

function normalize(warning: string): string {
  return warning.replace(TIMESTAMP_PAREN, '').replace(SYMBOL_PREFIX, '').trim();
}

export function groupWarnings(
  warnings: readonly string[],
): Array<{ label: string; count: number }> {
  const byKey = new Map<string, { first: string; count: number }>();
  for (const warning of warnings) {
    const key = normalize(warning);
    const entry = byKey.get(key);
    if (entry) entry.count += 1;
    else byKey.set(key, { first: warning, count: 1 });
  }
  return [...byKey.entries()].map(([key, { first, count }]) => ({
    label: count > 1 ? `${key} (${count}건)` : first,
    count,
  }));
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/unit/warning-groups.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/backtests/warning-groups.ts tests/unit/warning-groups.test.ts
git commit -m "feat(web): 백테스트 경고를 종류별로 묶는 헬퍼를 만든다"
```

---

### Task 2: 경고 Alert UI — 묶어 보기 + 페이지네이션

**Files:**
- Modify: `src/web/features/backtests/backtest-detail-page.tsx` (`RunMetadataCard` 의 경고 Alert, 현재 `:353-364`)

**Interfaces:**
- Consumes: `groupWarnings` (Task 1), shadcn `Checkbox`(`@/components/ui/checkbox`)·`Input`·`Label`·`Button` (모두 존재 확인됨)

- [ ] **Step 1: WarningsSection 컴포넌트 추가**

경고 렌더링을 `RunMetadataCard` 에서 새 내부 컴포넌트로 옮긴다. `backtest-detail-page.tsx` 에 추가 (컴포넌트는 파일 내 `RunMetadataCard` 위):

```tsx
function WarningsSection({ warnings }: { warnings: string[] }) {
  const [grouped, setGrouped] = useState(true);
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState('20');
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(pageSizeText, 10) || 20));

  const rows = grouped ? groupWarnings(warnings).map((g) => g.label) : warnings;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  return (
    <Alert className="lg:col-span-2">
      <AlertTitle>경고·한계</AlertTitle>
      <AlertDescription>
        <div className="mb-2 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={grouped}
              onCheckedChange={(checked) => {
                setGrouped(checked === true);
                setPage(0);
              }}
            />
            묶어 보기
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            페이지당
            <Input
              type="number"
              min={1}
              max={200}
              value={pageSizeText}
              onChange={(e) => {
                setPageSizeText(e.target.value);
                setPage(0);
              }}
              className="h-8 w-20"
              aria-label="페이지당 표시 수"
            />
            건
          </label>
        </div>
        <ul className="list-disc space-y-1 pl-4">
          {visible.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
        {pageCount > 1 ? (
          <div className="mt-3 flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              이전
            </Button>
            <span className="text-xs text-muted-foreground">
              {currentPage + 1} / {pageCount} 페이지
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              다음
            </Button>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
```

import 추가: `import { Checkbox } from '@/components/ui/checkbox';`, `import { Input } from '@/components/ui/input';`, `import { groupWarnings } from './warning-groups';` (Input 이 이미 import 돼 있으면 생략).

- [ ] **Step 2: 기존 Alert 교체**

`RunMetadataCard` 의 기존 블록:

```tsx
{warnings.length > 0 ? (
  <Alert className="lg:col-span-2">
    <AlertTitle>경고·한계</AlertTitle>
    <AlertDescription>
      <ul className="list-disc space-y-1 pl-4">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </AlertDescription>
  </Alert>
) : null}
```

를 다음으로 교체:

```tsx
{warnings.length > 0 ? <WarningsSection warnings={warnings} /> : null}
```

- [ ] **Step 3: 검증**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: 전부 PASS

- [ ] **Step 4: 수동 확인**

경고 많은 백테스트 상세: 기본 묶여서 `매수 거부: 현금 부족 (N건)` 한 줄, 체크 해제 시 원본 페이지 단위(기본 20), 페이지당 수 변경·이전/다음 동작.

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/backtests/backtest-detail-page.tsx
git commit -m "feat(web): 경고 목록에 묶어 보기와 페이지네이션을 붙인다"
```
