# Universe Stage Direction and ROE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스트 위저드의 각 유니버스 단계에서 기준별 양방향을 명시적으로 선택하고, PIT TTM 순이익과 자본총계로 계산한 ROE를 새 기준으로 제공한다.

**Architecture:** 공유 스키마가 `direction: HIGH | LOW`를 정규화하고 기존 방향 없는 요청에는 과거 고정 방향을 채운다. 서버 랭킹은 criterion과 무관하게 direction만 보고 정렬하며, PER와 ROE는 공통 exact-ratio 행 생성 경로를 쓴다. 웹 편집기는 새 단계와 기준 변경에 사용자 선호 방향을 넣고 기준별 문구로 방향을 표시한다.

**Tech Stack:** TypeScript, Zod, React, Vitest, Fastify inject integration tests, Playwright, pnpm

## Global Constraints

- 방향 옵션 순서는 시가총액·거래량·거래대금 `상위 → 하위`, PER `낮음 → 높음`, ROE `높음 → 낮음`, 가격 변동 `급상승 → 급하락`이다.
- 새 단계와 기준 변경은 각 기준의 첫 번째 방향을 기본값으로 쓴다.
- ROE는 PIT 시점의 `TTM NET_INCOME / TOTAL_EQUITY`이며 순이익과 자본총계가 모두 양수인 종목만 적격이다.
- 내부 criterion `DECLINE`은 유지하고 화면에서만 `가격 변동`으로 표시한다.
- 방향 없는 기존 요청은 `MARKET_CAP`·`VOLUME`·`TRADING_VALUE`=`HIGH`, `PER`·`DECLINE`=`LOW`로 보정한다.
- 기준과 단계 상한은 여섯 개이며 같은 criterion은 한 번만 쓸 수 있다.
- 동률은 단축코드 오름차순으로 결정하고 결측 제외 정책은 유지한다.
- DB migration과 새 외부 의존성은 추가하지 않는다.
- 각 동작은 실패하는 테스트를 먼저 확인한 뒤 구현한다.

---

## File Structure

- `src/shared/schemas/universe-rule.ts`: criterion, direction, legacy 정규화, 새 단계 기본 방향과 최대 단계 계약을 소유한다.
- `src/shared/schemas/provenance-pin.ts`: 저장되는 단계 진단의 direction을 공유 타입에 반영한다.
- `src/server/modules/backtest/application/universe-stage-ranking.ts`: 결측 제거, direction 기반 정렬, 동률 결정과 단계 진단을 담당한다.
- `src/server/modules/backtest/application/universe-rule-resolver.ts`: criterion별 원재료를 랭킹 행으로 만들고 PER·ROE exact ratio와 준비 필요량을 판정한다.
- `src/server/modules/backtest/application/backtest-preparation-plan.ts`: PER·ROE 단계의 4분기 재무 준비 범위를 계산한다.
- `src/web/features/backtests/universe-pipeline.ts`: 새 단계 생성과 direction 변경 같은 순수 상태 전이를 담당한다.
- `src/web/features/backtests/universe-stage-editor.tsx`: 기준별 방향 드롭다운과 가격 변동 조회기간 입력을 렌더링한다.
- `src/web/features/backtests/universe-summary.ts`: 기준·방향·N을 사람이 읽는 한 줄 요약으로 바꾼다.
- `src/web/features/backtests/new-backtest-wizard.tsx`: 신규 위저드의 명시적 기본 방향을 소유한다.
- `tests/unit/*`: 스키마, 상태 전이, 마크업, 요약, 랭킹, resolver와 준비 계획을 빠르게 검증한다.
- `tests/integration/backtest-universe-preview.test.ts`: HTTP preview가 ROE와 direction 진단을 끝까지 보존하는지 검증한다.
- `tests/integration/job-queue.test.ts`: 방향 없는 저장 요청의 clone-draft 보정을 검증한다.
- `tests/e2e/universe-pipeline.spec.ts`: 실제 위저드에서 기준별 옵션 순서와 방향 선택을 검증한다.
- `README.md`, `docs/ONBOARDING.md`, `docs/SPEC.md`, `docs/DECISIONS.md`: 운영 조건, 요청 예시와 결정 근거를 현재 동작에 맞춘다.

---

### Task 1: Direction Contract and Server Ranking

