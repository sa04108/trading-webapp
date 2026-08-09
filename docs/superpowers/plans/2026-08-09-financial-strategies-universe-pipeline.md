# Financial Strategies and Universe Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PIT 재무전략 2개, 순서가 있는 최대 5단계 유니버스 필터, 사용자 지정 리밸런싱 주기, 필요한 구간만 수집하는 재무정보 준비 작업을 하나의 재현 가능한 백테스트 흐름으로 제공한다.

**Architecture:** 공유 요청 스키마가 단계 순서와 리밸런싱 일정을 단일 진실 원천으로 삼는다. 서버는 KRX 일별 선정 지표와 PIT 재무·자본변동을 준비 작업으로 채운 뒤 동일한 순수 선정 파이프라인으로 미리보기와 실행 일정을 만든다. 엔진은 warm-up 봉에서는 상태만 준비하고, 리밸런스 봉에서는 유니버스 이탈 청산을 먼저 끝낸 다음 전략 매수를 허용한다. 웹은 이 서버 모델을 그대로 편집하고 SSE 또는 polling으로 준비 상태를 보여 준다.

**Tech Stack:** TypeScript 5.9, Node.js 24, Zod 4, Fastify 5, Drizzle ORM/SQLite, DuckDB/Parquet, React 19, TanStack Query, Vitest, Playwright, pnpm.

## Global Constraints

- 구현 전에 각 작업의 RED 테스트를 먼저 추가하고 실제 실패 메시지를 확인한다.
- 요청·DB·서버 DTO·웹 타입에 같은 문자열 리터럴과 필드명을 사용한다. 별도 변환 계층에서만 레거시 이름을 허용한다.
- `UniverseRule.stages`는 1~5개, 기준 중복 금지, 첫 `limit`은 1~200, 다음 `limit`은 직전 값 이하로 유지한다.
- 정렬 방향은 시가총액·거래량·거래대금 내림차순, PER 오름차순, 급하락 수익률 오름차순으로 고정한다. 동률은 종목코드 오름차순이다.
- 거래대금은 KRX `ACC_TRDVAL` 원문을 저장한다. `종가 × 거래량`으로 대체하지 않는다.
- PER·ROE와 두 신규 전략은 해당 시점까지 공시된 값만 쓴다. 결측치·0 이하 분모·오래된 공시는 후보에서 제외하고 진단 수치에 반영한다.
- 준비 작업은 한 번에 하나만 실행하고 같은 입력 hash는 single-flight로 합친다. DART 일일 한도에 닿으면 실패가 아니라 `WAITING_DAILY_QUOTA`로 저장하고 다음 KST 날짜에 재개한다.
- warm-up 구간에는 주문, 손익, 스냅샷을 기록하지 않는다. `period.from` 이전 데이터는 지표 상태를 만드는 데만 쓴다.
- 기존 완료 백테스트 결과와 고정 유니버스 데이터는 다시 쓰지 않는다. 저장 요청을 clone할 때만 레거시 규칙을 새 모델로 승격한다.
- 신규 요청의 `risk.maxPositions` 기본값은 40, 허용 범위는 1~200이다. 모든 순위 전략 `topN`도 1~200이고 `topN <= risk.maxPositions`, `topN <= 마지막 단계 limit`을 검증한다.
- 신규 의존성은 추가하지 않는다. 단계 재정렬은 native drag-and-drop과 명시적인 위/아래 이동 버튼을 함께 제공한다.
- 사용자 문구와 개발 문서는 자연스러운 한국어로 쓰고 API 식별자와 코드 심볼은 영어를 유지한다.

---

## File Structure Map

이 계획은 하나의 통합 deliverable로 유지한다. 두 신규 전략은 PIT fact 확장과 warm-up 없이는 실행할 수 없고, 단계형 유니버스는 같은 온디맨드 준비 작업과 schedule pin을 공유하므로 어느 하위 시스템도 분리해서는 독립적으로 사용 가능한 기능이 되지 않는다.

### Shared contract

- `src/shared/schemas/universe-rule.ts`: 단계형 규칙, 주기 스키마, 연쇄 `limit` 검증.
- `src/shared/schemas/rebalance-interval.ts`: 달력 기준 주기 더하기, 기간 포함 여부, 리밸런스 기준일 계산.
- `src/shared/schemas/backtest-request.ts`: 포지션 상한 200과 기간 대비 주기·전략 `topN` 교차 검증.

### Server domain and data

- `src/server/modules/market-data/domain/krx-universe-types.ts`: KRX 거래대금 원문 필드.
- `src/server/modules/market-data/infrastructure/krx/krx-contract.ts`: `ACC_TRDVAL` 파싱.
- `src/server/modules/market-data/application/selection-metric-repository.ts`: 기준일별 선정 지표 저장·조회·결측 탐지.
- `src/server/shared/db/schema.ts`: `daily_selection_metrics`, `backtest_preparation_jobs` 테이블.
- `src/server/modules/facts/domain/fact.ts`: 순이익·자본총계와 분기 offset snapshot contract.
- `src/server/modules/facts/domain/pit-fact-view.ts`: PIT 분기 offset과 offset TTM 계산.
- `src/server/modules/backtest/application/universe-stage-ranking.ts`: 단계별 순수 정렬과 진단.
- `src/server/modules/backtest/application/universe-rule-resolver.ts`: 일정별 단계 순차 적용과 데이터 필요량 산출.
- `src/server/modules/backtest/application/backtest-preparation-orchestrator.ts`: 영속 준비 작업, quota 대기·재개, single-flight.
- `src/server/modules/backtest/presentation/backtest-preparation-routes.ts`: 시작·조회·SSE·취소 API.
- `src/server/modules/backtest/domain/engine.ts`: warm-up 경계, `isRebalanceBar`, 유니버스 이탈 청산과 매수 지연.
- `src/server/modules/strategy/domain/strategy.ts`: 현재 리밸런스 봉과 pin된 KRX 선정 지표를 전략에 노출.

### Strategies

- `src/server/modules/strategy/strategies/earnings-acceleration-rank.ts`: 이익 가속·가격 확인 순위.
- `src/server/modules/strategy/strategies/low-per-high-roe-rank.ts`: 저PER·고ROE 순위.
- `src/server/modules/strategy/strategies/shared/fundamental-rank.ts`: 공통 신선도·순위 결합.
- `src/server/modules/strategy/strategies/cross-sectional-momentum.ts`: 공통 리밸런스 신호 사용.
- `src/server/modules/strategy/strategies/value-quality-rank.ts`: 공통 리밸런스 신호 사용.

### Web

- `src/web/features/backtests/universe-pipeline.ts`: 단계 추가·삭제·이동과 limit cascade 순수 상태 함수.
- `src/web/features/backtests/universe-stage-editor.tsx`: 순서 편집 UI.
- `src/web/features/backtests/preparation-progress.tsx`: 준비 상태와 quota 대기 표시.
- `src/web/features/backtests/universe-rule-step.tsx`: 편집기·주기·미리보기 연결.
- `src/web/features/backtests/new-backtest-wizard.tsx`: 기본값 40, 준비 완료 후 다음 단계 허용.

---

### Task 1: 단계형 요청 계약과 리밸런싱 달력 확정

**Files:**

- Create: `src/shared/schemas/rebalance-interval.ts`
- Modify: `src/shared/schemas/universe-rule.ts`
- Modify: `src/shared/schemas/backtest-request.ts`
- Modify: `src/server/modules/backtest/application/stored-request.ts`
- Test: `tests/unit/backtest-request.test.ts`
- Test: `tests/unit/rebalance-interval.test.ts`
- Test: `tests/integration/job-queue.test.ts`

**Interfaces:**

- Consumes: 기존 `BacktestPeriod`, `backtestRequestSchema`, 저장 요청 clone/rebase 흐름.
- Produces: `UniverseCriterion`, `UniverseStage`, `RebalanceInterval`, `UniverseRule`, `addRebalanceInterval(anchor, interval, multiple?)`, `computeRebalanceDates(period, interval)`, `rebalanceIntervalFitsPeriod(period, interval)`.

- [ ] **Step 1: 새 계약의 실패 테스트를 작성한다.**

  `tests/unit/backtest-request.test.ts`에 다음 경계를 표로 추가한다.

  ```ts
  const validRule = {
    markets: ['KOSPI'] as const,
    stages: [
      { criterion: 'MARKET_CAP' as const, limit: 100 },
      { criterion: 'PER' as const, limit: 40 },
    ],
    rebalanceInterval: { value: 1, unit: 'MONTH' as const },
  };

  it.each([
    ['중복 기준', { ...validRule, stages: [{ criterion: 'PER', limit: 100 }, { criterion: 'PER', limit: 40 }] }],
    ['증가하는 N', { ...validRule, stages: [{ criterion: 'MARKET_CAP', limit: 40 }, { criterion: 'PER', limit: 41 }] }],
    ['6개 단계', { ...validRule, stages: Array.from({ length: 6 }, (_, i) => ({ criterion: ['MARKET_CAP', 'VOLUME', 'TRADING_VALUE', 'PER', 'DECLINE'][i % 5], limit: 10 })) }],
  ])('%s 규칙을 거부한다', (_name, universeRule) => {
    expect(backtestRequestSchema.safeParse({ ...baseRequest, universeRule }).success).toBe(false);
  });
  ```

  `tests/unit/rebalance-interval.test.ts`에는 1일·1주·월말 clamp·윤년·1년과 `interval <= inclusive period`를 고정한다. `2024-01-31 + 1 MONTH = 2024-02-29`, `2025-01-31 + 1 MONTH = 2025-02-28`을 반드시 포함한다.

