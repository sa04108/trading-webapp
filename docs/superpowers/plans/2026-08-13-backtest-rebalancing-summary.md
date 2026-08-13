# Backtest Rebalancing Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 단계별 종목 수(N)를 입력 완료 시 복구·clamp하고, 백테스트 결과의 종목별 성과와 단계별 통과 진단을 종목 리밸런싱 요약으로 교체한다.

**Architecture:** 단계 N은 각 입력이 문자열 초안을 소유하고 유효한 정수만 기존 `UniverseStage` 상태로 올린다. 서버는 제출 시점에 고정된 `universeScheduleJson`을 집합 비교해 작은 리밸런싱 DTO로 만들며, 결과 화면은 이 DTO만 받아 최초 구성과 편입·편출 수를 표시한다. 전체 멤버십과 provenance 단계 진단 저장 구조는 바꾸지 않는다.

**Tech Stack:** TypeScript 5.9, React 19, Fastify 5, Vitest 4, Playwright 1.62, pnpm 10

## Global Constraints

- 단계 N 입력은 편집 중 빈 문자열과 범위 밖 정수를 그대로 표시한다.
- 빈 문자열 또는 정수가 아닌 값은 blur에서 직전 유효값으로 복구한다.
- 정수는 blur에서 `1`부터 현재 단계 상한 사이로 clamp한다.
- 첫 단계 상한은 `200`, 이후 단계 상한은 직전 단계의 확정된 N이다.
- 기존 단계 cascade, 리밸런스 주기 입력, 급락 조회기간 입력 정책은 바꾸지 않는다.
- 첫 리밸런스 행은 `최초 구성 N종목`으로 표시한다.
- 이후 행의 변동 종목 수는 `편입 수 + 편출 수`이다.
- 편입 숫자는 `text-gain`, 편출 숫자는 `text-loss`, 합계는 기본 글자색을 쓴다.
- `편입`·`편출` 문구를 항상 함께 표시해 색상만으로 뜻을 전달하지 않는다.
- 전체 멤버 목록은 상세 API 응답에 노출하지 않는다.
- provenance pin과 `universeScheduleJson` 저장 형식, DB schema는 바꾸지 않는다.
- 이번 변경으로 직접 참조가 사라진 컴포넌트, 함수, import, 주석, 테스트 보조 코드만 함께 제거한다.
- 관련 없는 refactoring은 하지 않는다.

---

### Task 1: 단계 N 문자열 초안과 blur 보정

**Files:**
- Modify: `tests/unit/universe-pipeline.test.ts`
- Modify: `tests/e2e/universe-pipeline.spec.ts`
- Modify: `src/web/features/backtests/universe-pipeline.ts:89-99`
- Modify: `src/web/features/backtests/universe-stage-editor.tsx:1-185`

**Interfaces:**
- Consumes: `parseStageLimitInput(raw: string, maxLimit: number): number | null`, `changeStageLimit(stages, index, limit): PipelineUpdate`.
- Produces: `normalizeStageLimitInput(raw: string, fallback: number, maxLimit: number): number`; 내부 `StageLimitInput` 컴포넌트는 `value`, `max`, `highlighted`, `onValueChange`를 받는다.

- [ ] **Step 1: blur 정규화의 실패 단위 테스트를 작성한다**

`tests/unit/universe-pipeline.test.ts`의 import에 `normalizeStageLimitInput`을 추가하고 다음 suite를 끝에 붙인다.

```typescript
describe('normalizeStageLimitInput', () => {
  it('빈 값과 정수가 아닌 값은 직전 유효값을 복구한다', () => {
    expect(normalizeStageLimitInput('', 37, 200)).toBe(37);
    expect(normalizeStageLimitInput('1.5', 37, 200)).toBe(37);
  });

  it('범위 밖 정수는 1과 현재 단계 상한으로 clamp한다', () => {
    expect(normalizeStageLimitInput('0', 37, 200)).toBe(1);
    expect(normalizeStageLimitInput('-5', 37, 200)).toBe(1);
    expect(normalizeStageLimitInput('500', 37, 200)).toBe(200);
    expect(normalizeStageLimitInput('81', 37, 80)).toBe(80);
  });

  it('범위 안 정수는 그대로 확정한다', () => {
    expect(normalizeStageLimitInput('42', 37, 200)).toBe(42);
  });
});
```

- [ ] **Step 2: 단위 테스트가 올바른 이유로 실패하는지 확인한다**

Run:

```bash
pnpm test tests/unit/universe-pipeline.test.ts
```

Expected: FAIL. `normalizeStageLimitInput` export가 아직 없어 import 또는 호출 지점에서 실패한다.

