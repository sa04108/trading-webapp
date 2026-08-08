# 알림 항목 설명·전략 한국어 이름 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스트 제출 경고를 job 에 영구 저장하고, 알림 항목 설명을 `전략 한국어 이름 · 수익률` + 경고 줄로 바꾸고, 대시보드의 전략 표기를 한국어 이름으로 바꾼다.

**Architecture:** `backtest_jobs` 에 `submit_warnings_json` 컬럼을 더해 `POST /backtests`·clone 이 응답으로만 내보내던 경고를 저장한다. `notification-wiring.ts` 가 전략 이름 조회 함수와 수익률 조회 함수를 주입받아 설명 문자열을 조립한다. 웹은 이미 `GET /strategies` 가 주는 한국어 이름을 쓰지 않고 있을 뿐이라, 공유 훅과 순수 라벨 함수를 뽑아 대시보드에 연결한다.

**Tech Stack:** TypeScript, Fastify, drizzle-orm + better-sqlite3, drizzle-kit, React + TanStack Query, vitest.

## Global Constraints

- 한국어 문서·주석은 `CLAUDE.md` 규칙을 따른다: 문어체 평서형(`~한다`), 번역투 금지, 주석은 "왜" 를 쓴다.
- 커밋 메시지는 한국어 본문 + `feat`/`fix`/`docs`/`refactor` 접두사. 아래 각 커밋 스텝의 문구를 그대로 쓴다.
- 마이그레이션은 `pnpm db:generate` 로 만든다. `migrations/*.sql` 을 손으로 쓰지 않는다 — drizzle 이 `migrations/meta/` journal 을 함께 갱신해야 `database.ts:56` 의 `migrate()` 가 충돌 없이 돈다.
- `submit_warnings_json` 은 경고가 없으면 `null` 이다. 빈 배열 `'[]'` 을 넣지 않는다.
- 알림 설명에 넣는 지표는 **수익률뿐**이다. CAGR·MDD·Sharpe 를 넣지 않는다.
- 백테스트 결과 화면(`backtest-detail-page.tsx`, `result-charts.tsx`)의 영어 지표명(CAGR·MDD·Sharpe·`Drawdown`)은 건드리지 않는다.
- 검증 명령: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

---

## File Structure

**서버**

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/server/shared/db/schema.ts` | 테이블 정의 | `backtestJobs` 에 `submitWarningsJson` 추가 |
| `migrations/0011_*.sql` + `migrations/meta/` | 스키마 이력 | `pnpm db:generate` 산출물 |
| `src/server/modules/backtest/application/job-queue.ts` | 잡 큐 | `enqueue` 에 `submitWarnings` 파라미터 |
| `src/server/modules/backtest/presentation/backtest-routes.ts` | 제출·복제 라우트 | `enqueue` 호출 두 곳에 경고 전달 |
| `src/server/modules/backtest/application/results-service.ts` | 결과 조회 | `getTotalReturnPct` 추가 |
| `src/server/bootstrap/notification-wiring.ts` | 알림 설명 조립 | 의존 두 개 추가, body 조립 |
| `src/server/bootstrap/container.ts` | 배선 | 레지스트리·결과 서비스를 리스너 등록 앞으로 |

**웹**

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/web/features/backtests/strategy-label.ts` | 순수 라벨 함수 (신규) | `strategyLabel(strategyId, strategies)` |
| `src/web/features/backtests/api.ts` | 백테스트 쿼리 훅 | `useStrategies()` 추가 |
| `src/web/features/dashboard/dashboard-page.tsx` | 대시보드 | 두 카드에서 한국어 이름 사용 |
| `src/web/features/backtests/backtest-detail-page.tsx` | 상세 화면 | 중복 `useQuery` → `useStrategies()` |
| `src/web/features/backtests/backtests-page.tsx` | 목록 화면 | 중복 `useQuery` → `useStrategies()` |
| `src/web/features/backtests/new-backtest-wizard.tsx` | 위저드 | 중복 `useQuery` → `useStrategies()` |

**테스트**

| 파일 | 변경 |
|---|---|
| `tests/integration/job-queue.test.ts` | `submitWarningsJson` 저장·null 검증 |
| `tests/integration/backtest-universe-rule-run.test.ts` | 제출 경고 저장, 알림 설명 end-to-end |
| `tests/unit/notification-wiring.test.ts` | 설명 조립 전 경우 |
| `tests/unit/strategy-label.test.ts` | 라벨 함수 (신규) |

---

## Task 1: 제출 경고를 job 에 저장한다

**Files:**
- Modify: `src/server/shared/db/schema.ts:324` 근처 (`backtestJobs` 의 `error` 아래)
- Create: `migrations/0011_*.sql` (drizzle-kit 생성)
- Modify: `src/server/modules/backtest/application/job-queue.ts:41-68`
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts:801-806`, `:910-915`
- Test: `tests/integration/job-queue.test.ts`, `tests/integration/backtest-universe-rule-run.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `backtestJobs.submitWarningsJson: text('submit_warnings_json')` — nullable
  - `BacktestJobRow['submitWarningsJson']: string | null` (`$inferSelect` 로 자동 파생)
  - `JobQueue.enqueue(request, schedule?, pinnedUniverse?, provenancePin?, submitWarnings?: readonly string[]): BacktestJobRow`

