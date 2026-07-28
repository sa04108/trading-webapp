# 백테스트 복제 2갈래 + 제출 검증 보강 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스트 복제를 `복제`(동일 조건 즉시 재실행)와 `재설정 및 복제`(원본 값으로 프리필된 위저드를 전략부터 다시)로 분리하고, 확실히 실패할 제출을 제출 검증에서 거부하며, 대기열이 무한히 쌓이는 것을 막는다.

**Architecture:** 제출 검증(`validateSubmission`)에 기간 × 커버리지 검사를 추가해 신규·복제 양쪽을 함께 보강한다. 위저드 프리필은 새 읽기 전용 `GET /backtests/:id/clone-draft` 가 재기준된 요청과 검증 결과를 돌려주고, 위저드는 그 값을 폼 상태로 옮긴다. 초안은 검증을 **돌리되 막지 않는다** — 여기서 끊으면 고칠 화면이 열리지 않는다.

**Tech Stack:** TypeScript(strict, `noUncheckedIndexedAccess`), Fastify, Drizzle/SQLite, React + react-router + TanStack Query, Vitest.

## Global Constraints

- 스펙: [docs/superpowers/specs/2026-07-28-backtest-clone-split-design.md](../specs/2026-07-28-backtest-clone-split-design.md)
- 버튼 문구는 정확히 **`복제`** 와 **`재설정 및 복제`**. 다른 표현을 쓰지 않는다.
- 사용자 노출 문구는 한국어. 주석도 이 저장소 관례대로 한국어.
- `noUncheckedIndexedAccess: true` — 배열 인덱스 접근은 `undefined` 가능. `errors[0]` 같은 접근에 폴백을 둔다.
- 검증 검사 **순서를 현행과 동일하게 유지**한다. 기존 테스트가 특정 첫 400 메시지를 기대한다(`005935` 를 담은 심볼 거부 등).
- 커버리지는 메타데이터(`data_coverage` 테이블)만 읽는다. 제출 검증에서 Parquet 을 읽지 않는다.
- 검증 게이트: `pnpm typecheck`, `pnpm lint`, `npx vitest run` 전부 통과해야 커밋한다.
- `--reporter=basic` 은 vitest 4 에서 제거됐다. 기본 리포터를 쓴다.

---

### Task 0: 작업 브랜치 + 완료된 D-024 수정 커밋

D-024(일봉 timeframe) 수정·회귀 테스트·결정 기록은 **이미 구현·검증 완료**된 상태로 워킹 트리에 있다. 현재 `main` 브랜치이므로 브랜치를 먼저 만들고 그 작업을 독립 커밋으로 분리한다.

**Files:**
- Modify: `src/workers/backtest-child.ts` (완료됨 — `dataset.timeframe` 사용)
- Create: `tests/integration/backtest-daily-dataset.test.ts` (완료됨)
- Modify: `docs/DECISIONS.md` (완료됨 — D-024)

**Interfaces:**
- Consumes: 없음
- Produces: 없음 (이후 태스크는 이 커밋 위에 쌓인다)

- [ ] **Step 1: 브랜치 생성**

```bash
git checkout -b feat/backtest-clone-split
```

- [ ] **Step 2: 전체 검증**

```bash
pnpm typecheck && pnpm lint && npx vitest run
```

Expected: typecheck/lint 무출력 통과, 테스트 23 files / 142 tests 통과.

- [ ] **Step 3: D-024 수정만 커밋**

```bash
git add src/workers/backtest-child.ts tests/integration/backtest-daily-dataset.test.ts docs/DECISIONS.md
git commit -m "fix(backtest): 데이터셋 timeframe 을 따르게 — 일봉 데이터셋 백테스트 전면 실패 (D-024)"
```

- [ ] **Step 4: 스펙·계획 문서 커밋**

```bash
git add docs/superpowers/specs/2026-07-28-backtest-clone-split-design.md docs/superpowers/plans/2026-07-28-backtest-clone-split.md
git commit -m "docs: 복제 2갈래 + 제출 검증 보강 설계·계획"
```

---

### Task 1: `periodToTsRange` 공유 함수

제출 검증과 실행부가 기간 경계를 각자 계산하면 어긋난다 — 제출 검증은 통과시키고 실행부는 0봉을 보는, D-024 와 같은 종류의 결함이다. 한 함수를 양쪽이 쓴다.

**Files:**
- Modify: `src/shared/schemas/backtest-request.ts` (끝에 추가)
- Modify: `src/workers/backtest-child.ts` (기간 계산부를 교체)
- Test: `tests/unit/backtest-request.test.ts` (신규)

**Interfaces:**
- Consumes: 없음
- Produces: `periodToTsRange(period: { from: string; to: string }): { fromTsMs: number; toTsMs: number }` — Task 2 의 제출 검증과 Task 3 의 자식 프로세스가 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

Create `tests/unit/backtest-request.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { periodToTsRange } from '../../src/shared/schemas/backtest-request.js';

describe('periodToTsRange', () => {
  it('구간은 to 일자의 끝까지 포함한다 (UTC)', () => {
    const { fromTsMs, toTsMs } = periodToTsRange({ from: '2025-07-27', to: '2026-07-24' });
    expect(fromTsMs).toBe(Date.UTC(2025, 6, 27, 0, 0, 0, 0));
    expect(toTsMs).toBe(Date.UTC(2026, 6, 24, 23, 59, 59, 999));
  });

  it('to 일자 UTC 자정의 봉(KST 09:00 일봉)을 포함한다', () => {
    const { fromTsMs, toTsMs } = periodToTsRange({ from: '2026-07-24', to: '2026-07-24' });
    const bar = Date.UTC(2026, 6, 24);
    expect(bar).toBeGreaterThanOrEqual(fromTsMs);
    expect(bar).toBeLessThanOrEqual(toTsMs);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run tests/unit/backtest-request.test.ts`
Expected: FAIL — `periodToTsRange` is not exported / not a function.

- [ ] **Step 3: 함수 구현**

`src/shared/schemas/backtest-request.ts` 파일 끝(기존 `export type BacktestRequest = ...` 아래)에 추가:

```ts
/**
 * 요청 기간을 UTC epoch ms 구간으로 바꾼다.
 * 제출 검증(backtest-routes)과 실행부(backtest-child)가 **같은 함수**를 써야 한다 —
 * 각자 계산하면 제출 검증은 통과시키는데 실행부는 0봉을 보는 어긋남이 생긴다 (D-024 와 같은 종류).
 */
export function periodToTsRange(period: { from: string; to: string }): {
  fromTsMs: number;
  toTsMs: number;
} {
  return {
    fromTsMs: Date.parse(`${period.from}T00:00:00Z`),
    toTsMs: Date.parse(`${period.to}T23:59:59.999Z`),
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run tests/unit/backtest-request.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 자식 프로세스가 공유 함수를 쓰게 교체**

`src/workers/backtest-child.ts` 의 import 를 수정:

```ts
import { backtestRequestSchema, periodToTsRange } from '../shared/schemas/backtest-request.js';
```

그리고 기간 계산 두 줄

```ts
    const fromTsMs = Date.parse(`${request.period.from}T00:00:00Z`);
    const toTsMs = Date.parse(`${request.period.to}T23:59:59.999Z`);