- [ ] **Step 3: 순수 blur 정규화 함수를 최소 구현한다**

`src/web/features/backtests/universe-pipeline.ts`의 `parseStageLimitInput` 아래에 추가한다.

```typescript
export function normalizeStageLimitInput(
  raw: string,
  fallback: number,
  maxLimit: number,
): number {
  const text = raw.trim();
  if (text === '') return fallback;
  const n = Number(text);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(maxLimit, Math.max(1, n));
}
```

- [ ] **Step 4: 정규화 단위 테스트가 통과하는지 확인한다**

Run:

```bash
pnpm test tests/unit/universe-pipeline.test.ts
```

Expected: PASS.

- [ ] **Step 5: 실제 입력 생명주기의 실패 브라우저 테스트를 작성한다**

`tests/e2e/universe-pipeline.spec.ts`에서 리밸런스 주기 입력 테스트 다음에 아래 test를 추가한다.

```typescript
test('단계별 N 입력은 편집 중 임시값을 허용하고 blur에서 복구·clamp한다', async ({
  page,
}) => {
  await login(page);
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('시작일').fill('2026-01-01');
  await page.getByLabel('종료일').fill('2026-12-31');
  await page.getByRole('button', { name: '다음' }).click();

  const first = page.locator('#stage-limit-0');
  await expect(first).toHaveValue('200');
  await first.fill('');
  await expect(first).toHaveValue('');
  await first.fill('500');
  await expect(first).toHaveValue('500');
  await first.blur();
  await expect(first).toHaveValue('200');

  await first.fill('50');
  await page.getByRole('button', { name: 'PER 단계 추가' }).click();
  const second = page.locator('#stage-limit-1');
  await expect(second).toHaveValue('50');
  await second.fill('99');
  await expect(second).toHaveValue('99');
  await second.blur();
  await expect(second).toHaveValue('50');

  await first.fill('0');
  await expect(first).toHaveValue('0');
  await first.blur();
  await expect(first).toHaveValue('1');
  await expect(second).toHaveValue('1');
  await expect(
    page.getByText('앞 단계 N을 넘지 않도록 뒤 단계 값을 함께 조정했습니다.'),
  ).toBeVisible();

  await first.fill('37');
  await first.fill('');
  await first.blur();
  await expect(first).toHaveValue('37');
});
```