- [ ] **Step 1: 실패하는 테스트를 쓴다 — enqueue 저장·생략**

`tests/integration/job-queue.test.ts` 의 `describe` 안에 두 케이스를 더한다. 파일 상단에 `buildRequest`, `ctx` 가 이미 있다 (기존 테스트가 쓰는 헬퍼다).

```ts
  it('제출 경고를 job 에 저장한다 — 토스트 10초 뒤에도 남아야 한다', () => {
    const job = ctx.container.jobQueue.enqueue(
      buildRequest(),
      [],
      undefined,
      null,
      ['005930 자본변동 이력에 gap 이 있습니다'],
    );

    const stored = ctx.container.jobQueue.getJob(job.id)!;
    expect(JSON.parse(stored.submitWarningsJson!)).toEqual([
      '005930 자본변동 이력에 gap 이 있습니다',
    ]);
  });

  it('경고가 없으면 null 이다 — 빈 배열이면 "컬럼이 생기기 전 job" 과 구분되지 않는다', () => {
    const job = ctx.container.jobQueue.enqueue(buildRequest());

    expect(ctx.container.jobQueue.getJob(job.id)!.submitWarningsJson).toBeNull();
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run tests/integration/job-queue.test.ts -t '제출 경고'`
Expected: FAIL — `submitWarningsJson` 이 `BacktestJobRow` 에 없어 typecheck·런타임 모두 깨진다.

- [ ] **Step 3: 스키마에 컬럼을 더한다**

`src/server/shared/db/schema.ts`, `backtestJobs` 의 `error: text('error'),` 바로 아래:

```ts
    /**
     * 제출·복제 검증이 만든 경고 원문(string[]). 화면 토스트는 10초 뒤 사라지므로
     * 자본변동 gap 같은 "확인하지 못했다" 를 남길 곳이 여기밖에 없다.
     * null 은 경고가 없었거나 이 컬럼이 생기기 전에 만들어진 job 이다.
     */
    submitWarningsJson: text('submit_warnings_json'),
```

- [ ] **Step 4: 마이그레이션을 생성한다**

Run: `pnpm db:generate`
Expected: `migrations/0011_<random>.sql` 이 생기고 `migrations/meta/0011_snapshot.json` 과 `_journal.json` 이 갱신된다. 생성된 SQL 이 `ALTER TABLE \`backtest_jobs\` ADD \`submit_warnings_json\` text;` 한 줄인지 확인한다. 테이블 재생성(`__new_backtest_jobs`) 형태로 나왔다면 다른 스키마 변경이 섞인 것이므로 그 변경을 되돌리고 다시 생성한다.

- [ ] **Step 5: enqueue 에 파라미터를 더한다**

`src/server/modules/backtest/application/job-queue.ts`, `provenancePin` 파라미터 뒤에 추가:

```ts
    /**
     * 제출 검증이 만든 경고 — 응답으로만 나가면 토스트와 함께 사라진다.
     * 기본값 `[]` 는 `schedule` 과 같은 이유다: 단위 테스트가 매번 채우지 않아도 된다.
     */
    submitWarnings: readonly string[] = [],
  ): BacktestJobRow {
```

`row` 리터럴의 `createdAtMs` 바로 위에 한 줄:

```ts
      submitWarningsJson: submitWarnings.length > 0 ? JSON.stringify(submitWarnings) : null,
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/integration/job-queue.test.ts -t '제출 경고'` 와 `pnpm vitest run tests/integration/job-queue.test.ts -t '경고가 없으면'`
Expected: 둘 다 PASS

- [ ] **Step 7: 라우트 두 곳이 경고를 넘기는 테스트를 쓴다**

`tests/integration/backtest-universe-rule-run.test.ts` 의 `'gap 이 난 종목은 통과하고 경고에 이름이 나온다'` 케이스 끝에 두 줄을 붙인다 (응답 경고를 이미 검증하는 케이스다):

```ts
    // 응답에만 실어 보내면 토스트 10초가 유일한 수명이 된다 — job 에도 남아야 한다
    const jobId = (created.json().job as { id: string }).id;
    const stored = ctx.container.jobQueue.getJob(jobId)!;
    expect(JSON.parse(stored.submitWarningsJson!)).toEqual(warnings);
```

`tests/integration/job-queue.test.ts` 의 `'rebases a stored request that predates the current schema, and warns'` 케이스 끝에 붙인다 (`body` 가 이미 있다):

```ts
    // 복제 경로도 같다 — rebase 경고와 검증 경고를 합쳐 저장한다
    const clonedStored = ctx.container.jobQueue.getJob(body.job.id)!;
    expect(JSON.parse(clonedStored.submitWarningsJson!)).toEqual(body.warnings);
```

- [ ] **Step 8: 실패를 확인한다**

Run: `pnpm vitest run tests/integration/backtest-universe-rule-run.test.ts -t 'gap 이 난 종목'`
Expected: FAIL — `submitWarningsJson` 이 `null` 이라 `JSON.parse(null!)` 이 던진다.

- [ ] **Step 9: 라우트에서 경고를 넘긴다**