```

을 다음으로 교체:

```ts
    const { fromTsMs, toTsMs } = periodToTsRange(request.period);
```

- [ ] **Step 6: 전체 검증**

Run: `pnpm typecheck && pnpm lint && npx vitest run`
Expected: 전부 통과. 일봉 회귀 테스트(`backtest-daily-dataset.test.ts`)가 여전히 통과해야 한다 — 경계 계산이 바뀌지 않았음을 증명한다.

- [ ] **Step 7: 커밋**

```bash
git add src/shared/schemas/backtest-request.ts src/workers/backtest-child.ts tests/unit/backtest-request.test.ts
git commit -m "refactor(backtest): 기간→tsMs 변환을 제출 검증·실행부가 공유하게 추출"
```

---

### Task 2: 제출 검증에 기간 × 커버리지 검사

`validateSubmission` 은 기간에 실제로 봉이 있는지 보지 않는다. D-024 의 실행이 201 로 접수되고 한참 뒤 FAILED 로 끝난 이유다. 사유를 모아 반환하는 형태로 넓히고(초안이 쓴다) 커버리지 검사를 넣는다.

**Files:**
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts`
- Test: `tests/integration/job-queue.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: `periodToTsRange` (Task 1)
- Produces: `validateSubmission(body) => { ok: true; datasetVersion } | { ok: false; errors: string[] }` — Task 4 의 `clone-draft` 가 `errors` 를 `blockers` 로 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/integration/job-queue.test.ts` 의 마지막 `it(...)` 뒤, `});` (describe 종료) 앞에 추가:

```ts
  it('기간에 봉이 전혀 없는 제출을 제출 검증에서 거부한다 (D-025)', async () => {
    // 데이터셋 봉은 2026-01-05 부터다 — 그보다 앞선 구간은 확실히 0봉이다
    const noData = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: { ...buildRequest(datasetId), period: { from: '2020-01-01', to: '2020-12-31' } },
    });
    expect(noData.statusCode).toBe(400);
    const message = (noData.json() as { error: string }).error;
    // 진단이 커버리지로 이어지도록 보유 범위를 담는다
    expect(message).toContain('005930');
    expect(message).toContain('2026-01-05');
  });

  it('복제도 같은 제출 검증을 거친다 — 봉 없는 기간은 거부한다 (D-025)', async () => {
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(datasetId),
      period: { from: '2020-01-01', to: '2020-12-31' },
    });

    const cloned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${job.id}/clone`,
      cookies: { qp_session: cookie },
    });
    expect(cloned.statusCode).toBe(400);
    expect((cloned.json() as { error: string }).error).toContain('005930');
  });

  it('일부 종목만 봉이 없으면 거부하지 않는다 (신규 상장 등 정상)', async () => {
    // 심볼을 하나 더 데이터셋에 추가하되 봉은 넣지 않는다 — 커버리지 행이 없는 종목
    ctx.container.datasetService.updateSymbols(datasetId, { add: ['000660'] });

    const partial = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        ...buildRequest(datasetId),
        universe: { type: 'SYMBOLS', symbols: ['005930', '000660'] },
      },
    });
    expect(partial.statusCode).toBe(201);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run tests/integration/job-queue.test.ts`
Expected: 앞의 두 테스트 FAIL (`expected 201 to be 400`), 세 번째는 PASS.

- [ ] **Step 3: 제출 검증 구현**

`src/server/modules/backtest/presentation/backtest-routes.ts` 수정.

(a) import 에 `periodToTsRange` 를 추가:

```ts
import {
  backtestRequestSchema,
  periodToTsRange,
  type BacktestRequest,
} from '../../../../shared/schemas/backtest-request.js';
```

(b) 파일 상단 상수 근처(`MIN_FREE_MEMORY_BYTES` 아래)에 헬퍼 추가:

```ts
const isoDate = (tsMs: number): string => new Date(tsMs).toISOString().slice(0, 10);
```

(c) `registerBacktestRoutes` 안, `validateSubmission` **앞**에 커버리지 검사를 추가:

```ts
  /**
   * 기간 × 커버리지 검사 (D-025). 커버리지는 메타데이터라 Parquet 을 읽지 않는다.
   * 요청한 종목 **전부** 가 구간 밖일 때만 거부한다 — 신규 상장처럼 이력이 짧은 종목
   * 하나 때문에 유니버스 전체를 막지 않는다. 일부만 비는 경우는 실행 경고로 남는다.
   */
  const checkPeriodCoverage = (body: BacktestRequest, datasetId: string): string | null => {
    const { fromTsMs, toTsMs } = periodToTsRange(body.period);
    const bySymbol = new Map(datasets.getCoverage(datasetId).map((row) => [row.symbol, row]));

    const ranges: string[] = [];
    for (const symbol of body.universe.symbols) {
      const row = bySymbol.get(symbol);
      if (!row || row.barCount === 0 || row.firstTsMs === null || row.lastTsMs === null) {
        ranges.push(`${symbol}: 수집된 데이터 없음`);
        continue;
      }
      // 하나라도 겹치면 통과 — 나머지는 실행 경고가 알린다
      if (row.lastTsMs >= fromTsMs && row.firstTsMs <= toTsMs) return null;
      ranges.push(`${symbol}: ${isoDate(row.firstTsMs)} ~ ${isoDate(row.lastTsMs)}`);
    }

    return `선택한 기간에 데이터가 있는 종목이 없습니다. 보유 범위 — ${ranges.join(', ')}`;
  };