- [ ] **Step 6: 브라우저 테스트가 현재 제어 입력 버그를 잡는지 확인한다**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop --grep "단계별 N 입력은"
```

Expected: FAIL at the first empty-value assertion. 현재 입력은 `stage.limit`에 직접 묶여 빈 문자열을 즉시 `200`으로 되돌린다.

- [ ] **Step 7: 단계마다 문자열 초안을 갖는 입력 컴포넌트를 구현한다**

`src/web/features/backtests/universe-stage-editor.tsx` import에 `normalizeStageLimitInput`을 추가하고 `UniverseStageEditor` 위에 다음 내부 컴포넌트를 둔다.

```tsx
function StageLimitInput({
  index,
  value,
  max,
  highlighted,
  onValueChange,
}: {
  index: number;
  value: number;
  max: number;
  highlighted: boolean;
  onValueChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  return (
    <Input
      id={`stage-limit-${index}`}
      name="limit"
      type="number"
      inputMode="numeric"
      className={cn('h-8 w-24', highlighted && 'ring-2 ring-amber-400')}
      min={1}
      max={max}
      value={text}
      onChange={(event) => {
        const nextText = event.target.value;
        setText(nextText);
        const parsed = parseStageLimitInput(nextText, max);
        if (parsed !== null) onValueChange(parsed);
      }}
      onBlur={() => {
        const normalized = normalizeStageLimitInput(text, value, max);
        setText(String(normalized));
        if (normalized !== value) onValueChange(normalized);
      }}
    />
  );
}
```

기존 N `<Input>`을 아래 호출로 바꾼다. `onValueChange`는 기존 `applyUpdate(changeStageLimit(...))` 경로를 그대로 써 cascade와 2초 강조를 유지한다.

```tsx
<StageLimitInput
  index={index}
  value={stage.limit}
  max={maxLimit}
  highlighted={isHighlighted}
  onValueChange={(nextLimit) =>
    applyUpdate(changeStageLimit(stages, index, nextLimit))
  }
/>
```

- [ ] **Step 8: 입력 테스트와 기존 단계 편집기 회귀 테스트를 통과시킨다**

Run:

```bash
pnpm test tests/unit/universe-pipeline.test.ts tests/unit/universe-stage-editor-markup.test.tsx
pnpm build
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop --grep "단계별 N 입력은"
```

Expected: all PASS.

- [ ] **Step 9: 단계 N 입력 변경을 커밋한다**

```bash
git add tests/unit/universe-pipeline.test.ts tests/e2e/universe-pipeline.spec.ts src/web/features/backtests/universe-pipeline.ts src/web/features/backtests/universe-stage-editor.tsx
git commit -m "fix(web): 단계별 종목 수를 blur에서 보정한다"
```

---

### Task 2: 저장된 멤버십 일정의 리밸런싱 요약

**Files:**
- Create: `src/shared/schemas/universe-rebalancing.ts`
- Create: `src/server/modules/backtest/application/universe-rebalancing.ts`
- Create: `tests/unit/universe-rebalancing.test.ts`

**Interfaces:**
- Consumes: `LegacyUniverseScheduleEntry`의 `rebalanceDate`, `effectiveTradingDate`, `symbols`.
- Produces: shared `UniverseRebalancingEntryDto` union과 `summarizeUniverseRebalancing(schedule): UniverseRebalancingEntryDto[]`.

- [ ] **Step 1: 최초 구성·편입·편출 집합 계산의 실패 테스트를 작성한다**

`tests/unit/universe-rebalancing.test.ts`를 만든다.

```typescript
import { describe, expect, it } from 'vitest';
import {
  summarizeUniverseRebalancing,
} from '../../src/server/modules/backtest/application/universe-rebalancing.js';
import type {
  LegacyUniverseScheduleEntry,
} from '../../src/server/modules/backtest/application/universe-rule-resolver.js';

function scheduleEntry(
  rebalanceDate: string,
  effectiveTradingDate: string,
  symbols: readonly string[],
): LegacyUniverseScheduleEntry {
  return { rebalanceDate, effectiveTradingDate, symbols, excludedNonTradingCount: 0 };
}

describe('summarizeUniverseRebalancing', () => {
  it('첫 일정은 중복 code를 한 번만 센 최초 구성이다', () => {
    expect(
      summarizeUniverseRebalancing([
        scheduleEntry('2026-01-05', '2026-01-02', ['A', 'B', 'B']),
      ]),
    ).toEqual([
      {
        kind: 'INITIAL',
        rebalanceDate: '2026-01-05',
        effectiveDate: '2026-01-02',
        memberCount: 2,
      },
    ]);
  });

  it('같은 크기 교체는 편입과 편출을 각각 세고 합산한다', () => {
    const result = summarizeUniverseRebalancing([
      scheduleEntry('2026-01-05', '2026-01-05', ['A', 'B', 'C']),
      scheduleEntry('2026-02-05', '2026-02-05', ['B', 'C', 'D']),
    ]);
    expect(result[1]).toEqual({
      kind: 'CHANGE',
      rebalanceDate: '2026-02-05',
      effectiveDate: '2026-02-05',
      addedCount: 1,
      removedCount: 1,
      changedCount: 2,
    });
  });

  it('유니버스 크기가 바뀌면 서로 다른 편입·편출 수를 보존한다', () => {
    const result = summarizeUniverseRebalancing([
      scheduleEntry('2026-01-05', '2026-01-05', ['A', 'B']),
      scheduleEntry('2026-02-05', '2026-02-05', ['B', 'C', 'D']),
      scheduleEntry('2026-03-05', '2026-03-05', ['D']),
    ]);
    expect(result[1]).toMatchObject({ addedCount: 2, removedCount: 1, changedCount: 3 });
    expect(result[2]).toMatchObject({ addedCount: 0, removedCount: 2, changedCount: 2 });
  });

  it('멤버십이 같으면 변경 수를 모두 0으로 반환한다', () => {
    const result = summarizeUniverseRebalancing([
      scheduleEntry('2026-01-05', '2026-01-05', ['A', 'B']),
      scheduleEntry('2026-02-05', '2026-02-05', ['B', 'A']),
    ]);
    expect(result[1]).toMatchObject({ addedCount: 0, removedCount: 0, changedCount: 0 });
  });
});
```

- [ ] **Step 2: 요약 모듈이 없어 테스트가 실패하는지 확인한다**

Run:

```bash
pnpm test tests/unit/universe-rebalancing.test.ts
```

Expected: FAIL because `universe-rebalancing.ts` does not exist.

- [ ] **Step 3: shared 응답 union과 순수 집합 비교를 구현한다**

`src/shared/schemas/universe-rebalancing.ts`를 만든다.

```typescript
export type UniverseRebalancingEntryDto =
  | {
      readonly kind: 'INITIAL';
      readonly rebalanceDate: string;
      readonly effectiveDate: string;
      readonly memberCount: number;
    }
  | {
      readonly kind: 'CHANGE';
      readonly rebalanceDate: string;
      readonly effectiveDate: string;
      readonly addedCount: number;
      readonly removedCount: number;
      readonly changedCount: number;
    };
```

`src/server/modules/backtest/application/universe-rebalancing.ts`를 만든다.

```typescript
import type { UniverseRebalancingEntryDto } from '../../../../shared/schemas/universe-rebalancing.js';
import type { LegacyUniverseScheduleEntry } from './universe-rule-resolver.js';

function differenceCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const symbol of left) {
    if (!right.has(symbol)) count += 1;
  }
  return count;
}