**Files:**
- Modify: `src/shared/schemas/universe-rule.ts`
- Modify: `src/shared/schemas/provenance-pin.ts`
- Modify: `src/server/modules/backtest/application/universe-stage-ranking.ts`
- Modify: `src/server/modules/backtest/application/universe-rule-resolver.ts`
- Modify: `src/server/modules/backtest/application/stored-request.ts`
- Modify: `src/web/features/backtests/universe-pipeline.ts`
- Modify: `src/web/features/backtests/universe-stage-editor.tsx`
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx`
- Test: `tests/unit/backtest-request.test.ts`
- Test: `tests/unit/universe-stage-ranking.test.ts`
- Test: `tests/unit/universe-rule-resolver.test.ts`
- Test: `tests/integration/job-queue.test.ts`
- Mechanical fixture update: every file returned by `rg -l "criterion: '(MARKET_CAP|VOLUME|TRADING_VALUE|PER|DECLINE)'" src tests`

**Interfaces:**
- Produces: `UniverseDirection = 'HIGH' | 'LOW'`
- Produces: `LEGACY_STAGE_DIRECTION: Record<UniverseCriterion, UniverseDirection>`
- Produces: `PREFERRED_STAGE_DIRECTION: Record<UniverseCriterion, UniverseDirection>`
- Produces: parsed `UniverseStage` with required `direction`
- Produces: `UniverseStageDiagnostic.direction: UniverseDirection`
- Consumes: existing `UniverseCriterion`, `UniverseStage`, `UniverseRule`, `UniverseStageValue`

- [ ] **Step 1: Add failing schema tests for explicit and legacy direction**

Append these cases inside `describe('universeRule')` in `tests/unit/backtest-request.test.ts`:

```ts
it.each([
  ['MARKET_CAP', 'HIGH'],
  ['VOLUME', 'HIGH'],
  ['TRADING_VALUE', 'HIGH'],
  ['PER', 'LOW'],
  ['DECLINE', 'LOW'],
] as const)('방향 없는 기존 %s 단계는 %s로 보정한다', (criterion, direction) => {
  const stage = criterion === 'DECLINE'
    ? { criterion, limit: 20, lookbackTradingDays: 20 }
    : { criterion, limit: 20 };
  const parsed = backtestRequestSchema.safeParse({
    ...baseRequest(),
    universeRule: {
      markets: ['KOSPI'],
      stages: [stage],
      rebalanceInterval: { value: 1, unit: 'MONTH' },
    },
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.universeRule.stages[0]?.direction).toBe(direction);
});

it('명시한 반대 방향은 legacy 기본값으로 덮어쓰지 않는다', () => {
  const parsed = backtestRequestSchema.safeParse({
    ...baseRequest(),
    universeRule: {
      markets: ['KOSPI'],
      stages: [{ criterion: 'PER', direction: 'HIGH', limit: 20 }],
      rebalanceInterval: { value: 1, unit: 'MONTH' },
    },
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.universeRule.stages[0]?.direction).toBe('HIGH');
});

it('알 수 없는 방향은 거부한다', () => {
  const parsed = backtestRequestSchema.safeParse({
    ...baseRequest(),
    universeRule: {
      markets: ['KOSPI'],
      stages: [{ criterion: 'MARKET_CAP', direction: 'SIDEWAYS', limit: 20 }],
      rebalanceInterval: { value: 1, unit: 'MONTH' },
    },
  });
  expect(parsed.success).toBe(false);
});
```

- [ ] **Step 2: Replace fixed-direction ranking tests with bidirectional cases**

Change the `stage` helper in `tests/unit/universe-stage-ranking.test.ts` to accept direction and add both expected orders:

```ts
function stage(
  criterion: UniverseCriterion,
  limit: number,
  direction: 'HIGH' | 'LOW',
): UniverseStage {
  return criterion === 'DECLINE'
    ? { criterion, direction, limit, lookbackTradingDays: 20 }
    : { criterion, direction, limit };
}

it.each([
  ['MARKET_CAP', 'HIGH', ['KR7000001', 'KR7000002']],
  ['MARKET_CAP', 'LOW', ['KR7000003', 'KR7000002']],
  ['VOLUME', 'HIGH', ['KR7000001', 'KR7000002']],
  ['VOLUME', 'LOW', ['KR7000003', 'KR7000002']],
  ['TRADING_VALUE', 'HIGH', ['KR7000001', 'KR7000002']],
  ['TRADING_VALUE', 'LOW', ['KR7000003', 'KR7000002']],
  ['PER', 'HIGH', ['KR7000001', 'KR7000002']],
  ['PER', 'LOW', ['KR7000003', 'KR7000002']],
  ['DECLINE', 'HIGH', ['KR7000001', 'KR7000002']],
  ['DECLINE', 'LOW', ['KR7000003', 'KR7000002']],
] as const)('%s %s 방향으로 정렬한다', (criterion, direction, expected) => {
  const input = rows(['000003', 10], ['000001', 30], ['000002', 20]);
  expect(rankUniverseStage(stage(criterion, 2, direction), input)).toMatchObject({
    selectedCodes: expected,
    diagnostic: { criterion, direction },
  });
});
```

Keep the bigint trading-value coverage by changing that row's existing dedicated input to call `stage('TRADING_VALUE', 2, 'HIGH')`.

- [ ] **Step 3: Add a failing resolver test for bottom market cap**

In `tests/unit/universe-rule-resolver.test.ts`, change the rule helper and add the test:

```ts
const marketCapRule = (
  limit: number,
  direction: 'HIGH' | 'LOW' = 'HIGH',
): UniverseRule => ({
  markets: ['KOSPI'],
  stages: [{ criterion: 'MARKET_CAP', direction, limit }],
  rebalanceInterval: { value: 1, unit: 'MONTH' },
});

it('시가총액 LOW는 작은 시가총액부터 N개를 고른다', async () => {
  const ctx = await setup();
  await ingestFixtureUniverse(ctx);

  const result = await ctx.resolver.resolve(marketCapRule(2, 'LOW'), ['2023-01-02']);

  expect(result.schedule[0]?.symbols).toEqual(['000030', '000020']);
  expect(result.unionSymbols).toEqual(['000020', '000030']);
  await teardown(ctx);
});
```

- [ ] **Step 4: Add a failing clone-draft test for a direction-less stored stage**

Add beside the existing clone-draft tests in `tests/integration/job-queue.test.ts`:

```ts
it('초안은 방향 없는 기존 가격 변동 단계를 과거 LOW 방향으로 복원한다', async () => {
  const current = buildRequest();
  const job = ctx.container.jobQueue.enqueue({
    ...current,
    universeRule: {
      markets: ['KOSPI'],
      stages: [{ criterion: 'DECLINE', limit: 20, lookbackTradingDays: 20 }],
      rebalanceInterval: { value: 1, unit: 'MONTH' },
    },
  } as never);

  const draft = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/backtests/${job.id}/clone-draft`,
    cookies: { qp_session: cookie },
  });

  expect(draft.statusCode).toBe(200);
  const body = draft.json() as { request: BacktestRequest };
  expect(body.request.universeRule.stages).toEqual([
    { criterion: 'DECLINE', direction: 'LOW', limit: 20, lookbackTradingDays: 20 },
  ]);
});
```

- [ ] **Step 5: Run the new tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/backtest-request.test.ts \
  tests/unit/universe-stage-ranking.test.ts \
  tests/unit/universe-rule-resolver.test.ts \
  tests/integration/job-queue.test.ts
```

Expected: schema and clone assertions fail because direction is absent, ranking LOW cases return the old fixed order, and the resolver LOW test returns the largest caps.

- [ ] **Step 6: Implement direction normalization in the shared schema**

In `src/shared/schemas/universe-rule.ts`, add the direction enum, separate legacy and preferred defaults, accept omitted legacy input, and transform output to an explicit direction:

```ts
export const universeDirectionSchema = z.enum(['HIGH', 'LOW']);
export type UniverseDirection = z.infer<typeof universeDirectionSchema>;

export const LEGACY_STAGE_DIRECTION = {
  MARKET_CAP: 'HIGH',
  VOLUME: 'HIGH',
  TRADING_VALUE: 'HIGH',
  PER: 'LOW',
  DECLINE: 'LOW',
} as const satisfies Record<UniverseCriterion, UniverseDirection>;

export const PREFERRED_STAGE_DIRECTION = {
  MARKET_CAP: 'HIGH',
  VOLUME: 'HIGH',
  TRADING_VALUE: 'HIGH',
  PER: 'LOW',
  DECLINE: 'HIGH',
} as const satisfies Record<UniverseCriterion, UniverseDirection>;
```

Add `direction: universeDirectionSchema.optional()` to every raw stage object, then transform the discriminated union:

```ts
const rawUniverseStageSchema = z.discriminatedUnion('criterion', [
  z.object({ criterion: z.literal('MARKET_CAP'), direction: universeDirectionSchema.optional(), limit: stageLimitSchema }),
  z.object({ criterion: z.literal('VOLUME'), direction: universeDirectionSchema.optional(), limit: stageLimitSchema }),
  z.object({ criterion: z.literal('TRADING_VALUE'), direction: universeDirectionSchema.optional(), limit: stageLimitSchema }),
  z.object({ criterion: z.literal('PER'), direction: universeDirectionSchema.optional(), limit: stageLimitSchema }),
  z.object({
    criterion: z.literal('DECLINE'),
    direction: universeDirectionSchema.optional(),
    limit: stageLimitSchema,
    lookbackTradingDays: z.number().int().min(1).max(252),
  }),
]);

export const universeStageSchema = rawUniverseStageSchema.transform((stage) => ({
  ...stage,
  direction: stage.direction ?? LEGACY_STAGE_DIRECTION[stage.criterion],
}));
export type UniverseStageInput = z.input<typeof universeStageSchema>;
export type UniverseStage = z.output<typeof universeStageSchema>;
```

- [ ] **Step 7: Make ranking and diagnostics direction-driven**

In `src/server/modules/backtest/application/universe-stage-ranking.ts`:

```ts
export interface UniverseStageDiagnostic {
  readonly criterion: UniverseCriterion;
  readonly direction: UniverseDirection;
  readonly inputCount: number;
  readonly eligibleCount: number;
  readonly selectedCount: number;
  readonly excludedMissingCount: number;
}

function isEligibleValue(value: number | bigint | null): value is number | bigint {
  return value !== null && (typeof value === 'bigint' || Number.isFinite(value));
}
```

Filter with `isEligibleValue(row.value)`, set `ascending` to `stage.direction === 'LOW'`, and include `direction: stage.direction` in the diagnostic. Add the same field to `UniverseStageDiagnosticSnapshot` in `src/shared/schemas/provenance-pin.ts`.

In the legacy `UniverseRuleResolver.resolve()` market-cap-only method, replace the fixed comparator with a direction-aware comparator that preserves the code tie-break in both directions:

```ts
const direction = rule.stages[0]!.direction;
ranked.sort((a, b) => {
  const valueOrder = a.marketCap === b.marketCap ? 0 : a.marketCap < b.marketCap ? -1 : 1;
  if (valueOrder !== 0) return direction === 'LOW' ? valueOrder : -valueOrder;
  return compareShortCodes(a.entry.shortCode, b.entry.shortCode);
});
```

`resolveOrDescribeNeeds()` already calls `rankUniverseStage`, so it must not retain criterion-based direction logic.

- [ ] **Step 8: Make all production stage constructors explicit**

Use `PREFERRED_STAGE_DIRECTION[criterion]` in `addStage()` and criterion changes. The resulting constructors must have these shapes:

```ts
const newStage: UniverseStage = criterion === 'DECLINE'
  ? {
      criterion,
      direction: PREFERRED_STAGE_DIRECTION[criterion],
      limit,
      lookbackTradingDays: DEFAULT_DECLINE_LOOKBACK_TRADING_DAYS,
    }
  : { criterion, direction: PREFERRED_STAGE_DIRECTION[criterion], limit };
```

Set `DEFAULT_UNIVERSE_RULE.stages` in `new-backtest-wizard.tsx` to:

```ts
stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 200 }],
```

When `UniverseStageEditor.changeCriterion()` changes a criterion, also reset direction with `PREFERRED_STAGE_DIRECTION[criterion]`. Do not add the visible direction control in this task.

- [ ] **Step 9: Update typed fixtures to the explicit output contract**

Run this inventory command and update every current-schema fixture it reports:

```bash
rg -l "criterion: '(MARKET_CAP|VOLUME|TRADING_VALUE|PER|DECLINE)'" src tests
```

Use this exact mapping:

```ts
{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: n }
{ criterion: 'VOLUME', direction: 'HIGH', limit: n }
{ criterion: 'TRADING_VALUE', direction: 'HIGH', limit: n }
{ criterion: 'PER', direction: 'LOW', limit: n }
{ criterion: 'DECLINE', direction: 'LOW', limit: n, lookbackTradingDays: days }
```

Leave direction omitted only in the new legacy-normalization tests and old-shape JSON used by `rebaseStoredRequest`. Add `direction` to exact diagnostic expectations in ranking, resolver, preview and run tests. This step includes the 20 files found by the inventory command; do not alter the selected symbols or prior test intent.

- [ ] **Step 10: Run direction tests and typecheck GREEN**

Run:

```bash
pnpm vitest run tests/unit/backtest-request.test.ts \
  tests/unit/universe-stage-ranking.test.ts \
  tests/unit/universe-rule-resolver.test.ts \
  tests/integration/job-queue.test.ts
pnpm typecheck
pnpm test
```

Expected: targeted tests, the complete Vitest suite and both TypeScript projects pass.

- [ ] **Step 11: Commit the direction domain slice**

```bash
git add src/shared/schemas/universe-rule.ts src/shared/schemas/provenance-pin.ts \
  src/server/modules/backtest/application/universe-stage-ranking.ts \
  src/server/modules/backtest/application/universe-rule-resolver.ts \
  src/server/modules/backtest/application/stored-request.ts \
  src/web/features/backtests/universe-pipeline.ts \
  src/web/features/backtests/universe-stage-editor.tsx \
  src/web/features/backtests/new-backtest-wizard.tsx \
  tests/e2e/step-urls.spec.ts \
  tests/integration/backtest-facts-worker.test.ts \
  tests/integration/backtest-preparation.test.ts \
  tests/integration/backtest-split-alignment.test.ts \
  tests/integration/backtest-universe-preview.test.ts \
  tests/integration/backtest-universe-rule-run.test.ts \
  tests/integration/job-queue.test.ts \
  tests/unit/backtest-preparation-orchestrator.test.ts \
  tests/unit/backtest-preparation-plan.test.ts \
  tests/unit/backtest-request.test.ts tests/unit/prefill.test.ts \
  tests/unit/universe-pipeline.test.ts \
  tests/unit/universe-rule-resolver-non-trading.test.ts \
  tests/unit/universe-rule-resolver.test.ts \
  tests/unit/universe-stage-editor-markup.test.tsx \
  tests/unit/universe-stage-ranking.test.ts \
  tests/unit/universe-summary.test.ts tests/unit/wizard-steps.test.ts
git commit -m "feat(backtest): 유니버스 정렬 방향을 명시한다"
```

---

### Task 2: Criterion-Specific Direction UI and Summaries

**Files:**
- Modify: `src/web/features/backtests/universe-pipeline.ts`
- Modify: `src/web/features/backtests/universe-stage-editor.tsx`
- Modify: `src/web/features/backtests/universe-summary.ts`
- Test: `tests/unit/universe-pipeline.test.ts`
- Test: `tests/unit/universe-stage-editor-markup.test.tsx`
- Test: `tests/unit/universe-summary.test.ts`
- Test: `tests/e2e/universe-pipeline.spec.ts`

**Interfaces:**
- Consumes: `UniverseDirection`, `PREFERRED_STAGE_DIRECTION`, `LEGACY_STAGE_DIRECTION`
- Produces: `changeStageCriterion(stages, index, criterion): PipelineUpdate`
- Produces: `changeStageDirection(stages, index, direction): PipelineUpdate`
- Produces: native select IDs `stage-direction-${index}`
- Produces: summary format `기준 방향 N`

- [ ] **Step 1: Write failing pure-state and markup tests**

Add to `tests/unit/universe-pipeline.test.ts`:

```ts
describe('changeStageCriterion', () => {
  it('PER로 바꾸면 선호 방향 LOW를 넣고 DECLINE 전용 조회기간을 제거한다', () => {
    expect(changeStageCriterion([
      { criterion: 'DECLINE', direction: 'LOW', limit: 50, lookbackTradingDays: 60 },
    ], 0, 'PER')).toEqual({
      stages: [{ criterion: 'PER', direction: 'LOW', limit: 50 }],
      changedIndices: [],
    });
  });

  it('가격 변동으로 바꾸면 선호 방향 HIGH와 조회기간 20일을 넣는다', () => {
    expect(changeStageCriterion([
      { criterion: 'MARKET_CAP', direction: 'LOW', limit: 50 },
    ], 0, 'DECLINE')).toEqual({
      stages: [{
        criterion: 'DECLINE', direction: 'HIGH', limit: 50, lookbackTradingDays: 20,
      }],
      changedIndices: [],
    });
  });
});

describe('changeStageDirection', () => {
  it('고른 단계의 방향만 바꾸고 cascade 표시를 만들지 않는다', () => {
    expect(changeStageDirection([
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
      { criterion: 'PER', direction: 'LOW', limit: 50 },
    ], 1, 'HIGH')).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
        { criterion: 'PER', direction: 'HIGH', limit: 50 },
      ],
      changedIndices: [],
    });
  });
});
```

Add markup assertions to `tests/unit/universe-stage-editor-markup.test.tsx`:

```ts
it('기준마다 사람이 읽는 두 방향을 유리한 순서로 보여준다', () => {
  const html = renderEditor([
    { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 200 },
    { criterion: 'PER', direction: 'LOW', limit: 100 },
    { criterion: 'DECLINE', direction: 'HIGH', limit: 50, lookbackTradingDays: 20 },
  ]);
  expect(html).toContain('id="stage-direction-0"');
  expect(html).toContain('<option value="HIGH" selected="">상위</option><option value="LOW">하위</option>');
  expect(html).toContain('<option value="LOW" selected="">낮음</option><option value="HIGH">높음</option>');
  expect(html).toContain('<option value="HIGH" selected="">급상승</option><option value="LOW">급하락</option>');
});
```

- [ ] **Step 2: Write failing summary tests including legacy display**

Update the main expectation in `tests/unit/universe-summary.test.ts` to:

```ts
expect(formatUniverseRuleSummary(rule)).toBe(
  'KOSPI · 시가총액 상위 200 → PER 낮음 80 → 가격 변동 급하락(20일) 40 · 매월',
);
```

Add a runtime legacy case:

```ts
it('방향 없는 기존 규칙은 과거 고정 방향으로 표시한다', () => {
  const legacy = {
    markets: ['KOSPI'],
    stages: [
      { criterion: 'MARKET_CAP', limit: 100 },
      { criterion: 'DECLINE', limit: 20, lookbackTradingDays: 20 },
    ],
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  } as unknown as UniverseRule;
  expect(formatUniverseRuleSummary(legacy)).toBe(
    'KOSPI · 시가총액 상위 100 → 가격 변동 급하락(20일) 20 · 매월',
  );
});
```

- [ ] **Step 3: Write a failing browser test for criterion-specific direction controls**

Add to `tests/e2e/universe-pipeline.spec.ts`:

```ts
test('유니버스 정렬 방향을 기준별 문구로 명시해 고른다', async ({ page }) => {
  await login(page);
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('시작일').fill('2026-01-01');
  await page.getByLabel('종료일').fill('2026-12-31');
  await page.getByRole('button', { name: '다음' }).click();

  await expect(page.locator('#stage-direction-0')).toHaveValue('HIGH');
  await expect(page.locator('#stage-direction-0 option')).toHaveText(['상위', '하위']);

  await page.getByRole('button', { name: 'PER 단계 추가' }).click();
  await expect(page.locator('#stage-direction-1')).toHaveValue('LOW');
  await expect(page.locator('#stage-direction-1 option')).toHaveText(['낮음', '높음']);
  await page.locator('#stage-direction-1').selectOption('HIGH');
  await expect(page.locator('#stage-direction-1')).toHaveValue('HIGH');

  await page.getByRole('button', { name: '가격 변동 단계 추가' }).click();
  await expect(page.locator('#stage-direction-2')).toHaveValue('HIGH');
  await expect(page.locator('#stage-direction-2 option')).toHaveText(['급상승', '급하락']);
  await page.locator('#stage-direction-2').selectOption('LOW');
  await expect(page.locator('#stage-direction-2')).toHaveValue('LOW');
});
```

Also extend the existing `단계 추가·N 기본 복사...` end-to-end scenario. After it deletes PER and price-change stages, select `LOW` on `#stage-direction-0` before preview. After submission reaches `/backtests/bt_*`, reopen that job as a clone draft and verify the saved direction:

```ts
await page.locator('#stage-direction-0').selectOption('LOW');
```

Insert the following block after the existing `await expect(page).toHaveURL(/\/backtests\/bt_/);` assertion:

```ts
const jobId = page.url().split('/').at(-1)!;
await page.goto(`/backtests/new?from=${jobId}`);
await expect(page.getByRole('heading', { name: '재설정 및 복제' })).toBeVisible();
await page.getByRole('button', { name: '다음' }).click();
await page.getByRole('button', { name: '다음' }).click();
await expect(page.locator('#stage-direction-0')).toHaveValue('LOW');
```

- [ ] **Step 4: Run UI unit and browser tests and verify RED**

```bash
pnpm vitest run tests/unit/universe-pipeline.test.ts tests/unit/universe-stage-editor-markup.test.tsx tests/unit/universe-summary.test.ts
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop --grep "정렬 방향|단계 추가"
```

Expected: unit tests fail because `changeStageDirection` and direction selects are absent; Playwright cannot find `#stage-direction-0` or the `가격 변동 단계 추가` button.

- [ ] **Step 5: Implement pure criterion and direction state transitions**

In `universe-pipeline.ts`:

```ts
export function changeStageCriterion(
  stages: readonly UniverseStage[],
  index: number,
  criterion: UniverseCriterion,
): PipelineUpdate {
  return {
    stages: stages.map((stage, i): UniverseStage => {
      if (i !== index) return stage;
      return criterion === 'DECLINE'
        ? {
            criterion,
            direction: PREFERRED_STAGE_DIRECTION[criterion],
            limit: stage.limit,
            lookbackTradingDays: DEFAULT_DECLINE_LOOKBACK_TRADING_DAYS,
          }
        : { criterion, direction: PREFERRED_STAGE_DIRECTION[criterion], limit: stage.limit };
    }),
    changedIndices: [],
  };
}

export function changeStageDirection(
  stages: readonly UniverseStage[],
  index: number,
  direction: UniverseDirection,
): PipelineUpdate {
  return {
    stages: stages.map((stage, i) => i === index ? { ...stage, direction } : stage),
    changedIndices: [],
  };
}
```