```

(d) `validateSubmission` 전체를 다음으로 교체. **검사 순서는 현행과 동일**하고, 전략·데이터셋처럼 후속 검사의 전제가 되는 항목은 실패 시 딸린 검사를 건너뛴다(널 참조로 터지지 않게):

```ts
  /**
   * 제출 검증 — 신규 제출(POST)·복제(clone)·초안(clone-draft)이 동일한 기준을 거친다.
   * 통과 시 제출 시점의 데이터셋 버전을 함께 반환한다 (재현성 §9.5).
   * 사유를 모아 반환한다 — 초안(clone-draft)이 무엇을 고쳐야 하는지 한 번에 알려야 한다.
   * 400 메시지는 `errors[0]` 이므로 검사 순서가 곧 우선순위다.
   */
  const validateSubmission = (
    body: BacktestRequest,
  ):
    | { ok: true; datasetVersion: { version: number; contentHash: string } }
    | { ok: false; errors: string[] } => {
    const errors: string[] = [];

    // 전략 — 파라미터 검증의 전제다
    const strategy = strategies.get(body.strategyId);
    if (!strategy) {
      errors.push(`알 수 없는 전략: ${body.strategyId}`);
    } else {
      if (strategy.version !== body.strategyVersion) {
        errors.push(`전략 버전 불일치: 요청 ${body.strategyVersion}, 등록 ${strategy.version}`);
      }
      const paramCheck = strategies.validateParameters(body.strategyId, body.parameters);
      if (!paramCheck.ok) errors.push(paramCheck.error);
    }

    // 데이터셋 — 심볼·버전·커버리지 검사의 전제다
    const dataset = datasets.getDataset(body.datasetId);
    let datasetVersion: { version: number; contentHash: string } | null = null;
    if (!dataset) {
      errors.push(`알 수 없는 데이터셋: ${body.datasetId}`);
    } else {
      // 데이터셋에 없는 심볼은 조용히 0 거래로 "성공" 하게 된다 — 제출 시점에 거부
      const datasetSymbols = new Set(dataset.symbols);
      const missingSymbols = body.universe.symbols.filter((s) => !datasetSymbols.has(s));
      if (missingSymbols.length > 0) {
        errors.push(`데이터셋에 없는 종목입니다: ${missingSymbols.join(', ')}`);
      }
      // 제출 시점의 데이터셋 버전을 고정 — 대기 중 import 가 끼어들어도 메타데이터가 어긋나지 않는다
      datasetVersion = datasets.getLatestVersion(body.datasetId);
      if (!datasetVersion) {
        errors.push('데이터가 없는 데이터셋입니다. 먼저 import 하세요.');
      }
      const coverageError = checkPeriodCoverage(body, dataset.id);
      if (coverageError !== null) errors.push(coverageError);
    }

    if (!getCostProfile(body.execution.commissionProfileId)) {
      errors.push('알 수 없는 수수료 프로파일');
    }
    if (!getSlippageProfile(body.execution.slippageProfileId)) {
      errors.push('알 수 없는 슬리피지 프로파일');
    }
    if (body.period.from > body.period.to) {
      errors.push('기간이 올바르지 않습니다 (from > to)');
    }

    if (errors.length > 0 || datasetVersion === null) {
      return { ok: false, errors: errors.length > 0 ? errors : ['제출을 검증할 수 없습니다'] };
    }
    return { ok: true, datasetVersion };
  };
```

(e) 두 호출부의 400 응답을 `errors[0]` 로 바꾼다. `POST /backtests` 안:

```ts
    const validated = validateSubmission(body);
    if (!validated.ok) {
      return reply.code(400).send({ error: validated.errors[0] ?? '제출을 검증할 수 없습니다' });
    }