`backtest-routes.ts` 신규 제출 (`:801`):

```ts
    const job = queue.enqueue(
      { ...body, timeframe: validated.timeframe },
      validated.resolved.schedule,
      validated.universe,
      validated.provenancePin,
      validated.warnings,
    );
```

`backtest-routes.ts` 복제 (`:910`). 응답이 합집합을 내보내므로(`:923`) 저장도 같은 합집합이다 — 한쪽만 고치면 화면과 기록이 갈라진다:

```ts
    const cloneWarnings = [...rebased.warnings, ...validated.warnings];
    const cloned = queue.enqueue(
      { ...cloneRequest, timeframe: validated.timeframe },
      validated.resolved.schedule,
      validated.universe,
      validated.provenancePin,
      cloneWarnings,
    );
```

같은 핸들러의 응답 줄(`:923`)도 새 변수를 쓰게 바꾼다:

```ts
    return reply.code(201).send({ job: serializeJob(cloned), warnings: cloneWarnings });
```

- [ ] **Step 10: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/integration/backtest-universe-rule-run.test.ts tests/integration/job-queue.test.ts`
Expected: PASS (전체 파일 — 기존 케이스 회귀 없음 확인)

- [ ] **Step 11: 타입·린트를 확인한다**

Run: `pnpm typecheck && pnpm lint`
Expected: 오류 없음

- [ ] **Step 12: 커밋**

```bash
git add src/server/shared/db/schema.ts migrations src/server/modules/backtest/application/job-queue.ts src/server/modules/backtest/presentation/backtest-routes.ts tests/integration/job-queue.test.ts tests/integration/backtest-universe-rule-run.test.ts
git commit -m "feat(backtest): 제출 경고를 잡에 저장한다

응답으로만 나가던 warnings 는 토스트 10초가 유일한 수명이었다. 자본변동 gap
경고가 사라지면 \"수집했고 분할이 없었다\" 와 \"gap 이 나서 확인하지 못했다\" 가
같아 보인다. submit_warnings_json 에 남긴다."
```

---

## Task 2: 수익률 조회를 결과 서비스에 더한다

**Files:**
- Modify: `src/server/modules/backtest/application/results-service.ts:46-53` 아래
- Test: `tests/integration/backtest-universe-rule-run.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `ResultsService.getTotalReturnPct(jobId: string): number | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/integration/backtest-universe-rule-run.test.ts` 의 `'커버리지가 보고한 일봉으로 백테스트가 완주한다'` 케이스 끝에 붙인다 (실제 실행이 끝나 metrics 가 있는 자리다):

```ts
    // 알림 설명이 읽는 값 — getMetrics 의 metricsJson 파싱 결과와 같아야 한다
    const metrics = ctx.container.resultsService.getMetrics(jobId) as { totalReturnPct: number };
    expect(ctx.container.resultsService.getTotalReturnPct(jobId)).toBe(metrics.totalReturnPct);
    // 결과가 없는 잡은 null 이다 — 0 으로 떨어지면 "수익 0%" 로 읽힌다
    expect(ctx.container.resultsService.getTotalReturnPct('bt_없는잡')).toBeNull();
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run tests/integration/backtest-universe-rule-run.test.ts -t '완주한다'`
Expected: FAIL — `getTotalReturnPct is not a function`

- [ ] **Step 3: 메서드를 구현한다**

`results-service.ts`, `getMetrics` 바로 아래:

```ts
  /**
   * 알림 설명이 쓰는 수익률. `getMetrics` 는 metricsJson 을 통째로 파싱하니 값
   * 하나엔 과하다. 결과가 없으면 null — 0 을 돌려주면 "수익 0%" 로 읽힌다.
   */
  getTotalReturnPct(jobId: string): number | null {
    const row = this.db
      .select({ totalReturnPct: backtestMetrics.totalReturnPct })
      .from(backtestMetrics)
      .where(eq(backtestMetrics.jobId, jobId))
      .get();
    return row?.totalReturnPct ?? null;
  }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/integration/backtest-universe-rule-run.test.ts -t '완주한다'`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/backtest/application/results-service.ts tests/integration/backtest-universe-rule-run.test.ts
git commit -m "feat(backtest): 수익률 단건 조회를 결과 서비스에 더한다

알림 설명이 수익률 하나만 필요하다. getMetrics 는 metricsJson 을 통째로
파싱하니 그 자리에 쓰기엔 과하다."
```

---

## Task 3: 알림 항목 설명을 조립한다

**Files:**
- Modify: `src/server/bootstrap/notification-wiring.ts` (전체)
- Modify: `src/server/bootstrap/container.ts:277-283`, `:311`
- Test: `tests/unit/notification-wiring.test.ts`

**Interfaces:**
- Consumes:
  - Task 1 의 `BacktestJobRow['submitWarningsJson']: string | null`
  - Task 2 의 `ResultsService.getTotalReturnPct(jobId: string): number | null`
  - 기존 `StrategyRegistry.describe(strategyId: string): StrategySummary | null` — `StrategySummary` 에 `name: string` 이 있다
- Produces:
  - `createBacktestNotificationListener(deps: { queue: Pick<JobQueue, 'getJob'>; strategyName: (strategyId: string) => string | null; totalReturnPct: (jobId: string) => number | null; notify: (input: NotificationInput) => void; logger: Logger }): (event: JobEvent) => void`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/notification-wiring.test.ts` 를 아래로 교체한다. `fakeJob`·`harness` 가 새 의존을 받도록 바뀌고, 기존 케이스는 새 `harness` 시그니처에 맞춰 그대로 살린다.