- [ ] **Step 6: Render criterion-specific direction selects**

Add a direction-label map to `universe-stage-editor.tsx`:

```ts
const DIRECTION_OPTIONS: Record<UniverseCriterion, readonly [
  { value: UniverseDirection; label: string },
  { value: UniverseDirection; label: string },
]> = {
  MARKET_CAP: [{ value: 'HIGH', label: '상위' }, { value: 'LOW', label: '하위' }],
  VOLUME: [{ value: 'HIGH', label: '상위' }, { value: 'LOW', label: '하위' }],
  TRADING_VALUE: [{ value: 'HIGH', label: '상위' }, { value: 'LOW', label: '하위' }],
  PER: [{ value: 'LOW', label: '낮음' }, { value: 'HIGH', label: '높음' }],
  DECLINE: [{ value: 'HIGH', label: '급상승' }, { value: 'LOW', label: '급하락' }],
};
```

Render a native select between criterion and N:

```tsx
<div className="space-y-1">
  <Label htmlFor={`stage-direction-${index}`}>방향</Label>
  <select
    id={`stage-direction-${index}`}
    name="direction"
    className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
    value={stage.direction}
    onChange={(event) => applyUpdate(changeStageDirection(
      stages,
      index,
      event.target.value as UniverseDirection,
    ))}
  >
    {DIRECTION_OPTIONS[stage.criterion].map((option) => (
      <option key={option.value} value={option.value}>{option.label}</option>
    ))}
  </select>
</div>
```