export function summarizeUniverseRebalancing(
  schedule: readonly LegacyUniverseScheduleEntry[],
): UniverseRebalancingEntryDto[] {
  let previous: ReadonlySet<string> | null = null;

  return schedule.map((entry) => {
    const current = new Set(entry.symbols);
    if (previous === null) {
      previous = current;
      return {
        kind: 'INITIAL',
        rebalanceDate: entry.rebalanceDate,
        effectiveDate: entry.effectiveTradingDate,
        memberCount: current.size,
      };
    }

    const addedCount = differenceCount(current, previous);
    const removedCount = differenceCount(previous, current);
    previous = current;
    return {
      kind: 'CHANGE',
      rebalanceDate: entry.rebalanceDate,
      effectiveDate: entry.effectiveTradingDate,
      addedCount,
      removedCount,
      changedCount: addedCount + removedCount,
    };
  });
}
```

- [ ] **Step 4: 모든 집합 비교 단위 테스트를 통과시킨다**

Run:

```bash
pnpm test tests/unit/universe-rebalancing.test.ts
```

Expected: PASS.

- [ ] **Step 5: 리밸런싱 요약 도메인을 커밋한다**

```bash
git add src/shared/schemas/universe-rebalancing.ts src/server/modules/backtest/application/universe-rebalancing.ts tests/unit/universe-rebalancing.test.ts
git commit -m "feat(backtest): 멤버십 변동 수를 요약한다"
```

---

### Task 3: 백테스트 상세 API에 작은 리밸런싱 DTO 추가

**Files:**
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts:150-166,633-644`
- Modify: `tests/integration/job-queue.test.ts:1-8,130-220`

**Interfaces:**
- Consumes: Task 2의 `summarizeUniverseRebalancing(schedule)`와 `UniverseRebalancingEntryDto`.
- Produces: `GET /api/v1/backtests/:id` top-level field `universeRebalancing: UniverseRebalancingEntryDto[]`; 원본 `universeScheduleJson`은 응답하지 않는다.

- [ ] **Step 1: 상세 API 요약과 손상 JSON 관용의 실패 통합 테스트를 작성한다**

`tests/integration/job-queue.test.ts`의 schema import에 `backtestJobs`를 추가한 뒤, queue describe 안에 다음 테스트를 추가한다.

```typescript
it('상세 조회는 멤버 원문 대신 최초 구성과 편입·편출 요약을 반환한다', async () => {
  const job = ctx.container.jobQueue.enqueue(buildRequest(), [
    {
      rebalanceDate: '2026-01-05',
      effectiveTradingDate: '2026-01-02',
      symbols: ['005930', '000660'],
      excludedNonTradingCount: 0,
    },
    {
      rebalanceDate: '2026-02-05',
      effectiveTradingDate: '2026-02-05',
      symbols: ['000660', '035420', '051910'],
      excludedNonTradingCount: 0,
    },
  ]);

  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/backtests/${job.id}`,
    cookies: { qp_session: cookie },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.universeRebalancing).toEqual([
    {
      kind: 'INITIAL',
      rebalanceDate: '2026-01-05',
      effectiveDate: '2026-01-02',
      memberCount: 2,
    },
    {
      kind: 'CHANGE',
      rebalanceDate: '2026-02-05',
      effectiveDate: '2026-02-05',
      addedCount: 2,
      removedCount: 1,
      changedCount: 3,
    },
  ]);
  expect(body.job).not.toHaveProperty('universeScheduleJson');
});