```ts
import { describe, expect, it } from 'vitest';
import { createBacktestNotificationListener } from '../../src/server/bootstrap/notification-wiring.js';
import type { NotificationInput } from '../../src/server/modules/notification/application/notification-service.js';
import type { BacktestJobRow } from '../../src/server/modules/backtest/application/job-queue.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));

function fakeJob(overrides: Partial<BacktestJobRow>): BacktestJobRow {
  return {
    id: 'bt_1',
    status: 'COMPLETED',
    strategyId: 'cross-sectional-momentum',
    error: null,
    submitWarningsJson: null,
    ...overrides,
  } as BacktestJobRow;
}

function harness(
  job: BacktestJobRow | null,
  options: {
    strategyName?: (strategyId: string) => string | null;
    totalReturnPct?: (jobId: string) => number | null;
  } = {},
) {
  const created: NotificationInput[] = [];
  const listener = createBacktestNotificationListener({
    queue: { getJob: () => job },
    strategyName: options.strategyName ?? (() => '횡단면 모멘텀'),
    totalReturnPct: options.totalReturnPct ?? (() => 12.345),
    notify: (input) => created.push(input),
    logger,
  });
  return { created, listener };
}

describe('createBacktestNotificationListener', () => {
  it('notifies on terminal status with a link to the job', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'backtest',
      severity: 'info',
      link: '/backtests/bt_1',
    });
  });

  it('완료 알림의 첫 줄에 전략 한국어 이름과 수익률을 함께 담는다', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    // 접힌 행은 한 줄만 보인다 — 이름과 수익률이 그 한 줄에 있어야 한다
    expect(created[0]?.body?.split('\n')[0]).toBe('횡단면 모멘텀 · 수익률 +12.35%');
  });

  it('손실은 + 없이 음수로 적는다', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }), {
      totalReturnPct: () => -8.9,
    });
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.body).toBe('횡단면 모멘텀 · 수익률 -8.90%');
  });

  it('완료인데 수익률을 못 읽으면 이름만 남긴다 — "-" 는 0 근처로 읽힌다', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }), {
      totalReturnPct: () => null,
    });
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.body).toBe('횡단면 모멘텀');
  });

  it('취소·중단은 수익률을 적지 않는다', () => {
    const { created, listener } = harness(fakeJob({ status: 'CANCELLED' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.body).toBe('횡단면 모멘텀');
  });

  it('marks FAILED as error severity and includes the error message', () => {
    const { created, listener } = harness(fakeJob({ status: 'FAILED', error: '메모리 부족' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.severity).toBe('error');
    expect(created[0]?.body).toBe('횡단면 모멘텀 — 메모리 부족');
  });

  it('marks INTERRUPTED as error severity — 재시작으로 고아가 된 잡도 사용자에게 알려야 한다', () => {
    const { created, listener } = harness(fakeJob({ status: 'INTERRUPTED' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.severity).toBe('error');
    expect(created[0]?.title).toBe('백테스트가 중단되었습니다');
  });

  it('제출 경고를 첫 줄 아래에 한 줄씩 붙인다', () => {
    const { created, listener } = harness(
      fakeJob({
        status: 'COMPLETED',
        submitWarningsJson: JSON.stringify(['005930 gap 이 있습니다', '기간이 최근입니다']),
      }),
    );
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.body).toBe(
      '횡단면 모멘텀 · 수익률 +12.35%\n경고: 005930 gap 이 있습니다\n경고: 기간이 최근입니다',
    );
  });

  it('등록이 풀린 전략은 strategyId 로 적는다', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }), {
      strategyName: () => null,
    });
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.body).toBe('cross-sectional-momentum · 수익률 +12.35%');
  });

  it('경고 JSON 이 깨져도 알림은 나간다 — 설명 조립 실패가 알림을 없애면 안 된다', () => {
    const { created, listener } = harness(
      fakeJob({ status: 'COMPLETED', submitWarningsJson: '{깨진 JSON' }),
    );
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created).toHaveLength(1);
    expect(created[0]?.body).toBe('횡단면 모멘텀 · 수익률 +12.35%');
  });

  it('ignores progress events, non-terminal statuses, and missing jobs', () => {
    const running = harness(fakeJob({ status: 'RUNNING' }));
    running.listener({ jobId: 'bt_1', kind: 'status' });
    running.listener({ jobId: 'bt_1', kind: 'progress' });
    expect(running.created).toEqual([]);

    const gone = harness(null);
    gone.listener({ jobId: 'bt_1', kind: 'status' });
    expect(gone.created).toEqual([]);
  });

  it('수익률 조회가 던져도 orchestrator 로 새지 않는다', () => {
    const { listener } = harness(fakeJob({ status: 'COMPLETED' }), {
      totalReturnPct: () => {
        throw new Error('db closed');
      },
    });
    expect(() => listener({ jobId: 'bt_1', kind: 'status' })).not.toThrow();
  });

  it('swallows notify failures — the orchestrator must not throw', () => {
    const listener = createBacktestNotificationListener({
      queue: { getJob: () => fakeJob({ status: 'COMPLETED' }) },
      strategyName: () => '횡단면 모멘텀',
      totalReturnPct: () => 1,
      notify: () => {
        throw new Error('insert failed');
      },
      logger,
    });
    expect(() => listener({ jobId: 'bt_1', kind: 'status' })).not.toThrow();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run tests/unit/notification-wiring.test.ts`