Change the visible `DECLINE` criterion label and add button label from `급하락` to `가격 변동`.
Remove the editor-local `changeCriterion` mapper and call
`applyUpdate(changeStageCriterion(stages, index, nextCriterion))` from the criterion select.

- [ ] **Step 7: Include direction in summaries**

In `universe-summary.ts`, set the `DECLINE` criterion label to `가격 변동` and add:

```ts
const DIRECTION_LABEL: Record<
  UniverseCriterion,
  Record<UniverseDirection, string>
> = {
  MARKET_CAP: { HIGH: '상위', LOW: '하위' },
  VOLUME: { HIGH: '상위', LOW: '하위' },
  TRADING_VALUE: { HIGH: '상위', LOW: '하위' },
  PER: { HIGH: '높음', LOW: '낮음' },
  DECLINE: { HIGH: '급상승', LOW: '급하락' },
};
```

Resolve legacy omission with `LEGACY_STAGE_DIRECTION[stage.criterion]` and build labels in this order:

```ts
const direction = stage.direction ?? LEGACY_STAGE_DIRECTION[stage.criterion];
const criterion = stage.criterion === 'DECLINE'
  ? `${CRITERION_LABEL.DECLINE} ${DIRECTION_LABEL.DECLINE[direction]}(${stage.lookbackTradingDays}일)`
  : `${CRITERION_LABEL[stage.criterion]} ${DIRECTION_LABEL[stage.criterion][direction]}`;
return `${criterion} ${stage.limit}`;
```

- [ ] **Step 8: Run UI unit and browser tests GREEN**

```bash
pnpm vitest run tests/unit/universe-pipeline.test.ts tests/unit/universe-stage-editor-markup.test.tsx tests/unit/universe-summary.test.ts
pnpm typecheck
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop --grep "정렬 방향|단계 추가"
```