- [ ] **Step 2: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/backtest-request.test.ts tests/unit/rebalance-interval.test.ts`

  Expected: `stages`, `rebalanceInterval`이 아직 없고 `maxPositions: 40` 이상이 거부되어 실패한다.

- [ ] **Step 3: 공유 스키마와 달력 함수를 최소 구현한다.**

  `universe-rule.ts`의 공개 타입을 다음 모양으로 고정한다.

  ```ts
  export const universeCriterionSchema = z.enum([
    'MARKET_CAP', 'VOLUME', 'TRADING_VALUE', 'PER', 'DECLINE',
  ]);
  export const rebalanceIntervalSchema = z.discriminatedUnion('unit', [
    z.object({ unit: z.literal('DAY'), value: z.number().int().min(1).max(365) }),
    z.object({ unit: z.literal('WEEK'), value: z.number().int().min(1).max(52) }),
    z.object({ unit: z.literal('MONTH'), value: z.number().int().min(1).max(12) }),
    z.object({ unit: z.literal('YEAR'), value: z.literal(1) }),
  ]);
  export const universeRuleSchema = z.object({
    markets: z.array(z.enum(['KOSPI', 'KOSDAQ'])).length(1),
    stages: z.array(universeStageSchema).min(1).max(5),
    rebalanceInterval: rebalanceIntervalSchema,
  }).superRefine((rule, ctx) => {
    const seen = new Set<UniverseCriterion>();
    rule.stages.forEach((stage, index) => {
      if (seen.has(stage.criterion)) ctx.addIssue({ code: 'custom', path: ['stages', index, 'criterion'], message: '같은 정렬 기준은 한 번만 사용할 수 있습니다.' });
      if (index > 0 && stage.limit > rule.stages[index - 1]!.limit) ctx.addIssue({ code: 'custom', path: ['stages', index, 'limit'], message: '다음 단계 N은 직전 단계 N 이하여야 합니다.' });
      seen.add(stage.criterion);
    });
  });
  ```

  `rebalance-interval.ts`는 다음 API만 노출한다.

  ```ts
  export function addRebalanceInterval(anchor: string, interval: RebalanceInterval, multiple?: number): string;
  export function computeRebalanceDates(period: BacktestPeriod, interval: RebalanceInterval): string[];
  export function rebalanceIntervalFitsPeriod(period: BacktestPeriod, interval: RebalanceInterval): boolean;
  ```

  날짜는 UTC calendar component로 계산하고, 월·연 단위는 원래 anchor의 일자를 매번 기준으로 clamp한다. 직전 결과에 반복 덧셈하지 않는다. 기간 적합성은 inclusive 기간을 정확히 반영해 `addRebalanceInterval(period.from, interval) <= addUtcDays(period.to, 1)`로 계산한다. 따라서 하루짜리 기간에도 1일 주기는 허용한다.

- [ ] **Step 4: 요청 교차 검증과 clone 승격 테스트를 추가한다.**

  `tests/integration/job-queue.test.ts`에 레거시 `{ sortKey: 'MKTCAP', topN: 200 }`가 `MARKET_CAP` 한 단계로 바뀌고, 전략의 `rebalanceMonths: 3`이 `{ value: 3, unit: 'MONTH' }`로 이동하며 파라미터에서 제거되는 clone 테스트를 추가한다. 값이 없으면 1개월과 경고가 생기는 경우도 고정한다.

- [ ] **Step 5: 교차 검증과 레거시 승격을 구현한다.**

  `backtest-request.ts`에서 `risk.maxPositions`를 `.max(200)`으로 바꾸고 다음 조건을 `superRefine`으로 검사한다.

  ```ts
  const lastLimit = request.universeRule.stages.at(-1)!.limit;
  if (!rebalanceIntervalFitsPeriod(request.period, request.universeRule.rebalanceInterval)) issue('리밸런싱 주기가 백테스트 전체 기간을 초과합니다.');
  if (typeof request.parameters.topN === 'number' && request.parameters.topN > request.risk.maxPositions) issue('전략 topN은 동시 보유 상한 이하여야 합니다.');
  if (typeof request.parameters.topN === 'number' && request.parameters.topN > lastLimit) issue('전략 topN은 최종 유니버스 N 이하여야 합니다.');
  ```

  `stored-request.ts`는 저장 원본을 바꾸지 않고 clone 결과에만 `rebaseUniverseRule()`을 적용한다. 레거시 risk 값은 보존하고, risk 자체가 없는 요청에만 40을 채운다.

- [ ] **Step 6: Task 1 검증과 커밋을 수행한다.**

  Run: `pnpm exec vitest run tests/unit/backtest-request.test.ts tests/unit/rebalance-interval.test.ts tests/integration/job-queue.test.ts`

  Expected: PASS.

  Run: `pnpm typecheck`

  Expected: 제거 예정인 기존 `topN/sortKey/rebalanceMonths` 소비 지점에서 타입 오류가 나면, 이 task에서는 임시 호환 helper로 컴파일만 유지하고 후속 task에서 제거한다.

  Commit: `git add src/shared/schemas src/server/modules/backtest/application/stored-request.ts tests/unit tests/integration/job-queue.test.ts && git commit -m "feat: 단계형 유니버스 요청 계약을 추가한다"`

---

### Task 2: KRX 일별 선정 지표를 원문 그대로 저장

**Files:**

- Modify: `src/server/shared/db/schema.ts`
- Modify: `src/server/modules/market-data/domain/krx-universe-types.ts`
- Modify: `src/server/modules/market-data/infrastructure/krx/krx-contract.ts`
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts`
- Create: `src/server/modules/market-data/application/selection-metric-repository.ts`
- Create: `migrations/0014_daily_selection_metrics.sql`
- Modify: `migrations/meta/_journal.json`
- Create: `migrations/meta/0014_snapshot.json`
- Test: `tests/unit/krx-contract.test.ts`
- Test: `tests/unit/selection-metric-repository.test.ts`
- Test: `tests/unit/symbol-master-service.test.ts`

**Interfaces:**

- Consumes: Task 1의 `UniverseCriterion` 중 KRX 지표 기준, 기존 `SymbolMasterService.ingestDate()`와 `KrxDailyTradeRow`.
- Produces: `DailySelectionMetric`, `SelectionMetricRepository.upsertMany()`, `getAt()`, `findMissingTradingValueDates()`, `SymbolMasterService.ensureSelectionMetrics(dates)`.

- [ ] **Step 1: 거래대금 파싱과 저장의 RED 테스트를 작성한다.**

  KRX fixture에 `ACC_TRDVAL: '123456789012345'`를 넣고 `tradingValueRaw`가 같은 문자열인지 검증한다. repository 테스트는 같은 날짜·표준코드 upsert, nullable metric, `findMissingTradingValueDates()`를 검증한다. 숫자를 JS `number`로 바꿔 정밀도가 손실되는 구현은 테스트에서 금지한다.

  ```ts
  const [row] = parseDailyRows([{ ISU_SRT_CD: '005930', ACC_TRDVAL: '123456789012345' }]);
  expect(row?.tradingValueRaw).toBe('123456789012345');
  repository.upsertMany([{ date: '2026-08-07', standardCode: 'KR7005930003', marketCapKrw: 1n, volume: 2, tradingValueKrw: null }]);
  expect(repository.findMissingTradingValueDates(['2026-08-07'])).toEqual(['2026-08-07']);
  ```

- [ ] **Step 2: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/krx-contract.test.ts tests/unit/selection-metric-repository.test.ts tests/unit/symbol-master-service.test.ts`

  Expected: `ACC_TRDVAL`, 새 table, repository가 없어 실패한다.

- [ ] **Step 3: 테이블과 repository를 추가한다.**

  `daily_selection_metrics`는 `(date, standard_code)` 복합 PK를 쓰고 금액은 SQLite integer 범위를 안전하게 다루도록 text로 저장한다.

  ```ts
  export const dailySelectionMetrics = sqliteTable('daily_selection_metrics', {
    date: text('date').notNull(),
    standardCode: text('standard_code').notNull(),
    marketCapKrw: text('market_cap_krw'),
    volume: integer('volume'),
    tradingValueKrw: text('trading_value_krw'),
  }, (t) => [primaryKey({ columns: [t.date, t.standardCode] })]);
  ```

  repository 공개 API를 고정한다.

  ```ts
  export interface DailySelectionMetric {
    date: string;
    standardCode: string;
    marketCapKrw: bigint | null;
    volume: number | null;
    tradingValueKrw: bigint | null;
  }
  export class SelectionMetricRepository {
    upsertMany(rows: readonly DailySelectionMetric[]): void;
    getAt(date: string, standardCodes: readonly string[]): ReadonlyMap<string, DailySelectionMetric>;
    findMissingTradingValueDates(dates: readonly string[]): string[];
  }
  ```

- [ ] **Step 4: Drizzle migration 산출물을 만든다.**

  schema 변경 뒤 `pnpm db:generate -- --name daily_selection_metrics`를 실행한다. 생성 파일명이 다르면 `migrations/0014_daily_selection_metrics.sql`로 맞추고 `_journal.json`의 tag도 동일하게 맞춘다. migration은 기존 `symbol_master_market_caps`를 `market_cap_krw`로 복사한다. 기존 `krx_daily_bars.volume`은 `SymbolMasterService.backfillSelectionMetricVolume()`가 날짜별 PIT short-code→standard-code mapping을 거쳐 한 번만 보강한다.

- [ ] **Step 5: 수집과 enrichment를 연결한다.**

  `KrxDailyTradeRow`에 `tradingValueRaw: string | null`을 추가하고 `SymbolMasterService.ingestDate()`가 cap·volume·trading value를 한 transaction으로 upsert하게 한다. 이미 심볼 마스터 coverage가 있어 ingest를 건너뛰는 날짜를 위해 다음 메서드를 추가한다.

  ```ts
  async ensureSelectionMetrics(dates: readonly string[]): Promise<void>;
  ```

  이 메서드는 거래대금이 비어 있는 날짜만 KRX에서 다시 받고 기존 봉이나 cap을 삭제하지 않는다.

- [ ] **Step 6: Task 2 검증과 커밋을 수행한다.**

  Run: `pnpm exec vitest run tests/unit/krx-contract.test.ts tests/unit/selection-metric-repository.test.ts tests/unit/symbol-master-service.test.ts`

  Expected: PASS.

  Run: `pnpm typecheck`

  Expected: PASS.

  Commit: `git add src/server/shared/db src/server/modules/market-data migrations tests/unit && git commit -m "feat: KRX 일별 선정 지표를 저장한다"`

---

### Task 3: PIT 재무 snapshot을 8개 분기까지 조회

**Files:**

- Modify: `src/server/modules/facts/domain/fact.ts`
- Modify: `src/server/modules/facts/domain/pit-fact-view.ts`
- Modify: `src/server/modules/facts/infrastructure/dart/dart-account-map.ts`
- Modify: `src/server/modules/facts/infrastructure/dart/dart-report-parser.ts`
- Test: `tests/unit/pit-fact-view.test.ts`
- Create: `tests/unit/dart-account-map.test.ts`
- Test: `tests/unit/dart-report-parser.test.ts`

**Interfaces:**

- Consumes: 기존 `Fact`, `FundamentalSnapshot`, `PitFactView`, DART IS/BS parser.
- Produces: `FundamentalField`의 `NET_INCOME | TOTAL_EQUITY`, `FundamentalSnapshot.quarter(field, offset?)`, offset을 받는 `ttm(field, endOffset?)`.

- [ ] **Step 1: 계정 mapping과 offset 조회의 RED 테스트를 작성한다.**

  IFRS `ifrs-full_ProfitLoss`, `ifrs-full_Equity`와 DART 한글 계정명 `당기순이익`, `당기순이익(손실)`, `자본총계`를 각각 `NET_INCOME`, `TOTAL_EQUITY`로 mapping하는 fixture를 추가한다. snapshot 테스트는 공시 시각을 넘기기 전·후, quarter offset 0·1·7, `ttm(field, 0)`과 `ttm(field, 4)`, 분기 하나가 빠진 경우 null을 검증한다.

  ```ts
  view.advanceTo(announcedAt - 1);
  expect(view.fundamentals('005930')?.quarter('NET_INCOME', 0)).toBeNull();
  view.advanceTo(announcedAt);
  const snapshot = view.fundamentals('005930')!;
  expect(snapshot.quarter('NET_INCOME', 7)?.periodKey).toBe('2024Q1');
  expect(snapshot.ttm('NET_INCOME', 4)).toBe(priorFourQuarterSum);
  ```

- [ ] **Step 2: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/pit-fact-view.test.ts tests/unit/dart-account-map.test.ts tests/unit/dart-report-parser.test.ts`

  Expected: 새 계정 리터럴과 offset API가 없어 실패한다.