Expected: FAIL — `strategyName`·`totalReturnPct` 가 `deps` 타입에 없다

- [ ] **Step 3: notification-wiring.ts 를 다시 쓴다**

```ts
/**
 * 알림 생산자 연결 (설계 2026-08-03-notification-center, 2026-08-08-notification-body-and-korean-names).
 *
 * backtest 모듈이 notification 모듈을 import 하지 않도록 container 가 이 listener 를
 * orchestrator.events 에 건다 — facts-wiring 과 같은 관례로, 테스트가 겨눌 수 있는
 * 자리에 둔다.
 */
import type { JobEvent } from '../modules/backtest/application/job-orchestrator.js';
import type { BacktestJobRow, JobQueue } from '../modules/backtest/application/job-queue.js';
import type { NotificationInput } from '../modules/notification/application/notification-service.js';
import type { Logger } from '../shared/logger.js';

// status 컬럼은 리터럴 유니온이 아니라 text() 라 string 이다 — Record 키를
// BacktestJobRow['status'] 로 두면 string 전체가 키가 되어 의미가 없으므로 string 으로 둔다
const TERMINAL_NOTIFICATIONS: Partial<Record<string, { title: string; severity: 'info' | 'error' }>> =
  {
    COMPLETED: { title: '백테스트가 완료되었습니다', severity: 'info' },
    FAILED: { title: '백테스트가 실패했습니다', severity: 'error' },
    CANCELLED: { title: '백테스트가 취소되었습니다', severity: 'info' },
    INTERRUPTED: { title: '백테스트가 중단되었습니다', severity: 'error' },
  };

/**
 * 부호 붙은 백분율. 웹 `formatSignedPct` 와 규칙이 같다 — 공유하려면 `src/shared` 에
 * 서식 모듈을 새로 만들고 웹을 그쪽으로 돌려야 해서 여기 둔다.
 */
function signedPct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/** 저장된 경고 원문. 깨진 JSON 은 빈 배열로 — 설명 조립 실패가 알림을 없애면 안 된다 */
function parseSubmitWarnings(json: string | null, logger: Logger, jobId: string): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch (error) {
    logger.warn(
      { module: 'notification', event: 'notify.warnings.parse_failed', jobId, err: error },
      'submit warnings parse failed',
    );
    return [];
  }
}

export function createBacktestNotificationListener(deps: {
  queue: Pick<JobQueue, 'getJob'>;
  /** 전략 한국어 이름. 등록이 풀린 전략은 null — 그때는 strategyId 를 적는다 */
  strategyName: (strategyId: string) => string | null;
  /** backtest_metrics.total_return_pct. 결과가 없으면 null */
  totalReturnPct: (jobId: string) => number | null;
  notify: (input: NotificationInput) => void;
  logger: Logger;
}): (event: JobEvent) => void {
  return (event) => {
    if (event.kind !== 'status') return;
    // 알림 실패가 orchestrator 의 emit 경로를 끊으면 안 된다 — 삼키고 warn 만 남긴다
    try {
      const job: BacktestJobRow | null | undefined = deps.queue.getJob(event.jobId);
      if (!job) return;
      const terminal = TERMINAL_NOTIFICATIONS[job.status];
      if (!terminal) return;

      const label = deps.strategyName(job.strategyId) ?? job.strategyId;
      // 접힌 행은 한 줄만 보인다(notifications-page.tsx:43) — 첫 줄이 이름과 결과를 진다
      const headline = (() => {
        if (job.status === 'FAILED' && job.error) return `${label} — ${job.error}`;
        if (job.status !== 'COMPLETED') return label;
        const pct = deps.totalReturnPct(job.id);
        // 결과 기록 없이 완료로 표시된 잡이다. `수익률 -` 은 "0에 가깝다" 로 읽힌다
        return pct === null ? label : `${label} · 수익률 ${signedPct(pct)}`;
      })();

      const warnings = parseSubmitWarnings(job.submitWarningsJson, deps.logger, job.id);
      deps.notify({
        type: 'backtest',
        severity: terminal.severity,
        title: terminal.title,
        body: [headline, ...warnings.map((w) => `경고: ${w}`)].join('\n'),
        link: `/backtests/${job.id}`,
      });
    } catch (error) {
      deps.logger.warn(
        { module: 'notification', event: 'notify.backtest.failed', jobId: event.jobId, err: error },
        'backtest notification failed',
      );
    }
  };
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/unit/notification-wiring.test.ts`
Expected: PASS (13 케이스)

- [ ] **Step 5: container 배선 순서를 고친다**