Expected: all selected tests, typecheck and the desktop Playwright scenario pass.

- [ ] **Step 9: Commit the UI slice**

```bash
git add src/web/features/backtests/universe-pipeline.ts \
  src/web/features/backtests/universe-stage-editor.tsx \
  src/web/features/backtests/universe-summary.ts \
  tests/unit/universe-pipeline.test.ts \
  tests/unit/universe-stage-editor-markup.test.tsx \
  tests/unit/universe-summary.test.ts tests/e2e/universe-pipeline.spec.ts
git commit -m "feat(web): 유니버스 방향 선택을 표시한다"
```

---

### Task 3: ROE Criterion and Six-Stage Pipeline

**Files:**
- Modify: `src/shared/schemas/universe-rule.ts`
- Modify: `src/server/modules/backtest/application/universe-stage-ranking.ts`
- Modify: `src/server/modules/backtest/application/universe-rule-resolver.ts`
- Modify: `src/server/modules/backtest/application/backtest-preparation-plan.ts`
- Modify: `src/web/features/backtests/universe-pipeline.ts`
- Modify: `src/web/features/backtests/universe-stage-editor.tsx`
- Modify: `src/web/features/backtests/universe-summary.ts`
- Test: `tests/unit/backtest-request.test.ts`
- Test: `tests/unit/universe-stage-ranking.test.ts`
- Test: `tests/unit/universe-rule-resolver.test.ts`
- Test: `tests/unit/backtest-preparation-plan.test.ts`
- Test: `tests/unit/universe-stage-editor-markup.test.tsx`
- Test: `tests/unit/universe-summary.test.ts`
- Test: `tests/integration/backtest-universe-preview.test.ts`
- Test: `tests/e2e/universe-pipeline.spec.ts`

**Interfaces:**
- Extends: `UniverseCriterion` with `ROE`
- Produces: six-entry `PREFERRED_STAGE_DIRECTION` and `LEGACY_STAGE_DIRECTION`
- Produces: `exactRatioRankingRows(candidates, ratioOf): UniverseStageValue[]`
- Produces: ROE ratio `TTM NET_INCOME / TOTAL_EQUITY`
- Consumes: `PitFactView.fundamentals(code)?.ttm('NET_INCOME')` and `.get('TOTAL_EQUITY')`

- [ ] **Step 1: Write failing schema tests for ROE and six stages**

Add in `tests/unit/backtest-request.test.ts`:

```ts
it('ROE 양방향과 서로 다른 여섯 단계를 허용한다', () => {
  const parsed = backtestRequestSchema.safeParse({
    ...baseRequest(),
    universeRule: {
      markets: ['KOSPI'],
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
        { criterion: 'VOLUME', direction: 'HIGH', limit: 90 },
        { criterion: 'TRADING_VALUE', direction: 'HIGH', limit: 80 },
        { criterion: 'PER', direction: 'LOW', limit: 70 },
        { criterion: 'ROE', direction: 'HIGH', limit: 60 },
        { criterion: 'DECLINE', direction: 'LOW', limit: 50, lookbackTradingDays: 20 },
      ],
      rebalanceInterval: { value: 1, unit: 'MONTH' },
    },
  });
  expect(parsed.success).toBe(true);
});

it('일곱 단계는 거부한다', () => {
  const stages = Array.from({ length: 7 }, (_, index) => ({
    criterion: ['MARKET_CAP', 'VOLUME', 'TRADING_VALUE', 'PER', 'ROE', 'DECLINE', 'ROE'][index],
    direction: 'HIGH',
    limit: 10,
    ...(index === 5 ? { lookbackTradingDays: 20 } : {}),
  }));
  expect(backtestRequestSchema.safeParse({
    ...baseRequest(),
    universeRule: { markets: ['KOSPI'], stages, rebalanceInterval: { value: 1, unit: 'MONTH' } },
  }).success).toBe(false);
});
```

- [ ] **Step 2: Write failing ROE resolver tests with positive filtering and PIT boundary**

Add this helper beside `netIncomeFacts` in `tests/unit/universe-rule-resolver.test.ts`:

```ts
function totalEquityFact(
  symbol: string,
  value: number,
  disclosedAt = PIPELINE_TS - 1,
): Fact {
  return {
    scope: 'SYMBOL',
    key: symbol,
    field: 'TOTAL_EQUITY',
    periodKey: '2025Q1',
    asOfTsMs: disclosedAt,
    value,
    unit: 'KRW',
  };
}
```

Add one test that resolves both directions:

```ts
it('ROE는 PIT 양수 재무 안에서 HIGH와 LOW를 반대로 고른다', async () => {
  const facts = [
    ...netIncomeFacts('000001', [10, 10, 10, 10]),
    totalEquityFact('000001', 100),
    totalEquityFact('000001', 10_000, Date.parse('2025-05-15T15:00:00.000Z')),
    ...netIncomeFacts('000002', [5, 5, 5, 5]),
    totalEquityFact('000002', 100),
    ...netIncomeFacts('000003', [5, 5, 5, 5]),
    totalEquityFact('000003', -100),
  ];

  const high = await makePipelineResolver({ facts }).resolveOrDescribeNeeds(
    pipelineRule([{ criterion: 'ROE', direction: 'HIGH', limit: 1 }]),
    period,
  );
  const low = await makePipelineResolver({ facts }).resolveOrDescribeNeeds(
    pipelineRule([{ criterion: 'ROE', direction: 'LOW', limit: 1 }]),
    period,
  );

  expect(high.kind).toBe('READY');
  expect(low.kind).toBe('READY');
  if (high.kind !== 'READY' || low.kind !== 'READY') throw new Error('재무 coverage가 완전해야 한다');
  expect(high.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000001']);
  expect(low.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000002']);
  expect(high.diagnostics[0]?.stages[0]).toMatchObject({
    criterion: 'ROE', direction: 'HIGH', eligibleCount: 2, excludedMissingCount: 1,
  });
});
```

The next-KST equity restatement makes `000001` ROE lower only if PIT filtering leaks; expecting it in HIGH proves that later disclosure is excluded.