- [ ] **Step 3: 재무 contract와 PIT 계산을 구현한다.**

  ```ts
  export type FundamentalField =
    | 'OPERATING_INCOME'
    | 'NET_INCOME'
    | 'CURRENT_ASSETS'
    | 'CURRENT_LIABILITIES'
    | 'TANGIBLE_ASSETS'
    | 'CASH_AND_EQUIVALENTS'
    | 'SHORT_TERM_INVESTMENTS'
    | 'SHORT_TERM_BORROWINGS'
    | 'CURRENT_LONG_TERM_DEBT'
    | 'BONDS'
    | 'LONG_TERM_BORROWINGS'
    | 'TOTAL_EQUITY'
    | 'SHARES_OUTSTANDING';
  export const FLOW_FIELDS = ['OPERATING_INCOME', 'NET_INCOME'] as const;

  export interface FundamentalSnapshot {
    get(field: FundamentalField): number | null;
    quarter(field: FundamentalField, offset?: number): { periodKey: string; value: number } | null;
    ttm(field: FundamentalField, endOffset?: number): number | null;
    periodKeyOf(field: FundamentalField): string | null;
    readonly latestPeriodKey: string | null;
    readonly latestAsOfTsMs: number | null;
  }
  ```

  `quarter()`의 offset은 해당 field의 최신 분기에서 calendar quarter를 정확히 뺀 값이다. 중간 분기가 빠지면 offset을 건너뛰지 않는다. `ttm(field, 4)`는 offset 4~7의 합이다. point-in-time 계정인 `TOTAL_EQUITY`에 `ttm()`을 부르면 null을 반환한다.

- [ ] **Step 4: DART parser를 새 계정에 연결한다.**

  순이익은 IS flow normalization을 그대로 거치고, 자본총계는 BS point value로 저장한다. 연결·별도 재무제표가 함께 있으면 기존 우선순위를 보존한다. mapping 충돌 시 정확한 account ID가 이름 fallback보다 우선한다.

- [ ] **Step 5: Task 3 검증과 커밋을 수행한다.**

  Run: `pnpm exec vitest run tests/unit/pit-fact-view.test.ts tests/unit/dart-account-map.test.ts tests/unit/dart-report-parser.test.ts`

  Expected: PASS.

  Run: `pnpm typecheck`

  Expected: PASS.

  Commit: `git add src/server/modules/facts tests/unit/pit-fact-view.test.ts tests/unit/dart-account-map.test.ts tests/unit/dart-report-parser.test.ts && git commit -m "feat: PIT 순이익과 자본총계를 지원한다"`

---

### Task 4: 순서가 보존되는 유니버스 선정 파이프라인 구현

**Files:**