`container.ts:311` 의 `strategyRegistry: new StrategyRegistry(),` 는 지금 return 문 안에서 인스턴스를 만든다. 리스너가 같은 인스턴스를 써야 하므로 위로 옮긴다 — 두 개를 만들면 레지스트리가 갈라진다.

`const jobQueue = new JobQueue(database, clock);` 위에 두 줄을 넣는다:

```ts
  // 알림 리스너와 라우트가 같은 인스턴스를 봐야 한다 — 두 개를 만들면 등록 목록이 갈라진다
  const strategyRegistry = new StrategyRegistry();
```

`const resultsService = new ResultsService(database.db);` (`:283`) 를 `jobOrchestrator.events.on(...)` **앞으로** 옮긴다. 그리고 리스너 등록을 이렇게 바꾼다:

```ts
  jobOrchestrator.events.on(
    'job',
    createBacktestNotificationListener({
      queue: jobQueue,
      strategyName: (strategyId) => strategyRegistry.describe(strategyId)?.name ?? null,
      totalReturnPct: (jobId) => resultsService.getTotalReturnPct(jobId),
      notify: safeNotify,
      logger,
    }),
  );
```

return 문의 `strategyRegistry: new StrategyRegistry(),` 를 `strategyRegistry,` 로 바꾼다.

- [ ] **Step 6: 알림 설명이 실제 실행에서 나오는지 검증하는 테스트를 쓴다**

`tests/integration/backtest-universe-rule-run.test.ts` 의 `'커버리지가 보고한 일봉으로 백테스트가 완주한다'` 케이스 끝(Task 2 에서 붙인 줄 아래)에 붙인다:

```ts
    // 배선 전체가 이어졌는지 — 리스너가 레지스트리 이름과 수익률을 함께 담는다
    const notification = ctx.container.notificationService
      .list()
      .find((row) => row.link === `/backtests/${jobId}`);
    expect(notification?.title).toBe('백테스트가 완료되었습니다');
    expect(notification?.body).toContain('전고점 돌파');
    expect(notification?.body).toContain('수익률');
    // kebab-case 식별자가 새면 안 된다
    expect(notification?.body).not.toContain('range-breakout');
```

전략 이름 `'전고점 돌파'` 는 이 파일의 `STRATEGY_ID` 에 대응한다 (`range-breakout.ts:126`). 파일 상단의 `STRATEGY_ID` 가 다른 값이면 그 전략의 `name` 으로 바꾼다.

- [ ] **Step 7: 통합 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/integration/backtest-universe-rule-run.test.ts -t '완주한다'`
Expected: PASS

- [ ] **Step 8: 타입·린트·전체 테스트를 확인한다**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 오류 없음, 전체 PASS

- [ ] **Step 9: 커밋**

```bash
git add src/server/bootstrap/notification-wiring.ts src/server/bootstrap/container.ts tests/unit/notification-wiring.test.ts tests/integration/backtest-universe-rule-run.test.ts
git commit -m "feat(notification): 알림 설명에 전략 이름·수익률·제출 경고를 담는다

설명이 strategyId 한 줄이라 결과가 어땠는지는 상세 화면까지 들어가야 알았다.
접힌 행이 한 줄만 보이므로 첫 줄이 이름과 수익률을 지고, 제출 경고는 그 아래에
한 줄씩 붙는다."
```

---

## Task 4: 전략 라벨 함수를 뽑는다

**Files:**
- Create: `src/web/features/backtests/strategy-label.ts`
- Test: `tests/unit/strategy-label.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `interface StrategyNameSource { readonly id: string; readonly name: string }`
  - `strategyLabel(strategyId: string, strategies: readonly StrategyNameSource[] | undefined): string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/strategy-label.test.ts` 를 새로 만든다. `tests/unit/job-groups.test.ts` 와 같은 자리·같은 방식이다 (순수 함수는 `.ts` 로 뽑아 테스트한다).

```ts
import { describe, expect, it } from 'vitest';
import { strategyLabel } from '../../src/web/features/backtests/strategy-label.js';

const STRATEGIES = [
  { id: 'cross-sectional-momentum', name: '횡단면 모멘텀' },
  { id: 'range-breakout', name: '전고점 돌파' },
];

describe('strategyLabel', () => {
  it('등록된 전략은 한국어 이름으로 바꾼다', () => {
    expect(strategyLabel('cross-sectional-momentum', STRATEGIES)).toBe('횡단면 모멘텀');
  });

  it('목록에 없는 전략은 strategyId 를 그대로 쓴다 — 등록이 풀린 전략의 지난 결과가 빈칸이 되면 안 된다', () => {
    expect(strategyLabel('deleted-strategy', STRATEGIES)).toBe('deleted-strategy');
  });

  it('응답이 아직 없으면 strategyId 를 쓴다 — 로딩 중 빈칸이 깜빡이면 안 된다', () => {
    expect(strategyLabel('range-breakout', undefined)).toBe('range-breakout');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run tests/unit/strategy-label.test.ts`
Expected: FAIL — 모듈을 찾을 수 없다

- [ ] **Step 3: 함수를 구현한다**

`src/web/features/backtests/strategy-label.ts`:

```ts
/** `useStrategies` 응답 중 라벨에 필요한 부분만 — 화면마다 전체 타입을 끌고 오지 않게 */
export interface StrategyNameSource {
  readonly id: string;
  readonly name: string;
}

/**
 * 화면에 보일 전략 이름. 목록에 없거나 응답이 아직 없으면 strategyId 로 떨어진다 —
 * 등록이 풀린 전략의 지난 결과가 빈칸으로 보이면 무슨 전략이었는지 알 수 없다.
 */
export function strategyLabel(
  strategyId: string,
  strategies: readonly StrategyNameSource[] | undefined,
): string {
  return strategies?.find((s) => s.id === strategyId)?.name ?? strategyId;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/unit/strategy-label.test.ts`
Expected: PASS (3 케이스)

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/backtests/strategy-label.ts tests/unit/strategy-label.test.ts
git commit -m "feat(web): 전략 라벨 함수를 뽑는다

화면 넷이 각자 목록을 훑어 이름을 찾는다. 못 찾을 때 strategyId 로 떨어지는
규칙을 한 곳에 둔다."
```

---

## Task 5: 전략 목록 훅을 공유하고 대시보드를 한국어 이름으로 바꾼다

**Files:**
- Modify: `src/web/features/backtests/api.ts` (끝에 훅 추가)
- Modify: `src/web/features/dashboard/dashboard-page.tsx:31-40`, `:77`, `:105`
- Modify: `src/web/features/backtests/backtest-detail-page.tsx:620-624`
- Modify: `src/web/features/backtests/backtests-page.tsx:79-83`
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx:141-145`

**Interfaces:**
- Consumes: Task 4 의 `strategyLabel(strategyId, strategies)`
- Produces: `useStrategies()` — `UseQueryResult<{ strategies: StrategySummary[] }>`

- [ ] **Step 1: 세 화면이 지금 쓰는 응답 타입을 확인한다**

Run:

```bash
sed -n '615,630p' src/web/features/backtests/backtest-detail-page.tsx
sed -n '75,90p' src/web/features/backtests/backtests-page.tsx
sed -n '138,150p' src/web/features/backtests/new-backtest-wizard.tsx
```

세 곳의 `api<...>('/strategies')` 제네릭이 서로 다를 수 있다. 가장 넓은 것(필드가 가장 많은 것)을 `useStrategies` 의 타입으로 삼는다 — 좁은 쪽에 맞추면 그 화면이 쓰는 필드가 사라진다. `requiresFundamentals` 를 쓰는 곳이 있으니(`new-backtest-wizard.tsx:177` 부근) 반드시 포함시킨다.

- [ ] **Step 2: 훅을 `api.ts` 에 추가한다**

`src/web/features/backtests/api.ts` 끝에 붙인다. `<...>` 안의 필드는 Step 1 에서 확인한 가장 넓은 형태로 채운다. 아래는 세 화면이 지금 쓰는 필드를 합친 형태다:

```ts
export interface StrategySummary {
  id: string;
  version: string;
  name: string;
  description: string;
  requiresFundamentals?: boolean;
}

/**
 * 전략 목록. 네 화면(대시보드·목록·상세·위저드)이 공유한다 — 화면마다 같은
 * useQuery 를 복사하면 캐시 키는 같은데 응답 타입이 갈라진다.
 * 전략 목록은 배포로만 바뀌므로 staleTime 을 길게 둔다.
 */
export function useStrategies() {
  return useQuery({
    queryKey: ['strategies'],
    queryFn: () => api<{ strategies: StrategySummary[] }>('/strategies'),
    staleTime: 5 * 60_000,
  });
}
```

Step 1 에서 확인한 필드가 위와 다르면 위 인터페이스를 그쪽에 맞춘다.

- [ ] **Step 3: 세 화면의 중복 useQuery 를 훅으로 바꾼다**

각 화면에서 `const strategies = useQuery({ queryKey: ['strategies'], ... });` 를 `const strategies = useStrategies();` 로 바꾼다. import 를 정리한다 — `useQuery` 를 다른 곳에서도 쓰면 남기고, 안 쓰면 지운다.

- `backtest-detail-page.tsx:620`
- `backtests-page.tsx:79`
- `new-backtest-wizard.tsx:141`

세 곳 모두 `strategies.data?.strategies` 를 쓰는 형태가 그대로 유지되므로 사용처는 손대지 않는다.

- [ ] **Step 4: 타입체크로 회귀를 확인한다**

Run: `pnpm typecheck`
Expected: 오류 없음. 오류가 나면 Step 1 에서 고른 타입이 좁다 — 빠진 필드를 `StrategySummary` 에 더한다.

- [ ] **Step 5: 대시보드를 한국어 이름으로 바꾼다**

`dashboard-page.tsx` import 에 추가:

```tsx
import { useBacktests, useStrategies } from '../backtests/api';
import { strategyLabel } from '../backtests/strategy-label';
```

`DashboardPage` 안, `const { data: backtests, isLoading } = useBacktests(5_000);` 아래:

```tsx
  const { data: strategyList } = useStrategies();
```

`jobs` 선언 아래:

```tsx
  const strategies = strategyList?.strategies;
```

`실행 중 작업` 카드(77줄)와 `최근 결과` 카드(105줄)의 `{job.strategyId}` 를 각각 바꾼다. 두 카드를 함께 바꾸는 이유: 한 화면에서 한 카드만 한국어면 나란한 두 카드의 표기가 어긋난다.