- [ ] **Step 3: Write failing preparation and UI tests**

Add to `tests/unit/backtest-preparation-plan.test.ts`:

```ts
it('ROE stage 후보에 4분기 재무를 준비한다', () => {
  const plan = buildBacktestPreparationPlan({
    request: {
      ...BASE_REQUEST,
      universeRule: {
        ...BASE_REQUEST.universeRule,
        stages: [{ criterion: 'ROE', direction: 'HIGH', limit: 20 }],
      },
    },
    resolutionNeeds: { ...EMPTY_NEEDS, factSymbols: ['005930', '000660'] },
    strategy: strategy('price-only'),
  });
  expect(plan.financial).toEqual({
    symbols: ['000660', '005930'],
    fromYear: 2025,
    toYear: 2026,
  });
});
```

In `tests/unit/universe-stage-editor-markup.test.tsx`, add:

```ts
it('서로 다른 여섯 기준을 모두 쓰면 여섯 행을 그리고 추가 버튼을 숨긴다', () => {
  const html = renderEditor([
    { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
    { criterion: 'VOLUME', direction: 'HIGH', limit: 90 },
    { criterion: 'TRADING_VALUE', direction: 'HIGH', limit: 80 },
    { criterion: 'PER', direction: 'LOW', limit: 70 },
    { criterion: 'ROE', direction: 'HIGH', limit: 60 },
    { criterion: 'DECLINE', direction: 'LOW', limit: 50, lookbackTradingDays: 20 },
  ]);
  expect(html.match(/name="criterion"/g)).toHaveLength(6);
  expect(html).not.toContain('단계 추가');
});
```

In `tests/unit/universe-summary.test.ts`, add:

```ts
it.each([
  ['HIGH', 'ROE 높음 40'],
  ['LOW', 'ROE 낮음 40'],
] as const)('ROE %s 방향을 요약한다', (direction, expectedStage) => {
  const rule: UniverseRule = {
    markets: ['KOSPI'],
    stages: [{ criterion: 'ROE', direction, limit: 40 }],
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  };
  expect(formatUniverseRuleSummary(rule)).toBe(`KOSPI · ${expectedStage} · 매월`);
});
```

- [ ] **Step 4: Write failing HTTP preview and six-stage browser tests**

In the existing three-stage fixture in `tests/integration/backtest-universe-preview.test.ts`, save one `TOTAL_EQUITY` fact per X and Y alongside their `NET_INCOME` facts:

```ts
const equityFacts: Fact[] = [
  { scope: 'SYMBOL', key: 'X', field: 'TOTAL_EQUITY', periodKey: '2025Q1', asOfTsMs: Date.parse('2025-01-01T00:00:00Z'), value: 200, unit: 'KRW' },
  { scope: 'SYMBOL', key: 'Y', field: 'TOTAL_EQUITY', periodKey: '2025Q1', asOfTsMs: Date.parse('2025-01-01T00:00:00Z'), value: 400, unit: 'KRW' },
];
await ctx.container.factRepository.saveFacts([...netIncomeFacts, ...equityFacts]);
```

Add this preview test in the same `describe`:

```ts
it.each([
  ['HIGH', 'X'],
  ['LOW', 'Y'],
] as const)('ROE %s preview가 %s를 고르고 방향 진단을 반환한다', async (direction, symbol) => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/backtests/universe-preview',
    cookies: { qp_session: cookie },
    payload: {
      universeRule: {
        markets: ['KOSPI'],
        stages: [{ criterion: 'ROE', direction, limit: 1 }],
        rebalanceInterval: { unit: 'DAY', value: 1 },
      },
      period: { from: EFFECTIVE_DATE, to: EFFECTIVE_DATE },
      strategyId: 'range-breakout',
      parameters: {},
    },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    schedule: [{ members: [{ symbol }] }],
    diagnostics: [{ stages: [{ criterion: 'ROE', direction, eligibleCount: 2, selectedCount: 1 }] }],
  });
});
```

Extend the direction test in `tests/e2e/universe-pipeline.spec.ts` after its first three stages:

```ts
await page.getByRole('button', { name: '거래량 단계 추가' }).click();
await page.getByRole('button', { name: '거래대금 단계 추가' }).click();
await page.getByRole('button', { name: 'ROE 단계 추가' }).click();
await expect(page.locator('[id^="stage-criterion-"]')).toHaveCount(6);
await expect(page.getByRole('button', { name: /단계 추가/ })).toHaveCount(0);
await expect(page.locator('#stage-direction-5 option')).toHaveText(['높음', '낮음']);
```

- [ ] **Step 5: Run ROE tests and verify RED**

```bash
pnpm vitest run tests/unit/backtest-request.test.ts \
  tests/unit/universe-rule-resolver.test.ts \
  tests/unit/backtest-preparation-plan.test.ts \
  tests/unit/universe-stage-editor-markup.test.tsx \
  tests/unit/universe-summary.test.ts \
  tests/integration/backtest-universe-preview.test.ts
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop --grep "정렬 방향"
```

Expected: `ROE` is rejected by the enum and HTTP route, six stages are rejected, the ROE add button is absent, and UI/server maps have no ROE branch.

- [ ] **Step 6: Add ROE and raise the stage ceiling**

In `universe-rule.ts`, add `ROE` between `PER` and `DECLINE`, add its raw schema object, set both direction maps to `ROE: 'HIGH'`, and change `.max(5)` to `.max(6)`.

Add `ROE` to `ALL_CRITERIA`, `CRITERION_LABEL`, and `DIRECTION_OPTIONS`:

```ts
ROE: [{ value: 'HIGH', label: '높음' }, { value: 'LOW', label: '낮음' }],
```

Change both frontend `MAX_STAGE_COUNT` constants from 5 to 6. Add `ROE: 'ROE'` to the summary label map and high/low direction map.

- [ ] **Step 7: Generalize exact financial ratio rows**

Replace `exactPerRankingRows` in `universe-rule-resolver.ts` with a generic exact ratio sorter:

```ts
interface ExactPositiveRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function exactRatioRankingRows(
  candidates: readonly SymbolMasterEntry[],
  ratioOf: (entry: SymbolMasterEntry) => ExactPositiveRatio | null,
): UniverseStageValue[] {
  const ratios = candidates.flatMap((entry) => {
    const ratio = ratioOf(entry);
    return ratio === null ? [] : [{ entry, ...ratio }];
  });
  ratios.sort((a, b) => {
    const left = a.numerator * b.denominator;
    const right = b.numerator * a.denominator;
    if (left !== right) return left < right ? -1 : 1;
    return compareShortCodes(a.entry.shortCode, b.entry.shortCode);
  });
  const rankByCode = new Map<string, number>();
  let rank = 0;
  for (let index = 0; index < ratios.length; index += 1) {
    if (index > 0) {
      const previous = ratios[index - 1]!;
      const current = ratios[index]!;
      if (previous.numerator * current.denominator !== current.numerator * previous.denominator) rank += 1;
    }
    rankByCode.set(ratios[index]!.entry.standardCode, rank);
  }
  return candidates.map((entry) => ({
    standardCode: entry.standardCode,
    shortCode: entry.shortCode,
    value: rankByCode.get(entry.standardCode) ?? null,
  }));
}
```

Build PER ratios as `marketCap / TTM income`:

```ts
const perRows = exactRatioRankingRows(candidates, (entry) => {
  const cap = stageMetrics.get(entry.standardCode)?.marketCapKrw ?? null;
  const income = positiveNumberFraction(view.fundamentals(entry.shortCode)?.ttm('NET_INCOME') ?? null);
  return cap === null || cap <= 0n || income === null
    ? null
    : { numerator: cap * income.denominator, denominator: income.numerator };
});
```

Build ROE ratios as `TTM income / equity`:

```ts
const roeRows = exactRatioRankingRows(candidates, (entry) => {
  const snapshot = view.fundamentals(entry.shortCode);
  const income = positiveNumberFraction(snapshot?.ttm('NET_INCOME') ?? null);
  const equity = positiveNumberFraction(snapshot?.get('TOTAL_EQUITY') ?? null);
  return income === null || equity === null
    ? null
    : {
        numerator: income.numerator * equity.denominator,
        denominator: income.denominator * equity.numerator,
      };
});
```

Use the existing PIT `view.advanceTo(kstEndOfDayMs(effectiveDate))` before either calculation.

- [ ] **Step 8: Share financial preparation between PER and ROE**

Change the resolver financial branch to `stage.criterion === 'PER' || stage.criterion === 'ROE'`. Keep selection-metric reads only inside the PER calculation. Rename `perRequiredFactYears` to `financialStageRequiredFactYears` and use it for both criteria.

In `backtest-preparation-plan.ts`, change:

```ts
const universeLookback = request.universeRule.stages.some(
  (stage) => stage.criterion === 'PER' || stage.criterion === 'ROE',
) ? 4 : 0;
```

- [ ] **Step 9: Run ROE unit, integration and browser tests GREEN**

```bash
pnpm vitest run tests/unit/backtest-request.test.ts \
  tests/unit/universe-stage-ranking.test.ts \
  tests/unit/universe-rule-resolver.test.ts \
  tests/unit/backtest-preparation-plan.test.ts \
  tests/unit/universe-stage-editor-markup.test.tsx \
  tests/unit/universe-summary.test.ts \
  tests/integration/backtest-universe-preview.test.ts
pnpm typecheck
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop --grep "정렬 방향"
```

Expected: all selected tests, typecheck and the six-stage desktop Playwright scenario pass.

- [ ] **Step 10: Commit the ROE slice**

```bash
git add src/shared/schemas/universe-rule.ts \
  src/server/modules/backtest/application/universe-stage-ranking.ts \
  src/server/modules/backtest/application/universe-rule-resolver.ts \
  src/server/modules/backtest/application/backtest-preparation-plan.ts \
  src/web/features/backtests/universe-pipeline.ts \
  src/web/features/backtests/universe-stage-editor.tsx \
  src/web/features/backtests/universe-summary.ts \
  tests/unit/backtest-request.test.ts tests/unit/universe-stage-ranking.test.ts \
  tests/unit/universe-rule-resolver.test.ts tests/unit/backtest-preparation-plan.test.ts \
  tests/unit/universe-stage-editor-markup.test.tsx tests/unit/universe-summary.test.ts \
  tests/integration/backtest-universe-preview.test.ts tests/e2e/universe-pipeline.spec.ts
git commit -m "feat(backtest): ROE 유니버스 기준을 추가한다"
```

---

### Task 4: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ONBOARDING.md`
- Modify: `docs/SPEC.md`
- Modify: `docs/DECISIONS.md`

**Interfaces:**
- Consumes: the direction and ROE behavior verified by Tasks 1–3
- Produces: current operator guidance, API examples and decision record

- [ ] **Step 1: Update operator and API documentation**

Make these exact documentation changes:

- `README.md:21`: replace `PER 유니버스 단계` with `PER·ROE 유니버스 단계`.
- `docs/ONBOARDING.md:186`: make the same operator-key wording change.
- `docs/SPEC.md`: add `"direction": "HIGH"` to the request example; change maximum stages from 5 to 6; list `ROE` and `가격 변동`; state that each stage stores HIGH/LOW and uses criterion-specific labels; change DART requirements from PER-only to PER·ROE.
- `docs/DECISIONS.md`: append `D-053: 유니버스 단계가 방향을 명시하고 ROE를 지원한다` with the six label pairs, positive-only ROE formula, legacy direction mapping, retained `DECLINE` identifier and six-stage ceiling.

Use active voice and Korean plain declarative style required by `CLAUDE.md`.

- [ ] **Step 2: Run the complete verification suite**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop
git diff --check
```

Expected: every command exits 0, Vitest reports no failed test, Vite/server builds succeed, desktop universe-pipeline scenarios pass, and `git diff --check` prints nothing.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md docs/ONBOARDING.md docs/SPEC.md docs/DECISIONS.md
git commit -m "docs: 유니버스 방향과 ROE 계약을 기록한다"
```

- [ ] **Step 4: Record final evidence**

```bash
git status --short
git log -5 --oneline
```

Expected: the worktree is clean and the latest commits are the direction domain slice, direction UI slice, ROE slice, and documentation/integration slice.