```

`POST /backtests/:id/clone` 안:

```ts
    const validated = validateSubmission(cloneRequest);
    if (!validated.ok) {
      return reply.code(400).send({ error: validated.errors[0] ?? '제출을 검증할 수 없습니다' });
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run tests/integration/job-queue.test.ts`
Expected: PASS 전부. 특히 기존 `rejects requests referencing unknown entities` 가 계속 통과해야 한다 — `errors[0]` 이 현행과 같은 첫 실패임을 증명한다.

- [ ] **Step 5: 전체 검증**

Run: `pnpm typecheck && pnpm lint && npx vitest run`
Expected: 전부 통과.

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/backtest/presentation/backtest-routes.ts tests/integration/job-queue.test.ts
git commit -m "feat(backtest): 제출 검증에 기간×커버리지 검사 — 확실히 실패할 제출을 즉시 거부 (D-025)"
```

---

### Task 3: 자식 프로세스 — 봉 없는 종목 실행 경고

제출 검증은 일부 종목만 비는 경우를 통과시킨다(신규 상장 등 정상). 조용히 빠지면 결과를 오해하므로, 실제로 봉을 낸 심볼과 비교해 실행 경고로 남긴다. 커버리지 추정이 아니라 실측이라 자식이 낸다.

**Files:**
- Modify: `src/workers/backtest-child.ts`
- Test: `tests/integration/backtest-daily-dataset.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/integration/backtest-daily-dataset.test.ts` 의 마지막 `it(...)` 뒤, describe 종료 `});` 앞에 추가:

```ts
  it('봉이 없는 종목을 실행 경고로 남긴다', { timeout: 90_000 }, async () => {
    // 데이터셋에 심볼을 더하되 봉은 넣지 않는다 — 제출 검증은 통과하고 실행에서 빠진다
    ctx.container.datasetService.updateSymbols(datasetId, { add: ['000660'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        ...buildRequest(datasetId),
        universe: { type: 'SYMBOLS', symbols: ['005930', '000660'] },
      },
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);

    const job = ctx.container.jobQueue.getJob(jobId)!;
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');

    const run = ctx.container.resultsService.getRun(jobId)!;
    const warnings = JSON.parse(run.warningsJson ?? '[]') as string[];
    expect(warnings.some((w) => w.includes('000660'))).toBe(true);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run tests/integration/backtest-daily-dataset.test.ts`
Expected: FAIL — 경고 배열에 `000660` 이 없다 (`expected false to be true`).

- [ ] **Step 3: 자식 프로세스에 경고 추가**

`src/workers/backtest-child.ts` 의 0봉 방어 블록

```ts
    if (candles.length === 0) {
      // 어떤 timeframe 을 찾았는지 밝힌다 — 커버리지가 정상인데 실패하면 여기서 갈린다
      throw new Error(
        `선택한 기간·종목에 ${timeframe} 데이터가 없습니다. 데이터 커버리지를 확인하세요.`,
      );
    }
```

바로 뒤에 추가:

```ts
    // 일부 종목만 구간에 봉이 없는 경우 — 제출 검증은 통과시킨다(신규 상장 등 정상).
    // 조용히 빠지면 결과를 오해하므로 실측 기준으로 경고를 남긴다 (D-025).
    const symbolsWithBars = new Set(candles.map((candle) => candle.symbol));
    const emptySymbols = request.universe.symbols.filter((s) => !symbolsWithBars.has(s));
    if (emptySymbols.length > 0) {
      datasetWarnings.push(
        `선택한 기간에 ${timeframe} 봉이 없어 제외된 종목: ${emptySymbols.join(', ')}`,
      );
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run tests/integration/backtest-daily-dataset.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 전체 검증 후 커밋**

```bash
pnpm typecheck && pnpm lint && npx vitest run
git add src/workers/backtest-child.ts tests/integration/backtest-daily-dataset.test.ts
git commit -m "feat(backtest): 봉 없는 종목을 실행 경고로 기록 (D-025)"
```

---

### Task 4: `GET /backtests/:id/clone-draft`

위저드 프리필용 읽기 전용 초안. 검증을 돌리되 막지 않는다 — 여기서 400 으로 끊으면 조건이 틀어진 백테스트를 고칠 화면 자체가 열리지 않는다.

**Files:**
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts`
- Test: `tests/integration/job-queue.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: `validateSubmission` → `{ ok: false; errors: string[] }` (Task 2), `rebaseStoredRequest` (기존)
- Produces: `GET /backtests/:id/clone-draft` → `{ request: BacktestRequest; warnings: string[]; blockers: string[] }` — Task 6 의 위저드가 소비한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/integration/job-queue.test.ts` 의 describe 종료 앞에 추가:

```ts
  it('초안은 재기준된 요청과 경고를 돌려준다 (재설정 및 복제)', async () => {
    const legacy = {
      ...buildRequest(datasetId),
      strategyVersion: '1.1.0',
      parameters: { ...buildRequest(datasetId).parameters, maxPositions: 5 },
    } as Record<string, unknown>;
    delete legacy.risk;
    const job = ctx.container.jobQueue.enqueue(legacy as never);

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as {
      request: BacktestRequest;
      warnings: string[];
      blockers: string[];
    };
    expect(body.request.risk.maxPositions).toBe(5);
    expect(body.request.strategyVersion).toBe('1.2.0');
    expect(body.warnings.some((w) => w.includes('1.1.0'))).toBe(true);
    expect(body.blockers).toEqual([]);
  });

  it('초안은 제출 불가한 원본도 열어준다 — 사유는 blockers 에 담는다', async () => {
    // 봉이 없는 기간 → 제출은 400 이지만 초안은 열려야 고칠 수 있다
    const job = ctx.container.jobQueue.enqueue({
      ...buildRequest(datasetId),
      period: { from: '2020-01-01', to: '2020-12-31' },
    });

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${job.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(draft.statusCode).toBe(200);
    const body = draft.json() as { request: BacktestRequest; blockers: string[] };
    // 원본 값은 그대로 돌려준다 — 사용자가 이 값을 보고 고친다
    expect(body.request.period.from).toBe('2020-01-01');
    expect(body.blockers.some((b) => b.includes('005930'))).toBe(true);
  });

  it('초안은 없는 작업에 404, 되살릴 수 없는 요청에 400', async () => {
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/backtests/job_nope/clone-draft',
      cookies: { qp_session: cookie },
    });
    expect(missing.statusCode).toBe(404);

    const broken = { ...buildRequest(datasetId) } as Record<string, unknown>;
    delete broken.period;
    const brokenJob = ctx.container.jobQueue.enqueue(broken as never);
    const brokenDraft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${brokenJob.id}/clone-draft`,
      cookies: { qp_session: cookie },
    });
    expect(brokenDraft.statusCode).toBe(400);
    expect((brokenDraft.json() as { error: string }).error).toContain('복원할 수 없습니다');
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run tests/integration/job-queue.test.ts`
Expected: 새 테스트 3개 FAIL (404 — 라우트 없음).

- [ ] **Step 3: 라우트 구현**

`src/server/modules/backtest/presentation/backtest-routes.ts` 의 `POST /backtests/:id/clone` 핸들러 **뒤**에 추가:

```ts
  /**
   * 재설정 및 복제용 초안 (D-025). 읽기 전용 — 대기열에 넣지 않고 데이터셋 버전도 고정하지 않는다.
   * 검증을 **돌리되 막지 않는다**: 여기서 400 으로 끊으면 조건이 틀어진 백테스트를 고칠
   * 화면 자체가 열리지 않는다. 실제 차단은 제출 시점 POST /backtests 가 그대로 지킨다.
   */
  app.get('/backtests/:id/clone-draft', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });

    const rebased = rebaseStoredRequest(
      job.requestJson,
      strategies.get(job.strategyId)?.version ?? null,
    );
    if (!rebased.ok) return reply.code(400).send({ error: rebased.error });

    const validated = validateSubmission(rebased.request);
    return {
      request: rebased.request,
      warnings: rebased.warnings,
      blockers: validated.ok ? [] : validated.errors,
    };
  });
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run tests/integration/job-queue.test.ts`
Expected: PASS 전부.

- [ ] **Step 5: 전체 검증 후 커밋**

```bash
pnpm typecheck && pnpm lint && npx vitest run
git add src/server/modules/backtest/presentation/backtest-routes.ts tests/integration/job-queue.test.ts
git commit -m "feat(backtest): clone-draft — 검증은 알리고 막지 않는 복제 초안 (D-025)"
```

---

### Task 5: 웹 — `requestToFormState` 순수 변환

저장된 요청을 위저드 폼 상태로 옮긴다. 원본이 가리키는 전략·데이터셋·종목이 사라질 수 있으므로 없는 참조는 비우고 사유를 알린다. 위저드가 커지지 않게 순수 함수로 분리해 단위 테스트로 규칙을 고정한다.

**Files:**
- Create: `src/web/features/backtests/prefill.ts`
- Test: `tests/unit/prefill.test.ts`

**Interfaces:**
- Consumes: `BacktestRequestBody` (`src/web/features/backtests/types.ts`, 기존)
- Produces:
  - `interface WizardFormState { strategyId: string | null; parameters: Record<string, string>; datasetId: string | null; symbols: string[]; from: string; to: string; initialCash: string; maxPositions: string; commissionProfileId: string; slippageProfileId: string; randomSeed: string }`
  - `interface PrefillCatalog { strategyIds: readonly string[]; datasets: readonly { id: string; symbols: string[] }[] }`
  - `requestToFormState(request: BacktestRequestBody, catalog: PrefillCatalog): { state: WizardFormState; notes: string[] }`
  - Task 6 의 위저드가 전부 소비한다.

- [ ] **Step 1: 실패하는 테스트 작성**

Create `tests/unit/prefill.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { requestToFormState } from '../../src/web/features/backtests/prefill';
import type { BacktestRequestBody } from '../../src/web/features/backtests/types';

const request: BacktestRequestBody = {
  strategyId: 'hourly-breakout',
  strategyVersion: '1.2.0',
  parameters: { lookbackBars: 10, atrPeriod: 5 },
  datasetId: 'ds_1',
  universe: { type: 'SYMBOLS', symbols: ['005930', '000660'] },
  period: { from: '2025-07-27', to: '2026-07-24' },
  capital: { initialCash: 10_000_000, currency: 'KRW' },
  execution: {
    fillTiming: 'NEXT_BAR_OPEN',
    commissionProfileId: 'kr-equity-default',
    slippageProfileId: 'fixed-5bps',
  },
  risk: { maxPositions: 5 },
  randomSeed: 42,
};

const catalog = {
  strategyIds: ['hourly-breakout'],
  datasets: [{ id: 'ds_1', symbols: ['005930', '000660'] }],
};