it('저장된 멤버십 일정 JSON이 손상돼도 상세 조회와 나머지 결과는 유지한다', async () => {
  const job = ctx.container.jobQueue.enqueue(buildRequest());
  ctx.container.database.db
    .update(backtestJobs)
    .set({ universeScheduleJson: '{' })
    .where(eq(backtestJobs.id, job.id))
    .run();

  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/backtests/${job.id}`,
    cookies: { qp_session: cookie },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().job.id).toBe(job.id);
  expect(response.json().universeRebalancing).toEqual([]);
});
```

- [ ] **Step 2: 상세 API에 필드가 없어 테스트가 실패하는지 확인한다**

Run:

```bash
pnpm test tests/integration/job-queue.test.ts -t "상세 조회는 멤버 원문 대신|저장된 멤버십 일정 JSON이 손상돼도"
```

Expected: FAIL. 첫 테스트의 `body.universeRebalancing`은 `undefined`이다.

- [ ] **Step 3: 일정 JSON을 안전하게 파싱하고 상세 응답에 요약을 붙인다**

`src/server/modules/backtest/presentation/backtest-routes.ts`에 Task 2 helper와 schedule type을 import한다.

```typescript
import { summarizeUniverseRebalancing } from '../application/universe-rebalancing.js';
import type { LegacyUniverseScheduleEntry } from '../application/universe-rule-resolver.js';
```

`parseProvenancePin` 아래에 다음 함수를 둔다.

```typescript
function parseUniverseRebalancing(
  universeScheduleJson: string,
  jobId: string,
  logger: FastifyBaseLogger,
): UniverseRebalancingEntryDto[] {
  try {
    const schedule = JSON.parse(universeScheduleJson) as LegacyUniverseScheduleEntry[];
    return summarizeUniverseRebalancing(schedule);
  } catch (error) {
    logger.warn(
      { event: 'backtest.universe_schedule.parse_failed', jobId, err: error },
      'universeScheduleJson 파싱에 실패해 종목 리밸런싱 요약 없이 응답한다',
    );
    return [];
  }
}
```

반환 타입을 위해 shared type import도 추가한다.

```typescript
import type { UniverseRebalancingEntryDto } from '../../../../shared/schemas/universe-rebalancing.js';
```

`GET /backtests/:id` 응답에 top-level field를 추가한다.

```typescript
universeRebalancing: parseUniverseRebalancing(job.universeScheduleJson, id, request.log),
```

- [ ] **Step 4: 상세 API 통합 테스트와 기존 상세 조회를 통과시킨다**

Run:

```bash
pnpm test tests/integration/job-queue.test.ts -t "상세 조회는 멤버 원문 대신|저장된 멤버십 일정 JSON이 손상돼도|runs a backtest end-to-end"
```

Expected: PASS. 손상 JSON 테스트는 warning log를 남기지만 응답은 200이다.

- [ ] **Step 5: 상세 API 변경을 커밋한다**

```bash
git add src/server/modules/backtest/presentation/backtest-routes.ts tests/integration/job-queue.test.ts
git commit -m "feat(api): 백테스트 리밸런싱 요약을 반환한다"
```

---

### Task 4: 종목 리밸런싱 카드와 결과 화면 죽은 코드 정리

**Files:**
- Create: `src/web/features/backtests/universe-rebalancing-section.tsx`
- Create: `tests/unit/universe-rebalancing-section.test.tsx`
- Modify: `src/web/features/backtests/api.ts:44-119`
- Modify: `src/web/features/backtests/backtest-detail-page.tsx:90-98,413-474,532-606,610-735,741-758,938-990`
- Modify: `src/web/features/backtests/universe-provenance.ts:1-65`
- Modify: `tests/unit/universe-provenance-label.test.ts:1-108`
- Modify: `tests/e2e/mvp-flow.spec.ts:240-265`

**Interfaces:**
- Consumes: Task 3의 `universeRebalancing` detail field와 shared `UniverseRebalancingEntryDto`.
- Produces: `UniverseRebalancingSection({ entries })`; `useBacktestLive`가 `universeRebalancing`을 빈 배열 fallback과 함께 반환한다.
- Removes: `SymbolPerformanceSection`, 내부 `UniverseDiagnosticsSection`, `provenanceDiagnostics`, 결과 화면의 `CRITERION_LABEL` import와 관련 테스트 fixture.

- [ ] **Step 1: 표시 문구·색상·빈 배열의 실패 component 테스트를 작성한다**

`tests/unit/universe-rebalancing-section.test.tsx`를 만든다.

```tsx
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UniverseRebalancingSection } from '@/features/backtests/universe-rebalancing-section';
import type { UniverseRebalancingEntryDto } from '@shared/schemas/universe-rebalancing';

const entries: UniverseRebalancingEntryDto[] = [
  {
    kind: 'INITIAL',
    rebalanceDate: '2026-01-05',
    effectiveDate: '2026-01-02',
    memberCount: 2,
  },
  {
    kind: 'CHANGE',
    rebalanceDate: '2026-02-05',
    effectiveDate: '2026-02-05',
    addedCount: 2,
    removedCount: 1,
    changedCount: 3,
  },
];

describe('UniverseRebalancingSection', () => {
  it('최초 구성과 변동 합계·편입·편출을 사람이 읽는 문구로 표시한다', () => {
    const html = renderToStaticMarkup(<UniverseRebalancingSection entries={entries} />);
    expect(html).toContain('종목 리밸런싱');
    expect(html).toContain('변동 종목 수');
    expect(html).toContain('최초 구성 2종목');
    expect(html).toContain('합계 3종목');
    expect(html).toContain('편입');
    expect(html).toContain('편출');
    expect(html).toContain('(휴장 조정)');
  });

  it('편입 숫자는 gain, 편출 숫자는 loss 색상이고 문구는 색과 별도로 남는다', () => {
    const html = renderToStaticMarkup(<UniverseRebalancingSection entries={entries} />);
    expect(html).toContain('편입 <span class="text-gain tabular-nums">2</span>');
    expect(html).toContain('편출 <span class="text-loss tabular-nums">1</span>');
  });

  it('일정이 없으면 카드를 렌더링하지 않는다', () => {
    expect(renderToStaticMarkup(<UniverseRebalancingSection entries={[]} />)).toBe('');
  });
});
```

- [ ] **Step 2: 새 UI module이 없어 component 테스트가 실패하는지 확인한다**

Run:

```bash
pnpm test tests/unit/universe-rebalancing-section.test.tsx
```

Expected: FAIL because `universe-rebalancing-section.tsx` does not exist.

- [ ] **Step 3: 페이지 이동을 포함한 리밸런싱 카드 컴포넌트를 구현한다**

`src/web/features/backtests/universe-rebalancing-section.tsx`를 만든다.

```tsx
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSizeInput, Pagination } from '@/components/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { pageWindow } from '@/lib/pagination';
import { parsePageSize } from '@/lib/page-size';
import type { UniverseRebalancingEntryDto } from '../../../shared/schemas/universe-rebalancing.js';

export function UniverseRebalancingSection({
  entries,
}: {
  entries: readonly UniverseRebalancingEntryDto[];
}) {
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState('20');
  const pageSize = parsePageSize(pageSizeText, 20);
  const { pageCount, currentPage, from, to } = pageWindow(entries.length, pageSize, page);
  const visible = entries.slice(from, to);

  if (entries.length === 0) return null;

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">종목 리밸런싱</CardTitle>
        <PageSizeInput
          value={pageSizeText}
          label="종목 리밸런싱 페이지당 표시 수"
          unit="건"
          onChange={(nextValue) => {
            setPageSizeText(nextValue);
            setPage(0);
          }}
        />
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>리밸런스일</TableHead>
                <TableHead>기준일</TableHead>
                <TableHead>변동 종목 수</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((entry) => (
                <TableRow key={entry.rebalanceDate}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {entry.rebalanceDate}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {entry.effectiveDate}
                    {entry.effectiveDate !== entry.rebalanceDate ? (
                      <span className="text-muted-foreground"> (휴장 조정)</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {entry.kind === 'INITIAL' ? (
                      <>최초 구성 {entry.memberCount}종목</>
                    ) : (
                      <>
                        합계 {entry.changedCount}종목 (편입{' '}
                        <span className="text-gain tabular-nums">{entry.addedCount}</span> · 편출{' '}
                        <span className="text-loss tabular-nums">{entry.removedCount}</span>)
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Pagination
          className="mt-3"
          ariaLabel="종목 리밸런싱 페이지 이동"
          currentPage={currentPage}
          pageCount={pageCount}
          onPageChange={setPage}
        />
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: 카드 component 테스트를 통과시킨다**

Run:

```bash
pnpm test tests/unit/universe-rebalancing-section.test.tsx
```

Expected: PASS.

- [ ] **Step 5: 결과 화면 경계의 실패 E2E assertion을 추가한다**

`tests/e2e/mvp-flow.spec.ts`의 `full MVP flow` 결과 검증에서 `재현 정보` assertion 다음에 추가한다.

```typescript
await expect(page.getByText('종목 리밸런싱', { exact: true })).toBeVisible();
await expect(page.getByText('최초 구성 1종목', { exact: true })).toBeVisible();
await expect(page.getByRole('columnheader', { name: '변동 종목 수' })).toBeVisible();
await expect(page.getByText('유니버스 단계 진단', { exact: true })).toHaveCount(0);
await expect(page.getByRole('columnheader', { name: '단계별 통과(통과/후보)' })).toHaveCount(0);
await expect(page.getByText('종목별 성과', { exact: true })).toHaveCount(0);
```

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/mvp-flow.spec.ts --project=desktop --grep "full MVP flow"
```

Expected: FAIL because the result still renders `유니버스 단계 진단` and does not render `종목 리밸런싱`.

- [ ] **Step 6: detail client와 결과 페이지를 새 DTO에 연결한다**

`src/web/features/backtests/api.ts`의 `BacktestDetail`에 다음 field를 추가하고 shared type을 import한다.

```typescript
universeRebalancing: UniverseRebalancingEntryDto[];
```

`useBacktestLive` 반환값에 fallback을 추가한다.

```typescript
universeRebalancing: detail.data?.universeRebalancing ?? [],
```

`src/web/features/backtests/backtest-detail-page.tsx`에서 다음을 수행한다.

1. `UniverseRebalancingSection`을 import한다.
2. `useBacktestLive(id)` 결과에서 `universeRebalancing`을 구조 분해한다.
3. `RunMetadataCard` prop에 `universeRebalancing: readonly UniverseRebalancingEntryDto[]`를 추가한다.
4. 기존 `<UniverseDiagnosticsSection provenancePin={provenancePin} />`을 아래 호출로 교체한다.

```tsx
<UniverseRebalancingSection entries={universeRebalancing} />
```

5. 페이지 아래의 `RunMetadataCard` 호출에 `universeRebalancing={universeRebalancing}`을 전달한다.
6. `SymbolPerformanceSection` 함수와 `series.symbols.length > 1` 렌더 블록을 삭제한다.
7. 내부 `UniverseDiagnosticsSection` 함수 전체를 삭제한다.
8. `provenanceDiagnostics`와 결과 전용 `CRITERION_LABEL` import를 삭제한다.
9. `resolvedSymbols` 위 주석과 `useStockNames` 주석에서 종목별 성과 공유 설명을 지우고 거래 내역·이름 표시 용도만 남긴다.

- [ ] **Step 7: 참조가 사라진 provenance 표시 helper와 테스트 fixture를 삭제한다**

`src/web/features/backtests/universe-provenance.ts`에서 다음을 제거한다.

```typescript
import type { RebalanceDiagnosticSnapshot } from '../../../shared/schemas/provenance-pin.js';
```

그리고 `provenanceDiagnostics` 함수와 바로 위 설명 주석을 삭제한다. `ProvenancePin` import, `universeSourceLabel`, `selectionMethodLabel`은 재현 정보가 계속 쓰므로 유지한다.

`tests/unit/universe-provenance-label.test.ts`에서는 다음을 삭제한다.

- `provenanceDiagnostics` import
- 진단 테스트에서만 쓰던 `pipelinePin` fixture
- `describe('provenanceDiagnostics', ...)` suite

- [ ] **Step 8: 결과 UI 단위·E2E·죽은 참조 검증을 통과시킨다**

Run:

```bash
pnpm test tests/unit/universe-rebalancing-section.test.tsx tests/unit/universe-provenance-label.test.ts
pnpm typecheck
pnpm build
pnpm exec playwright test tests/e2e/mvp-flow.spec.ts --project=desktop --grep "full MVP flow"
rg -n "SymbolPerformanceSection|provenanceDiagnostics|유니버스 단계 진단|단계별 통과\(통과/후보\)|종목별 성과" src
```

Expected: tests, typecheck, build, and E2E PASS. 마지막 `rg`는 결과가 없어 exit code 1이다.

- [ ] **Step 9: 결과 UI와 죽은 코드 정리를 커밋한다**

```bash
git add src/web/features/backtests/universe-rebalancing-section.tsx tests/unit/universe-rebalancing-section.test.tsx src/web/features/backtests/api.ts src/web/features/backtests/backtest-detail-page.tsx src/web/features/backtests/universe-provenance.ts tests/unit/universe-provenance-label.test.ts tests/e2e/mvp-flow.spec.ts
git commit -m "feat(web): 결과에 종목 리밸런싱을 표시한다"
```

---

### Task 5: 제품 문서 정합성과 전체 회귀 검증

**Files:**
- Modify: `docs/SPEC.md:590-612,1218-1242`
- Modify: `docs/DECISIONS.md` (append D-052)

**Interfaces:**
- Consumes: Tasks 1-4에서 확정된 입력 보정과 `UniverseRebalancingEntryDto` 표시 의미.
- Produces: 제품 명세와 결정 기록이 실제 UI·API와 같은 용어와 계산 정의를 쓴다.

- [ ] **Step 1: 제품 명세에서 제거된 결과와 새 리밸런싱 정보를 교체한다**

`docs/SPEC.md` §9.6의 `- 종목별 성과`를 다음 항목으로 교체한다.

```markdown
- 종목 리밸런싱(리밸런스일·기준일·최초 구성 수·편입 수·편출 수)
```

결과 화면 차트 목록에서 `5. 종목별 성과`를 삭제한다. 하단 목록에 다음 항목을 추가한다.

```markdown
- 종목 리밸런싱
```

같은 절 아래 설명에 다음 계산 규칙을 적는다.

```markdown
종목 리밸런싱은 제출 시점에 고정한 멤버십 일정을 직전 일정과 비교한다. 첫 행은
최초 구성 종목 수를 표시한다. 이후 행은 현재 일정에만 있는 편입 수와 직전 일정에만
있는 편출 수를 표시하며, 변동 종목 수는 두 수의 합이다.
```

- [ ] **Step 2: 선택 이유와 호환성 결정을 D-052로 기록한다**

`docs/DECISIONS.md` 끝에 추가한다.

```markdown
## D-052: 결과 진단은 단계별 통과 대신 멤버십 변동을 보여준다

- **변경 내용:** 결과의 「유니버스 단계 진단」을 「종목 리밸런싱」으로 바꾼다.
  리밸런스일과 실제 기준일은 유지하고 단계별 통과 수는 화면에서 제거한다. 첫 일정은
  최초 구성 종목 수를, 이후 일정은 직전 일정 대비 편입·편출 수와 그 합계를 표시한다.
  종목별 성과 표도 제거한다.
- **이유:** 단계별 후보·통과 수는 결과를 보고 다음 실험을 정하는 근거가 약하다.
  반면 멤버십 변동 수는 리밸런싱 강도와 수익률의 관계를 비교하고 주기 변경 여부를
  판단하는 직접적인 실험 변수다.
- **계산:** 편입은 현재 일정에만 있는 종목, 편출은 직전 일정에만 있는 종목이다.
  변동 종목 수는 둘의 합이다. 최종 유니버스 크기는 거래 가능 여부와 지표 결측 등으로
  달라질 수 있어 편입 수와 편출 수를 따로 보존한다.
- **표현:** 편입 숫자는 한국 주식 화면의 상승 색인 빨간색, 편출 숫자는 하락 색인
  파란색을 쓴다. 색만으로 구분하지 않고 편입·편출 문구를 함께 표시한다.
- **데이터 경계:** 새 저장 필드를 만들지 않는다. 상세 조회가 제출 시점에 고정된
  `universeScheduleJson`을 집합 비교해 요약만 반환한다. 원본 멤버 목록은 브라우저에
  보내지 않으므로 기존 결과에도 적용되고 DB migration도 필요 없다.
```

- [ ] **Step 3: 문서에 제거된 결과 용어가 남지 않았는지 확인한다**

Run:

```bash
rg -n "종목별 성과|유니버스 단계 진단|단계별 통과\(통과/후보\)" docs/SPEC.md
git diff --check
```

Expected: `rg` has no matches and exits 1. `git diff --check` exits 0.

- [ ] **Step 4: 전체 unit·integration 회귀 테스트를 실행한다**

Run:

```bash
pnpm test
```

Expected: PASS with no failed test files.

- [ ] **Step 5: 정적 검증과 production build를 실행한다**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all commands exit 0 without new errors or warnings.

- [ ] **Step 6: 두 변경 경계의 desktop E2E를 다시 실행한다**

Run:

```bash
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop --grep "단계별 N 입력은"
pnpm exec playwright test tests/e2e/mvp-flow.spec.ts --project=desktop --grep "full MVP flow"
```

Expected: both PASS.

- [ ] **Step 7: 최종 diff와 직접 생긴 죽은 코드가 없는지 확인한다**

Run:

```bash
rg -n "SymbolPerformanceSection|provenanceDiagnostics|유니버스 단계 진단|단계별 통과\(통과/후보\)|종목별 성과" src
git diff --check
git status --short
```

Expected: `rg` has no matches and exits 1. `git diff --check` exits 0. `git status --short`에는 Task 5 문서 두 파일만 남는다.

- [ ] **Step 8: 제품 문서와 최종 검증 결과를 커밋한다**

```bash
git add docs/SPEC.md docs/DECISIONS.md
git commit -m "docs: 종목 리밸런싱 결과 기준을 기록한다"
```