- Create: `src/server/modules/backtest/application/universe-stage-ranking.ts`
- Modify: `src/server/modules/backtest/application/universe-rule-resolver.ts`
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts`
- Test: `tests/unit/universe-stage-ranking.test.ts`
- Test: `tests/unit/universe-rule-resolver.test.ts`
- Test: `tests/integration/backtest-universe-preview.test.ts`

**Interfaces:**

- Consumes: Task 1의 `UniverseRule`·`computeRebalanceDates()`, Task 2의 `SelectionMetricRepository`, Task 3의 PIT snapshot과 자본변동.
- Produces: `rankUniverseStage()`, `UniverseStageDiagnostic`, `UniverseDataNeed`, `UniverseScheduleMember`, `UniverseScheduleEntry`, `UniverseResolveAttempt`, `UniverseRuleResolver.resolveOrDescribeNeeds()`.

- [ ] **Step 1: 단계 순서·결측·동률 RED 테스트를 작성한다.**

  같은 fixture에 `MARKET_CAP→PER`와 `PER→MARKET_CAP`을 적용해 서로 다른 최종 코드가 나오는지 검증한다. 다음 cases를 별도 테스트로 둔다.

  - volume, exact trading value, positive trailing PER, N-day split-adjusted decline의 고정 방향.
  - PER의 순이익·시가총액 결측과 0 이하 순이익 제외.
  - decline warm-up 부족과 corporate-action coverage 부족을 `NEEDS_DATA`로 반환.
  - 같은 값은 short code 오름차순.
  - 각 단계의 `inputCount`, `eligibleCount`, `selectedCount`, `excludedMissingCount`.

  ```ts
  const capThenPer = await resolver.resolveOrDescribeNeeds(capThenPerRule, period);
  const perThenCap = await resolver.resolveOrDescribeNeeds(perThenCapRule, period);
  expect(capThenPer.kind).toBe('READY');
  expect(perThenCap.kind).toBe('READY');
  if (capThenPer.kind !== 'READY' || perThenCap.kind !== 'READY') throw new Error('fixture coverage가 완전해야 합니다.');
  expect(capThenPer.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000002']);
  expect(perThenCap.schedule[0]?.members.map((member) => member.symbol)).toEqual(['000003']);
  expect(capThenPer.diagnostics[0]?.stages[1]).toMatchObject({ inputCount: 2, eligibleCount: 1, selectedCount: 1, excludedMissingCount: 1 });
  ```

- [ ] **Step 2: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/universe-stage-ranking.test.ts tests/unit/universe-rule-resolver.test.ts`

  Expected: 순수 rank 함수와 다단계 resolver contract가 없어 실패한다.

- [ ] **Step 3: 순수 단계 함수부터 구현한다.**

  ```ts
  export interface UniverseStageValue {
    standardCode: string;
    shortCode: string;
    value: number | bigint | null;
  }
  export interface UniverseStageDiagnostic {
    criterion: UniverseCriterion;
    inputCount: number;
    eligibleCount: number;
    selectedCount: number;
    excludedMissingCount: number;
  }
  export function rankUniverseStage(
    stage: UniverseStage,
    rows: readonly UniverseStageValue[],
  ): { selectedCodes: string[]; diagnostic: UniverseStageDiagnostic };
  ```

  bigint 비교는 subtraction이나 `Number()` 변환 없이 `<`/`>`로 한다. PER과 decline은 finite number만 허용한다. tie-break를 모든 criterion에 공통 적용한다.

- [ ] **Step 4: resolver를 명시적 준비 결과 계약으로 구현한다.**

  ```ts
  export interface UniverseDataNeed {
    factSymbols: readonly string[];
    actionSymbols: readonly string[];
    selectionMetricDates: readonly string[];
    priceRange: { from: string; to: string } | null;
  }
  export type UniverseResolveAttempt =
    | { kind: 'READY'; schedule: readonly UniverseScheduleEntry[]; diagnostics: readonly RebalanceDiagnostic[] }
    | { kind: 'NEEDS_DATA'; needs: UniverseDataNeed };

  export interface UniverseScheduleMember {
    symbol: string;
    standardCode: string;
    marketCapKrw: string | null;
    volume: number | null;
    tradingValueKrw: string | null;
  }
  export interface UniverseScheduleEntry {
    rebalanceDate: string;
    effectiveDate: string;
    fromTsMs: number;
    members: readonly UniverseScheduleMember[];
  }
  export interface RebalanceDiagnostic {
    rebalanceDate: string;
    effectiveDate: string;
    stages: readonly UniverseStageDiagnostic[];
  }

  resolveOrDescribeNeeds(rule: UniverseRule, period: BacktestPeriod): Promise<UniverseResolveAttempt>;
  ```

  날짜별로 `computeRebalanceDates()`를 호출하고 다음 순서로 처리한다.

  1. 기준일 이전 또는 당일의 최신 KRX 거래일을 effective date로 고른다.
  2. 현재 후보에만 stage metric을 계산한다.
  3. PER stage는 effective date 시점의 PIT TTM 순이익과 그 날짜 시가총액을 쓴다.
  4. decline stage는 effective date를 포함한 정확히 N개 거래일의 split-adjusted close 수익률 `(last / first) - 1`을 쓴다.
  5. 필요한 coverage가 없으면 일부 순위를 추측하지 않고 합집합 `NEEDS_DATA`를 반환한다.
  6. READY일 때만 schedule을 반환한다. 최종 member의 effective-date cap·volume·trading value를 문자열/정수 snapshot으로 함께 pin해 실행 중 KRX 원천을 다시 읽지 않는다.

- [ ] **Step 5: preview 응답을 새 진단 shape로 임시 연결한다.**

  이 task의 preview는 데이터가 준비되어 있으면 200을 반환하고, `NEEDS_DATA`이면 409와 구조화된 `needs`를 반환하게 한다. Task 6에서 이 409 경로를 자동 준비 작업 202 응답으로 바꾼다. 기존 `selectionMethod: 'TOP_MARKET_CAP_N'` 상수는 단계 배열 요약으로 교체한다.

- [ ] **Step 6: Task 4 검증과 커밋을 수행한다.**

  Run: `pnpm exec vitest run tests/unit/universe-stage-ranking.test.ts tests/unit/universe-rule-resolver.test.ts tests/integration/backtest-universe-preview.test.ts`

  Expected: PASS.

  Run: `pnpm typecheck`

  Expected: PASS.

  Commit: `git add src/server/modules/backtest tests/unit/universe-stage-ranking.test.ts tests/unit/universe-rule-resolver.test.ts tests/integration/backtest-universe-preview.test.ts && git commit -m "feat: 단계 순서대로 유니버스를 선정한다"`

---

### Task 5: 동기화 구간·DART quota를 계산하는 준비 계획 추가

**Files:**

- Modify: `src/server/modules/facts/domain/sync-plan.ts`
- Modify: `src/server/modules/facts/application/fact-sync-service.ts`
- Modify: `src/server/modules/facts/application/ports.ts`
- Create: `src/server/modules/backtest/application/backtest-preparation-plan.ts`
- Modify: `src/server/modules/market-data/domain/fact-year-range.ts`
- Test: `tests/unit/sync-plan.test.ts`
- Test: `tests/unit/fact-sync-service.test.ts`
- Create: `tests/unit/backtest-preparation-plan.test.ts`

**Interfaces:**

- Consumes: Task 4의 `UniverseDataNeed`, registry의 `AnyTradingStrategy`, 기존 `planFactSync()`와 `FactSyncService`.
- Produces: `FactSyncWorkUnit`, `FactSyncHooks.beforeWorkUnit()`, `FactSyncReport.stopReason`의 `DAILY_QUOTA`, `BacktestPreparationPlan`, `buildBacktestPreparationPlan()`.

- [ ] **Step 1: 최소 동기화 범위와 quota 중단의 RED 테스트를 작성한다.**

  준비 계획 테스트에서 다음 matrix를 고정한다.

  | 요구 원인 | 재무 warm-up | 가격 warm-up | 자본변동 |
  |---|---:|---:|---|
  | PER stage | 4분기 | 없음 | 없음 |
  | 저PER·고ROE | 4분기 | 없음 | 최종 유니버스 전체 |
  | 이익 가속 | 8분기 | `priceMomentumDays` | 최종 유니버스 전체 |
  | 급하락 stage | 없음 | `lookbackTradingDays` | 해당 stage 진입 후보 |

  `FactSyncService` 테스트는 첫 종목·연도 저장 뒤 다음 연도 work unit을 시작하기 전에 hook가 `PAUSE_DAILY_QUOTA`를 반환하면 report가 부분 성공 건수를 보존하고 `stopReason: 'DAILY_QUOTA'`를 내는지 검증한다. 사용자 취소는 여전히 종목 경계에서만 확인하는 별도 테스트로 유지한다.

  ```ts
  const report = await service.sync(request, {
    beforeWorkUnit: (work) => work.year === 2025 ? 'PAUSE_DAILY_QUOTA' : 'CONTINUE',
  });
  expect(report).toMatchObject({ savedFacts: 2, stoppedAtSymbol: '005930', stopReason: 'DAILY_QUOTA' });
  expect(buildBacktestPreparationPlan(earningsInput).financial.fromYear).toBe(2024);
  ```

- [ ] **Step 2: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/sync-plan.test.ts tests/unit/fact-sync-service.test.ts tests/unit/backtest-preparation-plan.test.ts`

  Expected: 전략별 lookback metadata와 quota stop reason이 없어 실패한다.

- [ ] **Step 3: FactSync를 종목 경계에서 멈출 수 있게 확장한다.**

  기존 CLI와 수동 sync가 쓰는 동작을 깨지 않도록 hook는 optional로 추가한다.

  ```ts
  export interface FactSyncWorkUnit {
    symbol: string;
    year: number;
    shareYears: readonly number[];
    estimatedDartCalls: number;
  }
  export interface FactSyncHooks {
    onSymbolDone?(progress: FactSyncProgress): void;
    shouldStop?(): boolean;
    beforeWorkUnit?(work: FactSyncWorkUnit): 'CONTINUE' | 'PAUSE_DAILY_QUOTA';
  }
  export interface FactSyncReport {
    // 기존 필드 유지
    stopReason: 'ERROR' | 'CANCELLED' | 'DAILY_QUOTA' | null;
  }
  ```

  `estimateDartCalls(work)`를 `sync-plan.ts`에 두어 준비 작업과 실제 sync가 같은 계산을 쓰게 한다. `runSync()`는 한 symbol 안에서도 연도별 `FetchFinancialsRequest`를 실행하고 그 work unit을 즉시 저장·coverage 기록한다. quota는 다음 종목·연도 work unit의 외부 호출 전에 확인한다. 사용자 취소용 `shouldStop`은 현재 동작처럼 다음 symbol을 시작하기 전에만 확인한다.

- [ ] **Step 4: 준비 계획의 공개 함수를 구현한다.**

  ```ts
  export interface BacktestPreparationPlan {
    requestHash: string;
    rebalanceDates: readonly string[];
    financial: { symbols: readonly string[]; fromYear: number; toYear: number };
    actions: { symbols: readonly string[]; fromYear: number; toYear: number };
    price: { symbols: readonly string[]; from: string; to: string };
  }
  export function buildBacktestPreparationPlan(input: {
    request: BacktestRequest;
    resolutionNeeds: UniverseDataNeed;
    finalUniverseSymbols?: readonly string[];
    strategy: AnyTradingStrategy;
  }): BacktestPreparationPlan;
  ```

  hash 입력은 canonical JSON으로 정렬한 `{ period, universeRule, strategyId, strategyVersion, parameters }`다. `risk`, costs, seed는 데이터 필요량을 바꾸지 않으므로 제외한다. 전략 metadata는 다음 task에서 실제 값으로 채우되 이 task에서 contract를 먼저 추가한다.

  ```ts
  readonly dataRequirements?: {
    fundamentalLookbackQuarters?: number;
    priceWarmupBars?: (parameters: TParameters) => number;
    requiresCorporateActions?: boolean;
  };
  ```

- [ ] **Step 5: Task 5 검증과 커밋을 수행한다.**

  Run: `pnpm exec vitest run tests/unit/sync-plan.test.ts tests/unit/fact-sync-service.test.ts tests/unit/backtest-preparation-plan.test.ts`

  Expected: PASS.

  Run: `pnpm typecheck`

  Expected: PASS.

  Commit: `git add src/server/modules/facts src/server/modules/backtest/application src/server/modules/strategy/domain/strategy.ts tests/unit && git commit -m "feat: 백테스트 데이터 준비 범위를 계산한다"`

---

### Task 6: 영속적인 온디맨드 준비 작업과 API 구현

**Files:**

- Modify: `src/server/shared/db/schema.ts`
- Create: `migrations/0015_backtest_preparation_jobs.sql`
- Modify: `migrations/meta/_journal.json`
- Create: `migrations/meta/0015_snapshot.json`
- Create: `src/server/modules/backtest/application/backtest-preparation-orchestrator.ts`
- Create: `src/server/modules/backtest/presentation/backtest-preparation-routes.ts`
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts`
- Modify: `src/server/bootstrap/container.ts`
- Modify: `src/server/bootstrap/main.ts`
- Modify: `src/server/bootstrap/server.ts`
- Delete: `src/server/modules/facts/application/corporate-action-sync-orchestrator.ts`
- Delete: `src/server/modules/facts/presentation/corporate-action-routes.ts`
- Test: `tests/unit/backtest-preparation-orchestrator.test.ts`
- Test: `tests/integration/backtest-universe-preview.test.ts`
- Create: `tests/integration/backtest-preparation.test.ts`
- Delete: `tests/unit/corporate-action-sync-orchestrator.test.ts`
- Delete: `tests/integration/corporate-action-sync.test.ts`

**Interfaces:**

- Consumes: Task 4의 `resolveOrDescribeNeeds()`, Task 5의 preparation plan·quota-aware `FactSyncService`, Task 2의 metric enrichment.
- Produces: `PreparationStatus`, `PreparationPhase`, `BacktestPreparationJobDto`, `BacktestPreparationOrchestrator.start/get/cancel/recoverOrphaned/subscribe/stop`, preview 200/202 contract와 preparation 조회·SSE·취소 routes.

- [ ] **Step 1: 상태 전이·single-flight·재개의 RED 테스트를 작성한다.**

  orchestrator 단위 테스트는 아래 전이만 허용하도록 고정한다.

  ```text
  QUEUED -> RUNNING
  RUNNING -> WAITING_DAILY_QUOTA | COMPLETED | FAILED | CANCELLED
  WAITING_DAILY_QUOTA -> QUEUED | CANCELLED
  ```

  같은 hash를 두 번 시작하면 같은 active job ID를 반환하고, 서로 다른 hash는 active job 뒤에 QUEUED로 남는다. 재시작 시 RUNNING job은 QUEUED로 회수하고, quota 대기 job은 `nextResumeAtMs <= now`일 때만 회수한다. 취소는 현재 symbol 저장이 끝난 경계에서 terminal 상태가 된다.

- [ ] **Step 2: API의 RED 테스트를 작성한다.**

  `tests/integration/backtest-preparation.test.ts`에 다음 contract를 추가한다.

  - `POST /api/v1/backtests/universe-preview`: 준비가 필요하면 202와 job snapshot, 이미 완료됐으면 200과 preview.
  - `GET /api/v1/backtests/preparation-jobs/:id`: 현재 status·phase·progress·nextResumeAtMs.
  - `GET /api/v1/backtests/preparation-jobs/:id/events`: `text/event-stream`, 첫 snapshot 즉시 전송, terminal 뒤 close.
  - `POST /api/v1/backtests/preparation-jobs/:id/cancel`: idempotent cancel.
  - DART API key가 없으면 financial sync가 필요한 요청만 503.
  - 최종 유니버스가 0이면 job FAILED와 사용자용 원인.

  ```ts
  const first = orchestrator.start(input);
  const duplicate = orchestrator.start(input);
  expect(duplicate.id).toBe(first.id);
  quota.releaseNextWorkUnit();
  await waitFor(() => orchestrator.get(first.id)?.status === 'WAITING_DAILY_QUOTA');
  expect(orchestrator.get(first.id)?.nextResumeAtMs).toBe(nextKstMidnightMs);
  ```

- [ ] **Step 3: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/backtest-preparation-orchestrator.test.ts tests/integration/backtest-preparation.test.ts`

  Expected: table, orchestrator, route가 없어 실패한다.

- [ ] **Step 4: job table과 migration을 추가한다.**

  ```ts
  export const backtestPreparationJobs = sqliteTable('backtest_preparation_jobs', {
    id: text('id').primaryKey(),
    requestHash: text('request_hash').notNull(),
    requestJson: text('request_json').notNull(),
    status: text('status').notNull(),
    phase: text('phase').notNull(),
    doneSymbols: integer('done_symbols').notNull().default(0),
    totalSymbols: integer('total_symbols').notNull().default(0),
    savedFacts: integer('saved_facts').notNull().default(0),
    gapCount: integer('gap_count').notNull().default(0),
    dartQuotaDateKst: text('dart_quota_date_kst'),
    dartCallsUsed: integer('dart_calls_used').notNull().default(0),
    nextResumeAtMs: integer('next_resume_at_ms'),
    previewJson: text('preview_json'),
    error: text('error'),
    cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    completedAtMs: integer('completed_at_ms'),
  }, (t) => [index('preparation_jobs_hash_idx').on(t.requestHash, t.status)]);
  ```

  migration은 `corporate_action_sync_jobs` table을 제거한다. 기존 row는 실행 이력일 뿐 백테스트 결과가 아니므로 이관하지 않는다.

- [ ] **Step 5: orchestrator의 phase loop를 구현한다.**

  phase는 `MARKET_DATA`, `RESOLVING_STAGES`, `SYNCING_FACTS`, `FINALIZING` 네 값만 쓴다.

  ```ts
  export type PreparationStatus =
    | 'QUEUED' | 'RUNNING' | 'WAITING_DAILY_QUOTA'
    | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  export type PreparationPhase =
    | 'MARKET_DATA' | 'RESOLVING_STAGES' | 'SYNCING_FACTS' | 'FINALIZING';
  export interface PreparationInput {
    universeRule: UniverseRule;
    period: BacktestPeriod;
    strategyId: string;
    parameters: Record<string, unknown>;
  }
  export interface BacktestPreparationJobDto {
    id: string;
    requestHash: string;
    status: PreparationStatus;
    phase: PreparationPhase;
    doneSymbols: number;
    totalSymbols: number;
    savedFacts: number;
    gapCount: number;
    nextResumeAtMs: number | null;
    error: string | null;
  }
  export class BacktestPreparationOrchestrator {
    start(input: PreparationInput): BacktestPreparationJobDto;
    get(jobId: string): BacktestPreparationJobDto | null;
    cancel(jobId: string): boolean;
    recoverOrphaned(): void;
    subscribe(jobId: string, listener: (job: BacktestPreparationJobDto) => void): () => void;
    stop(): void;
  }
  ```

  실행 loop는 다음을 정확히 따른다.

  1. effective date와 필요한 KRX metric·가격 coverage를 채운다.
  2. `resolveOrDescribeNeeds()`를 호출한다.
  3. PER 후보 재무와 decline 후보 자본변동을 동기화하고 다시 resolve한다.
  4. READY schedule의 전체 최종 종목 합집합에 전략별 full facts·actions를 동기화한다.
  5. 동일 resolver를 한 번 더 호출해 preview JSON과 request hash를 저장한다.
  6. 예상 DART call이 오늘 남은 quota를 넘기면 KST 다음 자정의 epoch를 저장하고 WAITING으로 전환한다.
  7. source가 보고한 gap은 누적하되, 모든 rebalance entry가 0개면 FAILED로 끝낸다.

  job update와 event 발행은 같은 `persistAndEmit()` 메서드를 거친다.

- [ ] **Step 6: route·container를 연결하고 수동 자본변동 작업을 제거한다.**

  preview body는 `{ universeRule, period, strategyId, parameters }`로 통일한다. strategy version은 백테스트 제출과 마찬가지로 서버 registry에서 해석해 hash에 넣는다. 완료된 같은 hash가 있으면 resolver로 재확인 후 200을 반환하고, 아니면 start 후 202를 반환한다. 백테스트 제출 route는 동일 hash의 COMPLETED 준비 작업이 없으면 409 `PREPARATION_REQUIRED`를 반환하고, 있으면 그 schedule을 저장 요청에 pin한다.

  `main.ts` startup은 새 orchestrator의 `recoverOrphaned()`만 호출한다. `server.ts`에서 옛 corporate-action route 등록과 container 필드를 삭제한다.

- [ ] **Step 7: Task 6 검증과 커밋을 수행한다.**

  Run: `pnpm exec vitest run tests/unit/backtest-preparation-orchestrator.test.ts tests/integration/backtest-preparation.test.ts tests/integration/backtest-universe-preview.test.ts tests/integration/backtest-universe-rule-run.test.ts`

  Expected: PASS.

  Run: `pnpm typecheck`

  Expected: PASS.

  Commit: `git add -A src/server migrations tests && git commit -m "feat: 재무정보를 온디맨드로 준비한다"`

---

### Task 7: 엔진 리밸런스 신호와 유니버스 이탈 청산 구현

**Files:**

- Modify: `src/server/modules/strategy/domain/strategy.ts`
- Modify: `src/server/modules/backtest/domain/engine.ts`
- Modify: `src/server/modules/backtest/domain/types.ts`
- Modify: `src/workers/backtest-child.ts`
- Modify: `src/web/features/backtests/exit-reason.ts`
- Test: `tests/unit/backtest-engine-universe-schedule.test.ts`
- Test: `tests/unit/engine.test.ts`
- Test: `tests/integration/backtest-universe-rule-run.test.ts`

**Interfaces:**

- Consumes: Task 4의 pin된 `UniverseScheduleEntry.members`, 기존 `BacktestRunInput`, `TradingStrategy.onForcedExit()`.
- Produces: `StrategyBarContext.isRebalanceBar`, `selectionMetric(symbol)`, `BacktestRunInput.tradeFromTsMs`, `REBALANCE_EXIT`과 sell-before-buy 실행 보장.

- [ ] **Step 1: warm-up·리밸런스·청산 순서 RED 테스트를 작성한다.**

  다음 timeline을 하나의 엔진 fixture로 검증한다.

  ```text
  D-2, D-1: warm-up, history/state 갱신, order·equity snapshot 없음
  D0: isRebalanceBar=true, 보유 A가 유니버스에서 빠짐, REBALANCE_EXIT sell 예약
  D1 open: A sell 체결, deferred B buy는 아직 미체결, onForcedExit(A) 호출
  D2 open: B buy 체결
  ```

  전략 매도와 엔진 강제 매도가 같은 symbol에 겹치면 한 건만 남고, 유니버스가 바뀌지 않은 schedule entry에는 강제 매도가 없어야 한다.

  ```ts
  expect(result.equityCurve[0]?.tsMs).toBe(day0Ts);
  expect(seenContexts.filter((context) => context.isRebalanceBar).map((context) => context.tsMs)).toEqual([day0Ts]);
  expect(result.trades.find((trade) => trade.symbol === 'A')?.exitReason).toBe('REBALANCE_EXIT');
  expect(result.trades.find((trade) => trade.symbol === 'B')?.entryTsMs).toBe(day2Ts);
  expect(forcedExitSymbols).toEqual(['A']);
  ```

- [ ] **Step 2: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/backtest-engine-universe-schedule.test.ts tests/unit/engine.test.ts`

  Expected: `isRebalanceBar`, `tradeFromTsMs`, `REBALANCE_EXIT`가 없어 실패한다.

- [ ] **Step 3: context와 run input contract를 확장한다.**

  ```ts
  export interface StrategyBarContext {
    // 기존 필드 유지
    readonly isRebalanceBar: boolean;
    selectionMetric(symbol: string): {
      marketCapKrw: string | null;
      volume: number | null;
      tradingValueKrw: string | null;
    } | null;
  }
  export interface BacktestRunInput {
    // 기존 필드 유지
    readonly tradeFromTsMs?: number;
  }
  ```

  `isRebalanceBar`는 schedule entry가 처음 활성화되는 실제 거래 bar에서 한 번만 true다. 달력 기준일이 휴일이면 다음 이용 가능한 bar가 true다. schedule이 없으면 첫 거래 bar만 true로 두어 기존 단일 리밸런스 전략을 보존한다. `selectionMetric()`은 현재 활성 schedule member에 pin된 값만 반환하며 history KRX table을 다시 조회하지 않는다.

- [ ] **Step 4: engine의 실행 순서를 구현한다.**

  `tradeFromTsMs` 이전에는 corporate action, PIT cursor, history, strategy state를 갱신하지만 `orders`, `trades`, `equityCurve`, progress callback을 기록하지 않는다. 리밸런스 bar에서는 다음 순서를 사용한다.

  1. 새 schedule membership을 적용한다.
  2. 이탈 보유 symbol마다 `SELL/REBALANCE_EXIT`을 만든다.
  3. 전략 결정을 받는다.
  4. 중복 sell은 engine sell 하나로 합치고 buy는 `deferredRebalanceBuys`에 둔다.
  5. 다음 bar open에서 sell을 먼저 체결하고 `onForcedExit()`을 호출한다.
  6. 이탈 sell이 모두 체결된 뒤 deferred buy를 다음 체결 queue로 옮긴다.

  데이터 끝까지 이탈 sell이 체결되지 않으면 buy도 실행하지 않고 warning을 남긴다.

- [ ] **Step 5: worker warm-up load를 연결한다.**

  worker는 `strategy.dataRequirements.priceWarmupBars`와 universe decline 최대 lookback 중 큰 값만큼 `period.from` 이전 KRX 거래일을 조회한다. 최초 period bar timestamp를 `tradeFromTsMs`로 넘긴다. facts는 warm-up 시작 연도까지 읽되 실제 PIT `asOfTsMs` gate는 유지한다.

- [ ] **Step 6: exit reason 표시를 추가하고 검증한다.**

  `exit-reason.ts`에 `REBALANCE_EXIT: '리밸런스 유니버스 이탈'`을 추가한다.

  Run: `pnpm exec vitest run tests/unit/backtest-engine-universe-schedule.test.ts tests/unit/engine.test.ts tests/integration/backtest-universe-rule-run.test.ts`

  Expected: PASS.

  Run: `pnpm typecheck`

  Expected: PASS.

  Commit: `git add src/server/modules/backtest src/server/modules/strategy/domain src/workers src/web/features/backtests/exit-reason.ts tests && git commit -m "feat: 리밸런스 시점에 유니버스 이탈을 청산한다"`

---

### Task 8: 재무정보 기반 순위 전략 2개 추가

**Files:**

- Create: `src/server/modules/strategy/strategies/shared/fundamental-rank.ts`
- Create: `src/server/modules/strategy/strategies/earnings-acceleration-rank.ts`
- Create: `src/server/modules/strategy/strategies/low-per-high-roe-rank.ts`
- Modify: `src/server/modules/strategy/strategies/cross-sectional-momentum.ts`
- Modify: `src/server/modules/strategy/strategies/value-quality-rank.ts`
- Delete: `src/server/modules/strategy/strategies/shared/rebalance-schedule.ts`
- Modify: `src/server/modules/strategy/application/strategy-registry.ts`
- Create: `tests/unit/earnings-acceleration-rank.test.ts`
- Create: `tests/unit/low-per-high-roe-rank.test.ts`
- Modify: `tests/unit/cross-sectional-momentum.test.ts`
- Modify: `tests/unit/value-quality-rank.test.ts`
- Modify: `tests/unit/strategy-registry.test.ts`
- Modify: `tests/unit/strategy-shared.test.ts`

**Interfaces:**

- Consumes: Task 3의 offset PIT snapshot, Task 7의 `isRebalanceBar`·`selectionMetric()`·warm-up context, 기존 two-phase rebalance helper.
- Produces: strategy IDs `earnings-acceleration-rank`, `low-per-high-roe-rank`, `isFreshQuarter()`, `ordinalRank()`, `combineRanks()`, `scoreEarningsAcceleration()`, `scoreLowPerHighRoe()`, `rankLowPerHighRoe()`, 두 전략의 parameter schema와 `dataRequirements`.

- [ ] **Step 1: 이익 가속 전략의 RED 테스트를 작성한다.**

  parameter schema를 다음 값으로 고정한다.

  ```ts
  {
    topN: z.number().int().min(1).max(200).default(40),
    priceMomentumDays: z.number().int().min(60).max(252).default(126),
    staleQuarters: z.number().int().min(0).max(8).default(2),
  }
  ```

  포함 조건은 모두 AND다.

  - 현재 TTM 영업이익 q0~q3과 전년 TTM q4~q7이 모두 양수.
  - `(currentTtm / priorTtm) - 1 > 0`.
  - 최신 분기 YoY 성장률 `q0/q4-1`이 직전 분기 YoY `q1/q5-1`보다 큼. q4와 q5도 양수.
  - `priceMomentumDays` split-adjusted 수익률이 양수.
  - 재무 field period가 effective quarter보다 `staleQuarters`를 초과해 뒤처지면 제외.

  각 조건 하나만 깨뜨린 fixture와 rank tie fixture를 둔다.

  ```ts
  const decision = strategy.onBars(rebalanceContext, state, parameters);
  expect(decision.orders.map((order) => order.symbol)).toEqual(['FAST_GROWTH']);
  expect(scoreEarningsAcceleration({ ...baseCandidate, q0: -1 })).toBeNull();
  expect(scoreEarningsAcceleration({ ...baseCandidate, priceMomentum: 0 })).toBeNull();
  ```

- [ ] **Step 2: 저PER·고ROE 전략의 RED 테스트를 작성한다.**

  parameter schema는 `{ topN: 40, staleQuarters: 2 }`, 각 max는 200과 8로 한다. `PER = Number(context.selectionMetric(symbol).marketCapKrw) / PIT TTM NET_INCOME`, `ROE = PIT TTM NET_INCOME / latest TOTAL_EQUITY`를 검증한다. cap 문자열은 `0 < bigint <= Number.MAX_SAFE_INTEGER`일 때만 number로 바꾼다. 세 값은 양수여야 하고, 낮은 PER rank와 높은 ROE rank 합이 작은 순서로 고른다.

  ```ts
  expect(rankLowPerHighRoe([
    { symbol: 'A', marketCapKrw: '1000', netIncomeTtm: 100, totalEquity: 500 },
    { symbol: 'B', marketCapKrw: '2000', netIncomeTtm: 100, totalEquity: 400 },
  ])[0]?.symbol).toBe('A');
  expect(scoreLowPerHighRoe({ marketCapKrw: '1000', netIncomeTtm: -1, totalEquity: 500 })).toBeNull();
  ```

- [ ] **Step 3: 기존 순위 전략의 공통 리밸런스 RED 테스트를 추가한다.**

  `cross-sectional-momentum`과 `value-quality-rank`에서 `rebalanceMonths` parameter가 schema에 없고 `context.isRebalanceBar === false`면 주문을 내지 않는지 검증한다. 둘의 `topN` max를 200으로 올리고 default는 각각 기존값 10, 20을 보존한다.

  ```ts
  expect(strategy.parameterSchema.safeParse({ topN: 200, rebalanceMonths: 1 }).data).not.toHaveProperty('rebalanceMonths');
  expect(strategy.onBars({ ...context, isRebalanceBar: false }, state, parameters).orders).toEqual([]);
  ```

- [ ] **Step 4: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/earnings-acceleration-rank.test.ts tests/unit/low-per-high-roe-rank.test.ts tests/unit/cross-sectional-momentum.test.ts tests/unit/value-quality-rank.test.ts`

  Expected: 새 전략이 없고 기존 전략이 내부 월 스케줄을 써 실패한다.

- [ ] **Step 5: 공통 순위 helper와 이익 가속 전략을 구현한다.**

  `fundamental-rank.ts`는 다음 함수만 공유한다.

  ```ts
  export interface EarningsAccelerationInput {
    q0: number; q1: number; q2: number; q3: number;
    q4: number; q5: number; q6: number; q7: number;
    priceMomentum: number;
  }
  export interface LowPerHighRoeInput {
    marketCapKrw: string;
    netIncomeTtm: number;
    totalEquity: number;
  }
  export interface LowPerHighRoeCandidate extends LowPerHighRoeInput {
    symbol: string;
  }
  export function isFreshQuarter(periodKey: string | null, atTsMs: number, staleQuarters: number): boolean;
  export function ordinalRank<T>(rows: readonly T[], value: (row: T) => number, direction: 'ASC' | 'DESC', code: (row: T) => string): Map<T, number>;
  export function combineRanks<T>(rows: readonly T[], ranks: readonly ReadonlyMap<T, number>[], code: (row: T) => string): T[];
  export function scoreEarningsAcceleration(input: EarningsAccelerationInput): { ttmGrowth: number; priceMomentum: number } | null;
  export function scoreLowPerHighRoe(input: LowPerHighRoeInput): { per: number; roe: number } | null;
  export function rankLowPerHighRoe(rows: readonly LowPerHighRoeCandidate[]): LowPerHighRoeCandidate[];
  ```

  이익 가속은 성장률 rank 내림차순과 가격 momentum rank 내림차순의 ordinal 합을 쓴다. 최종 선택은 `context.tradableSymbols` 안에서 topN이고 equal-weight target을 기존 two-phase rebalance helper에 넘긴다. `dataRequirements`는 8분기, parameter별 price warm-up, corporate actions true다.

- [ ] **Step 6: 저PER·고ROE 전략과 기존 전략 migration을 구현한다.**

  저PER·고ROE는 PER rank 오름차순과 ROE rank 내림차순의 합을 쓴다. `dataRequirements`는 4분기, corporate actions true다. 두 신규 전략 ID·version을 정확히 다음으로 등록한다.

  ```ts
  {
    id: 'earnings-acceleration-rank',
    version: '1.0.0',
    name: '이익 가속·가격 확인 순위',
    requiresFundamentals: true,
    description: 'PIT 영업이익 가속과 양의 가격 모멘텀을 함께 순위화하는 동일가중 연구 전략',
  }
  {
    id: 'low-per-high-roe-rank',
    version: '1.0.0',
    name: '저PER·고ROE 순위',
    requiresFundamentals: true,
    description: 'PIT TTM 순이익 기준 저PER과 고ROE를 결합하는 동일가중 연구 전략',
  }
  ```

  기존 두 순위 전략은 version을 올리고 내부 월 key state와 `rebalance-schedule.ts` 의존을 제거한다. 리밸런스 판단은 오직 `context.isRebalanceBar`를 쓴다.

- [ ] **Step 7: Task 8 검증과 커밋을 수행한다.**

  Run: `pnpm exec vitest run tests/unit/earnings-acceleration-rank.test.ts tests/unit/low-per-high-roe-rank.test.ts tests/unit/cross-sectional-momentum.test.ts tests/unit/value-quality-rank.test.ts tests/unit/strategy-registry.test.ts tests/unit/strategy-shared.test.ts`

  Expected: PASS.

  Run: `pnpm typecheck`

  Expected: PASS.

  Commit: `git add -A src/server/modules/strategy tests/unit && git commit -m "feat: 재무정보 기반 순위 전략을 추가한다"`

---

### Task 9: 단계 편집 상태와 리밸런싱 주기 UI 구현

**Files:**

- Create: `src/web/features/backtests/universe-pipeline.ts`
- Create: `src/web/features/backtests/universe-stage-editor.tsx`
- Modify: `src/web/features/backtests/universe-rule-step.tsx`
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx`
- Modify: `src/web/features/backtests/prefill.ts`
- Modify: `src/web/features/backtests/types.ts`
- Create: `tests/unit/universe-pipeline.test.ts`
- Create: `tests/unit/universe-stage-editor-markup.test.tsx`
- Modify: `tests/unit/prefill.test.ts`

**Interfaces:**

- Consumes: Task 1의 `UniverseRule`·`rebalanceIntervalFitsPeriod()`, 기존 wizard step·prefill contract.
- Produces: `PipelineUpdate`, `addStage()`, `removeStage()`, `moveStage()`, `changeStageLimit()`, `UniverseStageEditor`, 신규 wizard 기본 rule과 maxPositions 40.

- [ ] **Step 1: 단계 상태 전이의 RED 테스트를 작성한다.**

  `universe-pipeline.test.ts`에 아래 예를 그대로 고정한다.

  ```ts
  expect(addStage([{ criterion: 'MARKET_CAP', limit: 100 }], 'PER')).toEqual({
    stages: [
      { criterion: 'MARKET_CAP', limit: 100 },
      { criterion: 'PER', limit: 100 },
    ],
    changedIndices: [],
  });

  expect(changeStageLimit([
    { criterion: 'MARKET_CAP', limit: 100 },
    { criterion: 'PER', limit: 80 },
    { criterion: 'VOLUME', limit: 60 },
  ], 0, 50)).toEqual({
    stages: [
      { criterion: 'MARKET_CAP', limit: 50 },
      { criterion: 'PER', limit: 50 },
      { criterion: 'VOLUME', limit: 50 },
    ],
    changedIndices: [1, 2],
  });
  ```

  이동 결과가 앞 단계보다 큰 limit을 만나면 `min(existing, previous)`를 뒤 단계까지 cascade하고, `changedIndices`를 함께 반환하는지 검증한다. 단계 기준 중복과 6번째 추가는 함수에서 거부한다.

- [ ] **Step 2: wizard 상태와 편집기 markup의 RED 테스트를 작성한다.**

  새 UI test dependency는 추가하지 않는다. 상태 변화는 `universe-pipeline.test.ts`의 순수 함수로 검증하고, `react-dom/server`의 `renderToStaticMarkup()`로 편집기의 label·button·input 제약을 검증한다. 다음 계약을 고정한다.

  1. 신규 진입 기본값은 KOSPI / 시가총액 200 / 1개월 / maxPositions 40.
  2. PER 단계를 추가하면 N은 200으로 복사되고 입력 max도 200이다.
  3. 첫 N을 100으로 낮추면 PER N도 100이 되고 state가 `changedIndices`를 반환한다.
  4. 급하락을 추가하면 lookback input 기본값 20이 보인다.
  5. 위/아래 이동 버튼의 접근 가능한 이름과 drag handle이 markup에 있다.
  6. 10일짜리 기간에 1개월 주기를 넣으면 preview 버튼이 비활성화되고 오류가 보인다.

  ```tsx
  const html = renderToStaticMarkup(
    <UniverseStageEditor stages={declineStages} onChange={() => undefined} />,
  );
  expect(html).toContain('aria-label="2단계 위로 이동"');
  expect(html).toContain('name="lookbackTradingDays"');
  expect(rebalanceIntervalFitsPeriod({ from: '2026-08-01', to: '2026-08-10' }, { value: 1, unit: 'MONTH' })).toBe(false);
  ```

- [ ] **Step 3: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/universe-pipeline.test.ts tests/unit/universe-stage-editor-markup.test.tsx tests/unit/prefill.test.ts`

  Expected: 새 상태 helper와 편집기가 없어 실패한다.

- [ ] **Step 4: 순수 상태 helper를 구현한다.**

  ```ts
  export interface PipelineUpdate {
    stages: UniverseStage[];
    changedIndices: number[];
  }
  export function addStage(stages: readonly UniverseStage[], criterion: UniverseCriterion): PipelineUpdate;
  export function removeStage(stages: readonly UniverseStage[], index: number): PipelineUpdate;
  export function moveStage(stages: readonly UniverseStage[], from: number, to: number): PipelineUpdate;
  export function changeStageLimit(stages: readonly UniverseStage[], index: number, limit: number): PipelineUpdate;
  ```

  새 단계 `limit`은 직전 단계 값을 그대로 복사한다. 사용자가 편집하는 입력의 HTML `max`도 직전 값이다. 첫 단계만 max 200이다. 삭제·이동 뒤에도 첫 원소부터 cascade한다.

- [ ] **Step 5: 접근 가능한 단계 편집기를 구현한다.**

  각 card에 순번, criterion Select, N Input, 삭제, 위/아래 버튼, drag handle을 둔다. native drag event는 `moveStage()`만 호출하며 버튼과 동일한 state path를 쓴다. 사용한 criterion은 다른 Select option에서 disabled다. `DECLINE` card만 `lookbackTradingDays` 1~252 입력을 보인다.

  cascade가 일어나면 변경된 입력에 2초 동안 강조 class를 주고 다음 문구를 노출한다.

  > 앞 단계 N을 넘지 않도록 뒤 단계 값을 함께 조정했습니다.

- [ ] **Step 6: 주기와 wizard 기본값을 연결한다.**

  `universe-rule-step.tsx`에 숫자 input과 DAY/WEEK/MONTH/YEAR Select를 둔다. unit 변경 시 현재 값을 새 unit max로 clamp하고 YEAR는 1로 고정한다. `rebalanceIntervalFitsPeriod()` 실패 시 서버 호출 전에 오류를 보인다.

  `new-backtest-wizard.tsx`의 초기값은 다음 한 곳에서 만든다.

  ```ts
  const DEFAULT_UNIVERSE_RULE: UniverseRule = {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', limit: 200 }],
    rebalanceInterval: { value: 1, unit: 'MONTH' },
  };
  const DEFAULT_MAX_POSITIONS = '40';
  ```

  전략 parameter에서 `rebalanceMonths`를 추출하는 코드와 props를 모두 제거한다. prefill은 새 rule을 그대로 복구하고 old stored request는 서버 clone 응답에서 이미 승격된 값을 받는다.

- [ ] **Step 7: Task 9 검증과 커밋을 수행한다.**

  Run: `pnpm exec vitest run tests/unit/universe-pipeline.test.ts tests/unit/universe-stage-editor-markup.test.tsx tests/unit/prefill.test.ts`

  Expected: PASS.

  Run: `pnpm typecheck`

  Expected: PASS.

  Commit: `git add src/web/features/backtests src/shared/schemas tests/unit && git commit -m "feat: 단계형 유니버스 편집기를 추가한다"`

---

### Task 10: 준비 진행률과 미리보기 완료 흐름을 웹에 연결

**Files:**

- Modify: `src/web/features/backtests/api.ts`
- Create: `src/web/features/backtests/preparation-live.ts`
- Create: `src/web/features/backtests/preparation-progress.tsx`
- Modify: `src/web/features/backtests/universe-rule-step.tsx`
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx`
- Delete: `src/web/features/backtests/corporate-action-gate.tsx`
- Delete: `src/web/features/backtests/corporate-action-gate-logic.ts`
- Modify: `src/web/lib/api-client.ts`
- Create: `tests/unit/preparation-live.test.ts`
- Create: `tests/unit/preparation-progress.test.tsx`
- Delete: `tests/unit/corporate-action-gate.test.ts`

**Interfaces:**

- Consumes: Task 6의 `BacktestPreparationJobDto`와 HTTP/SSE routes, Task 9의 현재 rule/hash state.
- Produces: 웹 `BacktestPreparationJob`, `PreparationLiveResult`, `usePreparationLive()`, `pollInterval()`, `shouldCloseStream()`, `formatPreparationResumeTime()`, `PreparationProgress`, `UniversePreviewStartResponse`.

- [ ] **Step 1: SSE/polling 정책과 화면 상태의 RED 테스트를 작성한다.**

  새 React test dependency 없이 `preparation-live.ts`의 순수 정책 함수와 `react-dom/server` markup을 테스트한다. `pollInterval(status, sseFailed)`는 non-terminal + SSE 실패에서만 2초를 반환하고, `shouldCloseStream(status)`는 terminal에서 true다. 실제 EventSource 연결·cleanup은 Task 12 Playwright에서 browser boundary로 검증한다. 화면 테스트는 상태별 문구를 고정한다.

  | status | 문구와 동작 |
  |---|---|
  | QUEUED | `데이터 준비 대기 중` |
  | RUNNING | phase label, done/total, 취소 버튼 |
  | WAITING_DAILY_QUOTA | 다음 KST 재개 시각, 취소 버튼 |
  | COMPLETED | preview 자동 표시, 다음 단계 활성화 |
  | FAILED | error와 재시도 버튼 |
  | CANCELLED | 취소됨과 다시 준비 버튼 |

  ```ts
  expect(pollInterval('RUNNING', true)).toBe(2_000);
  expect(pollInterval('RUNNING', false)).toBe(false);
  expect(shouldCloseStream('COMPLETED')).toBe(true);
  const html = renderToStaticMarkup(<PreparationProgress job={waitingJob} onCancel={() => undefined} />);
  expect(html).toContain('일일 호출 한도');
  expect(html).toContain(formatPreparationResumeTime(waitingJob.nextResumeAtMs));
  ```

- [ ] **Step 2: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/preparation-live.test.ts tests/unit/preparation-progress.test.tsx`

  Expected: 준비 job DTO와 progress component가 없어 실패한다.

- [ ] **Step 3: 웹 API contract와 live hook를 구현한다.**

  ```ts
  export type PreparationStatus =
    | 'QUEUED' | 'RUNNING' | 'WAITING_DAILY_QUOTA'
    | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  export type PreparationPhase =
    | 'MARKET_DATA' | 'RESOLVING_STAGES' | 'SYNCING_FACTS' | 'FINALIZING';
  export interface BacktestPreparationJob {
    id: string;
    requestHash: string;
    status: PreparationStatus;
    phase: PreparationPhase;
    doneSymbols: number;
    totalSymbols: number;
    savedFacts: number;
    gapCount: number;
    nextResumeAtMs: number | null;
    error: string | null;
  }
  export interface PreparationLiveResult {
    job: BacktestPreparationJob | null;
    isLoading: boolean;
    error: Error | null;
    sseFailed: boolean;
  }
  export function usePreparationLive(jobId: string | null): PreparationLiveResult;
  export function pollInterval(status: PreparationStatus | null, sseFailed: boolean): false | 2_000;
  export function shouldCloseStream(status: PreparationStatus): boolean;
  export function formatPreparationResumeTime(tsMs: number | null): string;
  ```

  `api.ts`의 hook는 기존 `useBacktestLive()`와 같은 EventSource cleanup 규칙을 쓴다. terminal event에서 `['universe-preview', requestHash]`를 invalidate한다.

- [ ] **Step 4: preview mutation과 progress UI를 연결한다.**

  preview 응답을 discriminated union으로 다룬다.

  ```ts
  type UniversePreviewStartResponse =
    | { kind: 'READY'; preview: UniversePreviewResponseDto }
    | { kind: 'PREPARING'; job: BacktestPreparationJob };
  ```

  요청 parameter가 바뀌면 현재 preview를 stale 처리하지만 실행 중 job을 암묵적으로 취소하지 않는다. 새 hash로 다시 미리보기를 누르면 새 job 또는 queue를 받는다. COMPLETED job의 preview가 현재 입력 hash와 같을 때만 화면에 자동 적용한다.

- [ ] **Step 5: 수동 corporate-action gate를 제거한다.**

  `ApiError.details.corporateActionGate` parsing, modal, progress UI, 관련 import를 모두 지운다. 일반 구조화 오류를 담는 `ApiError.details` 자체는 유지한다. 제출 409 `PREPARATION_REQUIRED`는 현재 입력을 preview 단계로 돌리고 새 준비 요청을 시작하게 한다.

- [ ] **Step 6: Task 10 검증과 커밋을 수행한다.**

  Run: `pnpm exec vitest run tests/unit/preparation-live.test.ts tests/unit/preparation-progress.test.tsx tests/unit/api-client.test.ts`

  Expected: PASS.

  Run: `pnpm typecheck`

  Expected: PASS.

  Commit: `git add -A src/web tests/unit && git commit -m "feat: 백테스트 데이터 준비 진행률을 표시한다"`

---

### Task 11: provenance·요약·CLI와 레거시 문구 정리

**Files:**

- Modify: `src/shared/schemas/provenance-pin.ts`
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts`
- Modify: `src/web/features/backtests/universe-summary.ts`
- Modify: `src/web/features/backtests/universe-provenance.ts`
- Modify: `src/web/features/backtests/backtest-detail-page.tsx`
- Modify: `src/server/cli.ts`
- Modify: `README.md`
- Modify: `infra/app.env.example`
- Modify: `docs/ONBOARDING.md`
- Modify: `docs/SPEC.md`
- Modify: `docs/IMPLEMENTATION_STATUS.md`
- Modify: `docs/DECISIONS.md`
- Modify: `tests/unit/universe-provenance-label.test.ts`
- Create: `tests/unit/universe-summary.test.ts`
- Create: `tests/unit/cli.test.ts`

**Interfaces:**

- Consumes: Task 4의 schedule diagnostics, Task 6의 prepared hash/time, Task 1의 `UniverseRule`.
- Produces: 새 `ProvenancePin` branch `ORDERED_UNIVERSE_PIPELINE`, 단계·주기 요약 문구, facts CLI가 없는 command surface와 갱신된 운영 문서.

- [ ] **Step 1: 새 요약과 CLI 제거의 RED 테스트를 작성한다.**

  요약 테스트는 다음 출력을 고정한다.

  ```ts
  expect(formatUniverseRuleSummary(rule)).toBe(
    'KOSPI · 시가총액 200 → PER 80 → 급하락(20일) 40 · 매월',
  );
  ```

  provenance의 `selectionMethod`는 단일 문자열 대신 단계 snapshot을 포함하도록 한다. 완료 결과 상세에는 실제 각 rebalance entry의 단계 진단과 effective date가 보존되는지 검증한다. CLI 테스트는 `facts:sync`가 사용법에 없고 해당 command가 exit code 1과 `지원하지 않는 명령`을 내는지 검증한다.

  ```ts
  expect(formatUniverseRuleSummary(rule)).toBe('KOSPI · 시가총액 200 → PER 80 → 급하락(20일) 40 · 매월');
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/cli.ts', 'facts:sync'], { encoding: 'utf8' });
  expect(cli.status).toBe(1);
  expect(`${cli.stdout}${cli.stderr}`).toContain('지원하지 않는 명령');
  expect(`${cli.stdout}${cli.stderr}`).not.toContain('--symbols');
  ```

- [ ] **Step 2: RED를 확인한다.**

  Run: `pnpm exec vitest run tests/unit/universe-provenance-label.test.ts tests/unit/universe-summary.test.ts tests/unit/cli.test.ts`

  Expected: 단일 `TOP_MARKET_CAP_N`과 `facts:sync`가 남아 실패한다.

- [ ] **Step 3: 실행 provenance를 단계 snapshot으로 교체한다.**

  `ProvenancePin`에 다음 필드를 사용한다.

  ```ts
  selectionMethod: 'ORDERED_UNIVERSE_PIPELINE';
  universeRule: UniverseRule;
  scheduleHash: string;
  diagnostics: readonly RebalanceDiagnostic[];
  preparedAtMs: number;
  ```

  기존 완료 run을 읽을 때 `TOP_MARKET_CAP_N`은 그대로 표시할 수 있게 union에 남긴다. 새 run만 새 값으로 쓴다. UI label은 `순서형 유니버스 파이프라인`으로 표시한다.

- [ ] **Step 4: CLI에서 facts sync 전용 코드만 제거한다.**

  `src/server/cli.ts`에서 `FactIngestionGap` import, `reasonBucket`, `parseFactsSyncArgs`, `factsSync`, switch case, usage line을 삭제한다. `db:prepare`, `admin:create`, `totp:enroll`, `krx:backfill-non-trading`은 유지한다. `FactSyncService`는 준비 orchestrator가 계속 재사용하므로 삭제하지 않는다.

- [ ] **Step 5: 운영 문서를 온디맨드 방식으로 갱신한다.**

  `README.md`, `infra/app.env.example`, `docs/ONBOARDING.md`, `docs/SPEC.md`, `docs/IMPLEMENTATION_STATUS.md`에서 수동 `facts:sync` 절차를 지우고 다음을 적는다. `docs/DECISIONS.md`에는 과거 결정을 고치지 말고 새 결정 항목으로 CLI 전용 정책을 대체한 날짜와 이유를 남긴다.

  - DART API key는 재무전략 또는 PER stage의 preview 준비 시 필요하다.
  - 요청 기간과 최소 warm-up만 자동 수집한다.
  - 일일 quota 대기는 실패가 아니며 다음 KST 날짜에 자동 재개한다.
  - 준비 작업은 한 번에 하나고 서버 재시작 뒤 이어진다.
  - 준비 취소는 이미 저장한 symbol 데이터를 지우지 않는다.

- [ ] **Step 6: Task 11 검증과 커밋을 수행한다.**

  Run: `pnpm exec vitest run tests/unit/universe-provenance-label.test.ts tests/unit/universe-summary.test.ts tests/unit/cli.test.ts`

  Expected: PASS.

  Run: `rg -n "facts:sync|corporateActionGate|TOP_MARKET_CAP_N|rebalanceMonths|sortKey.*MKTCAP" src README.md docs infra/app.env.example`

  Expected: 레거시 parsing test·migration 설명을 제외한 실행 코드와 사용자 문구에서 결과가 없다.

  Commit: `git add -A src README.md .env.example docs tests/unit && git commit -m "refactor: 수동 재무 동기화 경로를 제거한다"`

---

### Task 12: 전체 통합·E2E·회귀 검증

**Files:**

- Modify: `tests/integration/backtest-facts.test.ts`
- Modify: `tests/integration/backtest-facts-worker.test.ts`
- Modify: `tests/integration/backtest-universe-preview.test.ts`
- Modify: `tests/integration/backtest-universe-rule-run.test.ts`
- Modify: `tests/integration/job-queue.test.ts`
- Modify: `tests/e2e/mvp-flow.spec.ts`
- Create: `tests/e2e/universe-pipeline.spec.ts`

**Interfaces:**

- Consumes: Task 1~11의 shared contract, KRX/DART fake source ports, 준비 API, worker, wizard UI.
- Produces: 전체 preview→prepare→submit→run 회귀 fixture와 Playwright 사용자 흐름. 새 production API는 만들지 않는다.

- [ ] **Step 1: end-to-end server fixture를 먼저 실패하게 추가한다.**

  fake KRX와 fake DART source로 다음 시나리오를 한 integration test에서 실행한다.

  1. KOSPI `MARKET_CAP 5 → PER 3 → DECLINE(20) 2`, 매주 rule로 preview 요청.
  2. 202 job을 polling해 COMPLETED까지 진행.
  3. 각 phase에서 필요한 symbol만 source 호출됐는지 확인.
  4. preview의 단계별 N, missing 제외 수, effective date 확인.
  5. 같은 body 재요청은 source 추가 호출 없이 200 READY.
  6. 백테스트 제출·worker 실행 후 schedule hash와 provenance 확인.
  7. 첫 리밸런스 뒤 멤버십 이탈 trade가 `REBALANCE_EXIT`인지 확인.

  ```ts
  const start = await app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview', payload });
  expect(start.statusCode).toBe(202);
  const completed = await waitForPreparation(app, start.json().job.id);
  expect(completed.status).toBe('COMPLETED');
  expect(fakeDart.requestedSymbols()).toEqual(expectedPerCandidatesAndFinalMembers);
  const ready = await app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview', payload });
  expect(ready.statusCode).toBe(200);
  expect(fakeDart.callCount()).toBe(callsAfterFirstPreparation);
  ```

- [ ] **Step 2: 두 전략 회귀 fixture를 추가한다.**

  각 신규 전략에 최소 3개 종목·8개 분기·충분한 가격 warm-up fixture를 제공한다. 가장 높은 composite rank 종목이 다음 bar open에 매수되고, 미래 공시의 `asOfTsMs`를 하루 늦추면 결과가 달라지지 않으며, 해당 시각을 지난 리밸런스에서만 달라지는지 검증한다.

  ```ts
  const beforeDisclosure = await runFinancialStrategy({ disclosureTsMs: secondRebalanceTs + DAY_MS });
  expect(beforeDisclosure.trades.map((trade) => trade.symbol)).not.toContain('FUTURE_WINNER');
  const afterDisclosure = await runFinancialStrategy({ disclosureTsMs: secondRebalanceTs - 1 });
  expect(afterDisclosure.trades.map((trade) => trade.symbol)).toContain('FUTURE_WINNER');
  ```

- [ ] **Step 3: E2E 사용자 흐름을 추가한다.**

  `universe-pipeline.spec.ts`는 다음만 browser boundary에서 확인하고 수치 계산은 단위 테스트에 맡긴다.

  - 시가총액 단계 뒤 PER와 급하락 추가.
  - N 기본 복사와 cascade 안내.
  - drag 또는 위/아래 버튼으로 순서 변경.
  - 리밸런싱 주기 기간 초과 차단.
  - 준비 진행률 → 완료 preview → 백테스트 제출.
  - 신규 전략 두 개가 목록에 있고 기본 topN/maxPositions가 40.

  ```ts
  await page.getByRole('button', { name: '정렬 단계 추가' }).click();
  await page.getByRole('option', { name: 'PER' }).click();
  await expect(page.getByLabel('2단계 상위 N')).toHaveValue('200');
  await page.getByRole('button', { name: '데이터 준비 및 미리보기' }).click();
  await expect(page.getByText('유니버스 미리보기')).toBeVisible();
  await page.getByRole('button', { name: '백테스트 실행' }).click();
  ```

- [ ] **Step 4: targeted integration을 실행하고 실패를 수정한다.**

  Run: `pnpm exec vitest run tests/integration/backtest-facts.test.ts tests/integration/backtest-facts-worker.test.ts tests/integration/backtest-universe-preview.test.ts tests/integration/backtest-universe-rule-run.test.ts tests/integration/job-queue.test.ts`

  Expected: PASS.

- [ ] **Step 5: 정적 검증과 전체 unit/integration을 실행한다.**

  Run: `pnpm lint`

  Expected: PASS with no warnings introduced by this feature.

  Run: `pnpm typecheck`

  Expected: PASS.

  Run: `pnpm test`

  Expected: PASS.

  Run: `pnpm build`

  Expected: PASS.

- [ ] **Step 6: E2E를 실행한다.**

  Run: `pnpm exec playwright test tests/e2e/mvp-flow.spec.ts tests/e2e/universe-pipeline.spec.ts`

  Expected: PASS.

- [ ] **Step 7: 데이터 계약 잔재를 검색한다.**

  Run: `rg -n "max\(20\)|setMaxPositions\('20'\)|rebalanceMonths|corporateActionSync|corporateActionGate|facts:sync|sortKey:\s*'MKTCAP'" src tests README.md docs infra/app.env.example`

  Expected: 의도적으로 남긴 레거시 clone fixture·migration 설명 외에는 결과가 없다.

  Run: `git status --short`

  Expected: 이 task에서 검증하며 수정한 파일만 표시된다.

- [ ] **Step 8: 최종 구현 커밋을 만든다.**

  Commit: `git add -A && git commit -m "test: 재무전략과 유니버스 준비 흐름을 검증한다"`

---

## Final Review Checklist

- [ ] 모든 criterion의 방향, tie-break, missing 제외가 같은 순수 함수와 테스트에 있다.
- [ ] 모든 단계 추가·수정·이동 뒤 `limit[i] <= limit[i-1]`가 유지된다.
- [ ] 서버와 웹 모두 주기 최대 1년 및 전체 기간 이하를 검증한다.
- [ ] PER·ROE·이익 성장률이 effective date 시점 PIT 자료만 사용한다.
- [ ] 가격 momentum과 decline이 split-adjusted warm-up을 쓰고 주문 기간과 분리된다.
- [ ] preview와 실행이 같은 resolver·schedule hash를 사용한다.
- [ ] 준비 작업이 single-flight, 부분 저장, quota 대기, 재시작 회수, 취소를 모두 검증한다.
- [ ] 유니버스 이탈 sell이 새 buy보다 먼저 체결되고 exit reason이 보존된다.
- [ ] 신규 요청만 포지션 기본값 40이고 기존 저장 값은 바뀌지 않는다.
- [ ] CLI와 수동 corporate-action UI/API가 제거됐지만 `FactSyncService`는 자동 준비에서 재사용된다.
- [ ] 신규 전략은 향후 수익 보장 문구 없이 연구 후보로만 소개된다.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, 관련 Playwright가 모두 통과한다.