describe('requestToFormState', () => {
  it('모든 값을 문자열 폼 상태로 옮긴다', () => {
    const { state, notes } = requestToFormState(request, catalog);
    expect(notes).toEqual([]);
    expect(state.strategyId).toBe('hourly-breakout');
    expect(state.parameters).toEqual({ lookbackBars: '10', atrPeriod: '5' });
    expect(state.datasetId).toBe('ds_1');
    expect(state.symbols).toEqual(['005930', '000660']);
    expect(state.from).toBe('2025-07-27');
    expect(state.to).toBe('2026-07-24');
    expect(state.initialCash).toBe('10000000');
    expect(state.maxPositions).toBe('5');
    expect(state.randomSeed).toBe('42');
  });

  it('데이터셋이 사라지면 데이터셋·종목을 비우고 알린다', () => {
    const { state, notes } = requestToFormState(request, {
      ...catalog,
      datasets: [],
    });
    expect(state.datasetId).toBeNull();
    expect(state.symbols).toEqual([]);
    expect(notes.some((n) => n.includes('데이터셋'))).toBe(true);
  });

  it('사라진 종목만 제외하고 알린다', () => {
    const { state, notes } = requestToFormState(request, {
      ...catalog,
      datasets: [{ id: 'ds_1', symbols: ['005930'] }],
    });
    expect(state.symbols).toEqual(['005930']);
    expect(notes.some((n) => n.includes('000660'))).toBe(true);
  });

  it('전략이 사라지면 전략과 파라미터를 비우고 알린다', () => {
    const { state, notes } = requestToFormState(request, { ...catalog, strategyIds: [] });
    expect(state.strategyId).toBeNull();
    expect(state.parameters).toEqual({});
    expect(notes.some((n) => n.includes('hourly-breakout'))).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run tests/unit/prefill.test.ts`
Expected: FAIL — 모듈 `prefill` 을 찾을 수 없다.

- [ ] **Step 3: 구현**

Create `src/web/features/backtests/prefill.ts`:

```ts
import type { BacktestRequestBody } from './types';

/** 위저드 입력 상태 — 폼이므로 전부 문자열로 보관한다 */
export interface WizardFormState {
  strategyId: string | null;
  parameters: Record<string, string>;
  datasetId: string | null;
  symbols: string[];
  from: string;
  to: string;
  initialCash: string;
  maxPositions: string;
  commissionProfileId: string;
  slippageProfileId: string;
  randomSeed: string;
}

/** 지금 고를 수 있는 것들 — 사라진 참조를 판정하는 기준 */
export interface PrefillCatalog {
  strategyIds: readonly string[];
  datasets: readonly { id: string; symbols: string[] }[];
}

/**
 * 저장된 요청을 위저드 폼 상태로 옮긴다 (D-025).
 * 원본이 가리키는 전략·데이터셋·종목이 그 사이 사라질 수 있다 — 조용히 통과시키면
 * 사용자가 모르고 제출한다. 없는 참조는 비우고 무엇이 빠졌는지 notes 로 알린다.
 */
export function requestToFormState(
  request: BacktestRequestBody,
  catalog: PrefillCatalog,
): { state: WizardFormState; notes: string[] } {
  const notes: string[] = [];

  const strategyExists = catalog.strategyIds.includes(request.strategyId);
  if (!strategyExists) {
    notes.push(`전략 ${request.strategyId} 이 더 이상 등록돼 있지 않습니다 — 다시 고르세요.`);
  }

  const dataset = catalog.datasets.find((d) => d.id === request.datasetId) ?? null;
  let symbols: string[] = [];
  if (!dataset) {
    notes.push('원본 데이터셋이 더 이상 없습니다 — 다시 고르세요.');
  } else {
    const available = new Set(dataset.symbols);
    symbols = request.universe.symbols.filter((s) => available.has(s));
    const dropped = request.universe.symbols.filter((s) => !available.has(s));
    if (dropped.length > 0) {
      notes.push(`데이터셋에서 사라진 종목을 제외했습니다: ${dropped.join(', ')}`);
    }
  }

  return {
    state: {
      strategyId: strategyExists ? request.strategyId : null,
      // 전략이 없으면 파라미터도 의미가 없다 — 새로 고른 전략의 기본값이 채워진다
      parameters: strategyExists
        ? Object.fromEntries(
            Object.entries(request.parameters).map(([key, value]) => [key, String(value)]),
          )
        : {},
      datasetId: dataset?.id ?? null,
      symbols,
      from: request.period.from,
      to: request.period.to,
      initialCash: String(request.capital.initialCash),
      maxPositions: String(request.risk.maxPositions),
      commissionProfileId: request.execution.commissionProfileId,
      slippageProfileId: request.execution.slippageProfileId,
      randomSeed: String(request.randomSeed),
    },
    notes,
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run tests/unit/prefill.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 전체 검증 후 커밋**

```bash
pnpm typecheck && pnpm lint && npx vitest run
git add src/web/features/backtests/prefill.ts tests/unit/prefill.test.ts
git commit -m "feat(web): 복제 초안 → 위저드 폼 상태 변환 (D-025)"
```

---

### Task 6: 웹 — 위저드 프리필 (`?from=`)

`/backtests/new?from=<jobId>` 로 들어오면 초안을 조회해 폼을 채우고 1단계(전략)부터 시작한다.

**Files:**
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx`

**Interfaces:**
- Consumes: `GET /backtests/:id/clone-draft` (Task 4), `requestToFormState` / `PrefillCatalog` (Task 5)
- Produces: `/backtests/new?from=<jobId>` 경로 계약 — Task 7 의 버튼이 이 URL 로 링크한다.

- [ ] **Step 1: import 추가**

`src/web/features/backtests/new-backtest-wizard.tsx` 상단:

```ts
import { useNavigate, useSearchParams } from 'react-router';
```

(기존 `import { useNavigate } from 'react-router';` 를 교체)

그리고 타입·함수 import 추가:

```ts
import { requestToFormState } from './prefill';
import type { BacktestRequestBody } from './types';
```

(`BacktestRequestBody` 는 이미 import 되어 있으므로 `requestToFormState` 만 추가한다)

- [ ] **Step 2: 초안 조회와 프리필 effect 추가**

`const profiles = useQuery({...});` 블록 **뒤**, `const selectedStrategy = ...` **앞**에 삽입:

```ts
  const [searchParams] = useSearchParams();
  const sourceJobId = searchParams.get('from');

  const draft = useQuery({
    queryKey: ['backtests', sourceJobId, 'clone-draft'],
    queryFn: () =>
      api<{ request: BacktestRequestBody; warnings: string[]; blockers: string[] }>(
        `/backtests/${sourceJobId}/clone-draft`,
      ),
    enabled: sourceJobId !== null,
  });
```

- [ ] **Step 3: 프리필 effect 추가**

기존 `seededFor` effect **뒤**(즉 `const pickStrategy = ...` 앞)에 삽입:

```ts
  // 프리필은 원본 작업당 한 번만 — 사용자가 편집을 시작한 뒤 덮어쓰지 않는다.
  const prefilledFrom = useRef<string | null>(null);
  const [prefillNotes, setPrefillNotes] = useState<string[]>([]);
  useEffect(() => {
    if (sourceJobId === null || !draft.data) return;
    if (prefilledFrom.current === sourceJobId) return;
    // 카탈로그가 도착해야 사라진 참조를 판정할 수 있다
    if (!strategies.data || !datasets.data) return;
    prefilledFrom.current = sourceJobId;

    const { state, notes } = requestToFormState(draft.data.request, {
      strategyIds: strategies.data.strategies.map((s) => s.id),
      datasets: datasets.data.datasets,
    });
    setStrategyId(state.strategyId);
    setParameters(state.parameters);
    setDatasetId(state.datasetId);
    setSymbols(state.symbols);
    setFrom(state.from);
    setTo(state.to);
    setInitialCash(state.initialCash);
    setMaxPositions(state.maxPositions);
    setCommissionProfileId(state.commissionProfileId);
    setSlippageProfileId(state.slippageProfileId);
    setRandomSeed(state.randomSeed);
    setPrefillNotes(notes);
    // 기본값 시딩 effect 가 원본 파라미터를 덮어쓰지 못하게 막는다.
    // 사용자가 전략을 직접 바꾸면 pickStrategy 가 null 로 리셋해 정상 동작한다.
    seededFor.current = state.strategyId;
  }, [sourceJobId, draft.data, strategies.data, datasets.data]);
```

- [ ] **Step 4: 로딩 게이트와 헤딩·알림 렌더**

`return (` 직전에 추가:

```ts
  // 프리필 중에는 폼을 감춘다 — 입력하던 값이 프리필에 덮이는 경합을 없앤다
  const prefilling =
    sourceJobId !== null && prefilledFrom.current !== sourceJobId && !draft.isError;
```

그리고 `<h2 className="text-lg font-semibold">새 백테스트</h2>` 를 다음으로 교체:

```tsx
      <h2 className="text-lg font-semibold">
        {sourceJobId !== null ? '재설정 및 복제' : '새 백테스트'}
      </h2>

      {draft.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {draft.error instanceof ApiError ? draft.error.message : '원본 설정을 불러올 수 없습니다'}
          </AlertDescription>
        </Alert>
      ) : null}

      {(draft.data?.blockers ?? []).length > 0 ? (
        <Alert variant="destructive">
          <AlertDescription>
            원본 그대로는 제출할 수 없습니다 — 아래를 고치세요.
            <ul className="mt-1 list-disc pl-5">
              {(draft.data?.blockers ?? []).map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {[...(draft.data?.warnings ?? []), ...prefillNotes].length > 0 ? (
        <Alert>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {[...(draft.data?.warnings ?? []), ...prefillNotes].map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {prefilling ? <Skeleton className="h-64 w-full" /> : null}
```

- [ ] **Step 5: 프리필 중 단계 UI 감추기**

단계별 렌더의 조건에 `!prefilling` 을 더한다. 다음 다섯 곳을 각각 교체:

- `{step === 0 ? (` → `{!prefilling && step === 0 ? (`
- `{step === 1 ? (` → `{!prefilling && step === 1 ? (`
- `{step === 2 ? (` → `{!prefilling && step === 2 ? (`
- `{step === 3 ? (` → `{!prefilling && step === 3 ? (`
- `{step >= 4 ? (` → `{!prefilling && step >= 4 ? (`

그리고 하단 네비게이션 `<div className="flex items-center justify-between gap-2">` 블록 전체를 `{prefilling ? null : ( ... )}` 로 감싼다.

- [ ] **Step 6: import 보강**

`Skeleton` 과 `ApiError` 가 필요하다. `ApiError` 는 이미 import 되어 있다. `Skeleton` 을 추가:

```ts
import { Skeleton } from '@/components/ui/skeleton';
```

- [ ] **Step 7: 검증**

Run: `pnpm typecheck && pnpm lint && npx vitest run`
Expected: 전부 통과.

- [ ] **Step 8: 커밋**

```bash
git add src/web/features/backtests/new-backtest-wizard.tsx
git commit -m "feat(web): 위저드 ?from= 프리필 — 재설정 및 복제 (D-025)"
```

---

### Task 7: 웹 — 상세 페이지 버튼 분리 + D-025 기록

터미널 상태에서 두 버튼을 노출하고, 실패한 작업은 `재설정 및 복제` 를 주버튼으로 올린다.

**Files:**
- Modify: `src/web/features/backtests/backtest-detail-page.tsx`
- Modify: `docs/DECISIONS.md`

**Interfaces:**
- Consumes: `/backtests/new?from=<jobId>` (Task 6)
- Produces: 없음

- [ ] **Step 1: 아이콘 import 추가**

`src/web/features/backtests/backtest-detail-page.tsx` 의

```ts
import { Copy, Download, Trash2, XCircle } from 'lucide-react';
```

를 다음으로 교체 (`Link` 는 이미 import 되어 있다):

```ts
import { Copy, Download, SlidersHorizontal, Trash2, XCircle } from 'lucide-react';
```

- [ ] **Step 2: 버튼 블록 교체**

기존 단일 복제 버튼

```tsx
              <Button
                variant="outline"
                className="h-11"
                onClick={() => cloneMutation.mutate()}
                disabled={cloneMutation.isPending}
              >
                <Copy data-icon="inline-start" />
                복제 실행
              </Button>
```

를 다음으로 교체:

```tsx
              {/* 실패한 작업은 같은 조건 재실행이 대개 같은 결과다 — 재설정을 앞세운다 */}
              {job.status === 'FAILED' ? (
                <>
                  <Button className="h-11" asChild>
                    <Link to={`/backtests/new?from=${id}`}>
                      <SlidersHorizontal data-icon="inline-start" />
                      재설정 및 복제
                    </Link>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11"
                    onClick={() => cloneMutation.mutate()}
                    disabled={cloneMutation.isPending}
                  >
                    <Copy data-icon="inline-start" />
                    복제
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    className="h-11"
                    onClick={() => cloneMutation.mutate()}
                    disabled={cloneMutation.isPending}
                  >
                    <Copy data-icon="inline-start" />
                    복제
                  </Button>
                  <Button variant="outline" className="h-11" asChild>
                    <Link to={`/backtests/new?from=${id}`}>
                      <SlidersHorizontal data-icon="inline-start" />
                      재설정 및 복제
                    </Link>
                  </Button>
                </>
              )}
```

- [ ] **Step 3: 중단 안내문의 문구 정정**

INTERRUPTED 안내문의 인라인 버튼 문구 `복제 실행` 을 `복제` 로 바꾼다 (§10 복구는 동일 재실행이 맞으므로 동작은 그대로):

```tsx
            서버 재시작으로 중단되었습니다. 자동 재실행되지 않으니 복제를 사용하세요.
            <Button variant="link" className="h-auto p-0 pl-2" onClick={() => cloneMutation.mutate()}>
              복제
            </Button>
```

- [ ] **Step 4: 복제 성공 토스트 문구 확인**

`cloneMutation` 의 `toast.success('복제되어 대기열에 추가되었습니다')` 는 그대로 둔다 — 이 경로는 `복제` 뿐이다.

- [ ] **Step 5: D-025 결정 기록**

`docs/DECISIONS.md` 파일 끝(D-024 아래)에 추가:

```markdown
## D-025: 복제를 두 갈래로 — 그리고 제출 검증이 기간을 보게 했다

- **변경 내용:** 상세 화면의 단일 "복제 실행" 을 `복제`(동일 조건 즉시 재실행)와
  `재설정 및 복제`(원본 값으로 프리필된 위저드를 전략부터 다시)로 분리했다. 후자는
  읽기 전용 `GET /backtests/:id/clone-draft` 가 재기준된 요청·경고·`blockers` 를 주고,
  위저드가 `?from=<jobId>` 로 그 값을 채운 뒤 평범한 `POST /backtests` 로 제출한다.
- **제출 검증 보강 (같은 릴리스):** `validateSubmission` 이 기간에 봉이 있는지 보지 않아,
  D-024 의 실행이 201 로 접수되고 한참 뒤 FAILED 로 끝났다. `data_coverage` 로 기간 ×
  커버리지 겹침을 검사해 **요청한 종목 전부가 구간 밖이면 400** 으로 즉시 거부하고
  보유 범위를 메시지에 담는다. 심볼 멤버십 검사만으로는 부족했다 — 그건 설정된
  유니버스 기준이라 아직 한 번도 동기화되지 않은 종목이 통과한다.
- **일부만 비면 거부하지 않는다:** 신규 상장처럼 이력이 짧은 종목 하나로 유니버스
  전체를 막는 건 과하다. 대신 자식 프로세스가 실제로 봉을 낸 심볼과 비교해 제외된
  종목을 실행 경고로 남긴다 — 커버리지 추정이 아니라 실측이다.
- **초안은 검증을 돌리되 막지 않는다:** `clone-draft` 에서 400 으로 끊으면 조건이
  틀어진 백테스트를 고칠 화면 자체가 열리지 않는다. 사유를 `blockers` 로 돌려 위저드
  1단계에서 알리고, 실제 차단은 제출 시점이 지킨다. 현행 `/clone` 이 검증 제출 검증을
  통과해야 하는 성질은 그대로 둔다 — 동일 조건 재실행은 조건이 유효할 때만 뜻이 있다.
- **계보는 기록하지 않는다:** 재설정 경로는 전략까지 바꿀 수 있어 "원본의 복제" 라
  부르기 애매하다. 평범한 신규 제출로 두고 감사 로그에는 `backtest.created` 로만 남긴다.
- **경계 계산 공유:** `periodToTsRange` 를 `src/shared/schemas/backtest-request.ts` 로
  빼 제출 검증과 실행부가 함께 쓴다. 각자 계산하면 제출 검증은 통과시키는데 실행부는 0봉을 보는
  D-024 와 같은 종류의 어긋남이 생긴다.
```

- [ ] **Step 6: 전체 검증**

Run: `pnpm typecheck && pnpm lint && npx vitest run`
Expected: 전부 통과.

- [ ] **Step 7: 앱에서 눈으로 확인**

`pnpm dev` 와 `pnpm dev:web` 을 띄우고 확인한다:
1. 완료된 백테스트 상세 → `복제`(주버튼) + `재설정 및 복제`(외관선) 순서
2. 실패한 백테스트 상세 → `재설정 및 복제`(주버튼) 가 앞
3. `재설정 및 복제` 클릭 → 1단계(전략)에서 시작하고 원본 전략·파라미터·데이터셋·종목·
   기간·자본이 채워져 있다
4. 봉 없는 기간으로 제출 → 즉시 400 알림에 보유 범위가 보인다 (한참 뒤 FAILED 가 아니다)

- [ ] **Step 8: 커밋**

```bash
git add src/web/features/backtests/backtest-detail-page.tsx docs/DECISIONS.md
git commit -m "feat(web): 복제 / 재설정 및 복제 버튼 분리 (D-025)"
```

---

### Task 8: 대기열 상한 (429)

`enqueue` 에 대기열 깊이 제한이 없어 `복제` 연타로 QUEUED 가 무한히 쌓인다. 동시 실행 상한이 1이라 서버가 죽지는 않지만, 리소스 가드는 제출 순간의 여유만 보고 이미 쌓인 대기열은 보지 않는다.

**Task 2 이후 아무 때나 할 수 있는 독립 태스크다** — Task 4~7 과 의존이 없다. 다만 Task 2 와 같은 파일(`backtest-routes.ts`)을 만지므로 Task 2 뒤에 둔다.

**Files:**
- Modify: `src/server/bootstrap/config.ts`
- Modify: `src/server/bootstrap/server.ts:74-86`
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts`
- Test: `tests/integration/job-queue.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: `queue.countByStatus(statuses: BacktestJobStatus[]): number` (기존)
- Produces: `BacktestRouteDeps.maxQueuedBacktests: number`, `AppConfig.maxQueuedBacktests: number`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/integration/job-queue.test.ts` 의 describe 종료 앞에 추가. 상한을 3으로 낮춘 별도 앱을 띄워 빠르게 채운다:

```ts
  it('대기열 상한을 넘는 제출을 429 로 거부한다 (신규·복제 공통)', async () => {
    const small = await createTestApp({ MAX_QUEUED_BACKTESTS: '3' });
    try {
      const { username, password } = await createTestAdmin(small.container);
      const login = await small.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const smallCookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      await small.container.datasetService.importCsv({
        datasetName: 'kr-hourly-v1',
        market: 'KR',
        timeframe: '1h',
        symbol: '005930',
        fileName: 'trend.csv',
        csvContent: buildTrendingHourlyCsv(),
      });
      const smallDatasetId = small.container.datasetService.listDatasets()[0]!.id;
      const payload = buildRequest(smallDatasetId);

      // 오케스트레이터를 tick 하지 않으므로 전부 QUEUED 로 남는다
      for (let i = 0; i < 3; i += 1) {
        const accepted = await small.app.inject({
          method: 'POST',
          url: '/api/v1/backtests',
          cookies: { qp_session: smallCookie },
          payload,
        });
        expect(accepted.statusCode).toBe(201);
      }

      const rejected = await small.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: smallCookie },
        payload,
      });
      expect(rejected.statusCode).toBe(429);
      expect((rejected.json() as { error: string }).error).toContain('대기');

      // 복제도 같은 상한을 받는다
      const queued = small.container.jobQueue.listJobs(1, 0)[0]!;
      const clonedOverLimit = await small.app.inject({
        method: 'POST',
        url: `/api/v1/backtests/${queued.id}/clone`,
        cookies: { qp_session: smallCookie },
      });
      expect(clonedOverLimit.statusCode).toBe(429);
    } finally {
      await small.close();
    }
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run tests/integration/job-queue.test.ts`
Expected: FAIL — `expected 201 to be 429` (상한이 없어 네 번째도 접수된다).

- [ ] **Step 3: 설정 추가**

`src/server/bootstrap/config.ts` 의 `MAX_CONCURRENT_BACKTESTS` 줄 **뒤**에 추가:

```ts
  /** 대기(QUEUED) 백테스트 상한 — 연타로 대기열이 무한히 쌓이는 것을 막는다 (D-025) */
  MAX_QUEUED_BACKTESTS: z.coerce.number().int().min(1).max(200).default(20),
```

`readonly maxConcurrentBacktests: number;` 줄 **뒤**에 추가:

```ts
  readonly maxQueuedBacktests: number;
```

`maxConcurrentBacktests: raw.MAX_CONCURRENT_BACKTESTS,` 줄 **뒤**에 추가:

```ts
    maxQueuedBacktests: raw.MAX_QUEUED_BACKTESTS,
```

- [ ] **Step 4: 라우트에 상한 검사 추가**

`src/server/modules/backtest/presentation/backtest-routes.ts` 의 `BacktestRouteDeps` 에 필드 추가:

```ts
  readonly dataRoot: string;
  readonly maxQueuedBacktests: number;
```

`registerBacktestRoutes` 안, `checkResources` 사용부 근처(예: `validateSubmission` 정의 뒤)에 추가:

```ts
  /**
   * 대기열 깊이 상한 (D-025). QUEUED 만 센다 — 실행 중은 동시 실행 상한이 이미 묶고 있다.
   * 429 는 507(호스트 자원 부족)과 구분한다: 사용자가 할 일이 다르다(기다리거나 취소).
   */
  const queueDepthError = (): string | null => {
    const queued = queue.countByStatus(['QUEUED']);
    if (queued < deps.maxQueuedBacktests) return null;
    return `대기 중인 백테스트가 ${queued}건으로 상한(${deps.maxQueuedBacktests})에 도달했습니다. 완료되거나 취소된 뒤 제출하세요.`;
  };
```

`POST /backtests` 에서 `checkResources` **앞**에 삽입:

```ts
    const queueError = queueDepthError();
    if (queueError) return reply.code(429).send({ error: queueError });
```

`POST /backtests/:id/clone` 에서도 `checkResources` **앞**에 같은 두 줄을 삽입한다 (변수명 충돌이 없도록 핸들러마다 지역 변수를 새로 선언한다).

- [ ] **Step 5: 배선**

`src/server/bootstrap/server.ts` 의 `registerBacktestRoutes` deps 객체에서 `dataRoot: container.config.dataRoot,` 줄 뒤에 추가:

```ts
          maxQueuedBacktests: container.config.maxQueuedBacktests,
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npx vitest run tests/integration/job-queue.test.ts tests/unit/config.test.ts`
Expected: PASS 전부. `config.test.ts` 가 기본값 목록을 단정하면 `maxQueuedBacktests: 20` 을 추가한다.

- [ ] **Step 7: 예시 환경 파일에 반영**

`infra/app.env.example:13` 의 `MAX_CONCURRENT_BACKTESTS=1` 바로 뒤에 추가:

```
MAX_QUEUED_BACKTESTS=20
```

- [ ] **Step 8: 전체 검증 후 커밋**

```bash
pnpm typecheck && pnpm lint && npx vitest run
git add src/server/bootstrap/config.ts src/server/bootstrap/server.ts src/server/modules/backtest/presentation/backtest-routes.ts tests/integration/job-queue.test.ts infra/app.env.example
git commit -m "feat(backtest): 대기열 상한 429 — 복제 연타로 대기열이 무한히 쌓이는 것을 막는다 (D-025)"
```

- [ ] **Step 9: D-025 기록에 상한 항목 추가**

Task 7 Step 5 에서 쓴 D-025 항목 끝에 추가:

```markdown
- **대기열 상한:** `enqueue` 에 깊이 제한이 없어 `복제` 연타로 QUEUED 가 무한히 쌓였다.
  동시 실행 상한(기본 1)이 있어 서버가 죽지는 않지만, 리소스 가드는 제출 순간의 여유만
  보고 쌓인 대기열은 보지 않는다. `MAX_QUEUED_BACKTESTS`(기본 20)로 429 를 반환한다.
  QUEUED 만 센다 — 실행 중은 동시 실행 상한이 이미 묶는다. 429 를 507 과 구분하는 이유는
  사용자가 할 일이 다르기 때문이다(기다리거나 취소 vs 호스트 자원 확보).
```

```bash
git add docs/DECISIONS.md
git commit -m "docs: D-025 에 대기열 상한 기록"
```

---

## Self-Review

**1. 스펙 커버리지**

| 스펙 항목 | 태스크 |
|---|---|
| §1 기간 × 커버리지 검사, 전 종목 밖 → 400 + 범위 메시지 | Task 2 |
| §1 일부만 밖 → 통과 + 실행 경고 | Task 2 (통과) + Task 3 (경고) |
| §1 `periodToTsRange` 공유 | Task 1 |
| §2 두 경로 / 계보 미기록 | Task 4 (초안) + Task 6 (제출) + Task 7 (진입점) |
| §3 `clone-draft`, 검증하되 막지 않음, 404/400 | Task 4 |
| §3 `validateSubmission` → `errors[]`, 순서 유지, 의존 가드 | Task 2 |
| §4 위저드 프리필, `seededFor` 충돌, 로딩 스켈레톤, 헤딩, blockers/warnings | Task 6 |
| §4 사라진 참조 처리 | Task 5 |
| §4 상황별 버튼 강조, INTERRUPTED 링크 유지 | Task 7 |
| §1 대기열 상한 — `MAX_QUEUED_BACKTESTS`, QUEUED 만 셈, 429 vs 507 | Task 8 |
| §5 테스트 (통합 제출 검증·초안·회귀·대기열 상한, 단위 변환·경계) | Task 1~5 각 Step 1, Task 8 Step 1 |

빠진 항목 없음.

**2. 플레이스홀더** — 없음. 모든 코드 단계에 실제 코드가 있다. 컨테이너 속성명(`resultsService`), 기존 import 여부(`Link`, `ApiError`), TS 옵션(`noUncheckedIndexedAccess`)은 계획 작성 시 실물로 확인해 조건부 지시를 남기지 않았다.

**3. 타입 일관성** — `validateSubmission` 은 Task 2 에서 `{ ok: false; errors: string[] }` 로 정의되고 Task 4 가 `validated.errors` 로 소비한다. `requestToFormState` 는 Task 5 에서 `(request, catalog) => { state, notes }` 로 정의되고 Task 6 이 같은 형태로 호출한다. `periodToTsRange` 는 Task 1 에서 정의되고 Task 2 가 `{ fromTsMs, toTsMs }` 로 구조 분해한다. `clone-draft` 응답 `{ request, warnings, blockers }` 는 Task 4 정의와 Task 6 소비가 일치한다.