```tsx
                      <span className="font-medium">{strategyLabel(job.strategyId, strategies)}</span>
```

- [ ] **Step 6: 화면에서 확인한다**

Run: `pnpm dev` 와 `pnpm dev:web` 을 각각 띄우고 대시보드를 연다.
Expected: `실행 중 작업`·`최근 결과` 카드가 `횡단면 모멘텀` 같은 한국어 이름을 보인다. kebab-case 식별자가 남아 있지 않다. 완료된 백테스트가 없으면 하나 실행해 확인한다.

- [ ] **Step 7: 전체 검증**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 오류 없음, 전체 PASS

- [ ] **Step 8: 커밋**

```bash
git add src/web/features/backtests/api.ts src/web/features/dashboard/dashboard-page.tsx src/web/features/backtests/backtest-detail-page.tsx src/web/features/backtests/backtests-page.tsx src/web/features/backtests/new-backtest-wizard.tsx
git commit -m "feat(web): 대시보드 전략 표기를 한국어 이름으로 바꾼다

전략은 이미 한국어 이름을 갖고 GET /strategies 가 그걸 준다. 대시보드만 안
쓰고 strategyId 를 그대로 찍었다. 같은 useQuery 가 세 곳에 복사돼 있어
useStrategies 로 뽑고 네 화면이 공유한다."
```

---

## Task 6: 설계 결정을 문서에 남긴다

**Files:**
- Modify: `docs/DECISIONS.md` (파일 끝, 마지막 D-번호 다음 번호로)

**Interfaces:**
- Consumes: Task 1~5 의 결과
- Produces: 없음 (문서)

- [ ] **Step 1: 마지막 결정 번호를 확인한다**

Run: `grep -oE '^## D-[0-9]+' docs/DECISIONS.md | tail -3`
Expected: 마지막이 `## D-043` 이다. 그러면 이 결정은 `D-044` 다. 그 사이에 다른 작업이 번호를 채웠으면 다음 빈 번호를 쓴다 — D-041 이 같은 이유로 번호를 옮겨 적었다.

- [ ] **Step 2: 결정을 파일 끝에 더한다**

제목은 `## D-044: <제목>` 형식이다 (콜론이 있다). 본문은 `**결정 — …:**`, `**알려진 한계 — …:**` 처럼 굵은 머리말을 앞에 두는 기존 형식을 따른다.

```markdown
## D-044: 알림 항목 설명은 제출 경고를 지고 지표는 수익률만 담는다

- **결정 — 제출 경고를 `backtest_jobs.submit_warnings_json` 에 저장한다:**
  `POST /backtests`·clone 응답의 `warnings[]` 는 화면 토스트 10초가 유일한
  수명이었다. 자본변동 gap 경고가 사라지면 "수집했고 분할이 없었다" 와
  "gap 이 나서 확인하지 못했다" 가 같아 보인다 (D-043 이 백필 종목에서
  겪는 것과 같은 구분 실패다). 경고가 없으면 `null` 이다 — 빈 배열을 넣으면
  "경고가 없었다" 와 "이 컬럼이 생기기 전 job" 이 같아 보인다.
- **결정 — 알림 설명에 넣는 지표는 수익률뿐이다:** 알림 목록의 접힌 행은
  `truncate` 로 한 줄만 보인다. 지표를 늘리면 그 한 줄에서 정작 전략 이름이
  잘린다. CAGR·MDD·Sharpe 는 상세 화면 지표 카드의 몫이다.
- **결정 — 설명의 전략 표기는 레지스트리의 한국어 이름이다:** 전략은 이미
  `name` 에 한국어 이름을 갖고 `GET /strategies` 가 그걸 준다. 등록이 풀린
  전략은 `strategyId` 로 떨어진다 — 빈칸이면 무슨 전략이었는지 알 수 없다.
- **알려진 한계 — 지난 job 의 제출 경고는 백필할 수 없다:** 이 변경 전
  job 은 `submit_warnings_json` 이 `null` 이다. 제출 시점 경고는 응답에만
  있었고 어디에도 저장되지 않았다. 원본이 없어 채울 수 없다. 지난 결과의
  알림 설명에는 전략 이름과 수익률만 남는다.
```

Step 1 이 `D-043` 보다 큰 번호를 보였으면 제목의 번호를 그 다음 빈 번호로 바꾼다.

- [ ] **Step 3: 커밋**

```bash
git add docs
git commit -m "docs(decisions): 제출 경고 저장과 알림 설명의 지표 범위를 기록한다"
```

---

## 검증 요약

전체 작업이 끝난 뒤 한 번 더 돌린다.

```bash
pnpm typecheck && pnpm lint && pnpm test
```

`pnpm test:e2e` 는 이 변경이 셀렉터를 바꾸지 않아 필수는 아니다. 대시보드 텍스트를 겨누는 e2e 가 있으면 돌린다:

```bash
grep -rn "strategyId\|cross-sectional-momentum\|range-breakout" tests/e2e/
```

hit 이 있으면 그 spec 을 한국어 이름 기준으로 고치고 `pnpm test:e2e` 를 돌린다.
