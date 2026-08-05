# 종목 마스터 백테스트 통합·구개념 제거 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스트가 유니버스 규칙(시총 상위 N)으로 시점별 유니버스를 재구성하게 하고, 데이터셋·스냅샷 개념을 제거한다.

**Architecture:** 제출 시점에 서버가 멤버십 일정(리밸런스 날짜 → 종목 목록)을 확정해 잡에 pin 한다. 워커는 일정의 합집합 종목으로 캔들을 로드하고, 엔진은 리밸런스 시점마다 거래 대상을 일정으로 제한한다.

**Tech Stack:** 기존 백테스트 파이프라인(JobQueue→JobOrchestrator→backtest-child→engine), zod, drizzle.

**선행:** core·ui 계획 완료. 참조 스펙: `2026-08-05-symbol-master-design.md` §백테스트 통합·§마이그레이션.

## Global Constraints

- 한국어 주석·문서는 CLAUDE.md 규칙을 따른다.
- `pnpm test && pnpm lint && pnpm typecheck` 커밋 전 통과.
- 기존 워커 제약 유지: 유니버스는 단일 시장(멀티 시장 봉 캘린더 미지원, backtest-child:115). `universeRule.markets` 는 당분간 원소 1개만 허용한다.
- 기존 백테스트 잡·런 데이터는 보존하지 않는다(사용자 승인 — 개발 단계 데이터).
- `universe.symbols` 는 로컬 심볼 단축코드다 — 마스터의 `shortCode` 로 매핑한다.

---

### Task 1: 유니버스 규칙 resolver

**Files:**
- Create: `src/server/modules/backtest/application/universe-rule-resolver.ts`
- Create: `src/shared/schemas/universe-rule.ts`
- Test: `tests/unit/universe-rule-resolver.test.ts`

**Interfaces:**
- Consumes: `SymbolMasterService.getUniverseAsOf/getMarketCapsAt/isCovered/coverageRanges` (core 계획)
- Produces:

```typescript
// src/shared/schemas/universe-rule.ts
export const universeRuleSchema = z.object({
  markets: z.array(z.enum(['KOSPI', 'KOSDAQ'])).length(1), // 워커 단일 시장 제약
  topN: z.number().int().min(1).max(MAX_UNIVERSE_SYMBOLS),
  sortKey: z.literal('MKTCAP'),
});
export type UniverseRule = z.infer<typeof universeRuleSchema>;

// universe-rule-resolver.ts
export interface UniverseScheduleEntry {
  readonly rebalanceDate: string;          // ISO
  readonly symbols: readonly string[];     // shortCode, 시총 내림차순 상위 N
}
export interface ResolvedUniverse {
  readonly schedule: readonly UniverseScheduleEntry[];
  readonly unionSymbols: readonly string[];
  readonly scheduleHash: string;           // sha256(JSON 정렬 직렬화)
  readonly uncoveredDates: readonly string[];  // 마스터 미커버 리밸런스 날짜
}
export class UniverseRuleResolver {
  constructor(deps: { symbolMaster: SymbolMasterService; logger: Logger });
  /** rebalanceDates 는 호출자가 전략 파라미터(rebalanceMonths)로 계산해 넘긴다 */
  async resolve(rule: UniverseRule, rebalanceDates: readonly string[]): Promise<ResolvedUniverse>;
}
/** period.from 부터 N개월 간격의 각 달 첫 영업일 후보(1~3일 시도) 목록 */
export function computeRebalanceDates(
  period: { from: string; to: string }, rebalanceMonths: number,
): string[];
```

resolve 동작 규약(날짜별):
1. `isCovered(date)` false → `uncoveredDates` 에 넣고 건너뜀 (KRX 자동 수집 없음 — 제출 검증이 거부하고 UI 가 동기화 버튼을 보여준다).
2. `getUniverseAsOf(date)` → `instrumentType === 'COMMON_STOCK'` + `market ∈ rule.markets` 필터.
3. `getMarketCapsAt(date)` (레이지 캐시 — 여기서만 KRX 호출 발생 가능) 로 시총 join, 시총 없는 종목 제외.
4. 시총 내림차순 상위 `topN` 의 `shortCode` 목록.

- [ ] **Step 1: 실패하는 테스트 작성** — fake KRX + 마스터 사전 ingest 로 3케이스: 상위 N 선정·정렬, 미커버 날짜 분리, `computeRebalanceDates` 간격 계산. 전체 코드로 작성.
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: PASS**
- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/backtest/application/universe-rule-resolver.ts src/shared/schemas/universe-rule.ts tests/unit/universe-rule-resolver.test.ts
git commit -m "feat(backtest): 유니버스 규칙 resolver 를 추가한다"
```

---

### Task 2: 요청 스키마 교체 + 유니버스 미리보기 API

**Files:**
- Modify: `src/shared/schemas/backtest-request.ts`
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts` (미리보기 라우트 추가)
- Test: `tests/unit/backtest-request-schema.test.ts`, `tests/integration/backtest-universe-preview.test.ts`

**Interfaces:**
- Produces (스키마 — `datasetId`/`universeSnapshotId`/`universe` 제거):

```typescript
export const backtestRequestSchema = z.object({
  strategyId: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  universeRule: universeRuleSchema,
  timeframe: z.enum(['1m', '1h', '1d']).optional(),
  period: z.object({ from: ..., to: ... }),        // 기존 그대로
  capital: ..., execution: ..., risk: ..., randomSeed: ...,  // 기존 그대로
});
```

  xor refine 삭제. 주석의 D-029 단락은 유지하고 datasetId 단락을 교체 사유(스펙 2026-08-05)로 갱신한다.

- Produces (라우트): `POST /backtests/universe-preview` body `{universeRule, period, rebalanceMonths}` → `{schedule, unionSymbols, scheduleHash, uncoveredDates, missingCandleSymbols}` — `missingCandleSymbols` 는 unionSymbols 중 `symbols` 테이블에 없거나 요청 timeframe 캔들이 없는 것.

- [ ] **Step 1: 실패하는 테스트 작성** — 스키마: universeRule 필수·markets 2개 거부·구 필드 무시 파싱. 미리보기: 정상 응답 형태, uncovered 포함 응답. 전체 코드.
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** (resolver 를 `BacktestRouteDeps` 에 추가, container 배선 포함) → **Step 4: PASS** — 이 시점에 기존 제출 경로·워커·위저드가 컴파일 오류로 깨진다: Task 3~5 가 잇는다. 커밋은 Task 3 완료 후 함께 한다(중간 상태 커밋 금지).

---

### Task 3: 잡 파이프라인 — 일정 pin

**Files:**
- Modify: `src/server/shared/db/schema.ts` — `backtestJobs`: `datasetId`·`universeSnapshotId` 삭제, `universeRuleJson text notNull`·`universeScheduleJson text notNull` 추가. `backtestRuns`: `datasetId` 삭제, `universeRuleJson text notNull`·`scheduleHash text notNull` 추가.
- Create: `migrations/0005_*.sql` — drizzle-kit generate 후 파일 선두에 `DELETE FROM backtest_*` 데이터 정리 구문 수동 추가.
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts` — `validateSubmission`: dataset/snapshot 분기 삭제. 새 검증: ① `resolver.resolve` 호출, `uncoveredDates.length > 0` → 422 + 목록 반환 ② unionSymbols 캔들 존재 검증(기존 dataset 분기의 심볼 검증 로직 재사용) ③ 기존 universeJson pin 메커니즘은 unionSymbols 로 동작 ④ provenancePin 은 `{sourceKind: 'SYMBOL_MASTER', scheduleHash, filterPolicyVersion, ...}` 로 교체(`provenance-pin.ts` 스키마 수정).
- Modify: `src/server/modules/backtest/application/job-queue.ts` — enqueue 에 rule·schedule 전달.
- Modify: `src/workers/backtest-child.ts` — `request.universe.symbols` 참조 전부를 `schedule 합집합` 으로 교체(`job.universeScheduleJson` 파싱). 단일 시장 검증은 유지. `backtestRuns` insert 에 새 컬럼 기록.
- Modify: `src/shared/schemas/provenance-pin.ts`
- Test: `tests/integration/backtest-submit.test.ts` (기존 제출 통합 테스트 수정)

**Interfaces:**
- Consumes: Task 1 `ResolvedUniverse`, Task 2 스키마
- Produces: `backtestJobs.universeScheduleJson` = `UniverseScheduleEntry[]` JSON — 워커·엔진의 유일한 유니버스 소스.

- [ ] **Step 1: 기존 제출·워커 테스트를 새 계약으로 수정(실패 상태)** — dataset 픽스처를 universeRule 픽스처로. uncovered 422 케이스 추가.
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: PASS** (`pnpm test` 전체 — 워커 경로 회귀 확인)
- [ ] **Step 5: 커밋** (Task 2 변경 포함)

```bash
git add src/shared/schemas src/server migrations src/workers tests
git commit -m "feat(backtest): 유니버스 규칙 제출과 멤버십 일정 pin 으로 교체한다"
```

---

### Task 4: 엔진 — 멤버십 일정 소비

**Files:**
- Modify: `src/server/modules/backtest/domain/engine.ts` — `BacktestRunInput.universeSchedule?: readonly { fromTsMs: number; symbols: readonly string[] }[]` 추가(정렬 후 현재 ts 이하 마지막 entry 가 활성). `ENGINE_VERSION` 을 `1.3.0` 으로 올린다(§9.5).
- Modify: `src/server/modules/strategy/domain/strategy.ts` — `StrategyBarContext.tradableSymbols: ReadonlySet<string> | null` 추가 (null = 제한 없음).
- Modify: `src/server/modules/strategy/strategies/shared/two-phase-rebalance.ts` — 매수 후보를 `tradableSymbols` 로 필터. 보유 중이나 유니버스에서 빠진 종목은 기존 REBALANCE_EXIT 경로가 자연 청산한다(타깃 미포함).
- Modify: `src/workers/backtest-child.ts` — schedule 의 rebalanceDate 를 `periodToTsRange` 와 같은 KST 자정 규칙으로 ms 변환해 `universeSchedule` 로 전달.
- Test: `tests/unit/backtest-engine-universe-schedule.test.ts`

**Interfaces:**
- Produces: 엔진 리스크 검증(6단계)이 활성 유니버스 밖 BUY 의도를 거부하고 warning 을 남긴다 — 전략 버그 안전망.

- [ ] **Step 1: 실패하는 테스트 작성** — 합성 봉 2종목·일정 2구간으로: ① 1구간에서 A 만 매수 가능 ② 2구간 전환 후 B 매수·A 청산 ③ 일정 밖 BUY 의도 거부 warning. 기존 엔진 테스트 픽스처 헬퍼 재사용, 전체 코드.
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: PASS** (`pnpm test` 전체 — 일정 미지정 시 기존 전략 테스트 무변화 확인)
- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/backtest/domain/engine.ts src/server/modules/strategy src/workers/backtest-child.ts tests/unit/backtest-engine-universe-schedule.test.ts
git commit -m "feat(engine): 멤버십 일정으로 거래 대상을 제한한다"
```

---

### Task 5: 위저드 개편

**Files:**
- Create: `src/web/features/backtests/universe-rule-step.tsx`
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx` — `universeMode` 상태·DATASET/KRX_SNAPSHOT 탭 삭제, step 1 을 `<UniverseRuleStep>` 으로. `buildRequest()` 가 `universeRule` 을 담는다.
- Modify: `src/web/features/backtests/wizard-steps.ts` — '데이터·종목' → '유니버스'.
- Modify: `src/web/features/backtests/types.ts` — `BacktestRequestBody` 갱신.
- Delete: `src/web/features/backtests/krx-snapshot-step.tsx`

**Interfaces:**
- Consumes: `POST /backtests/universe-preview`, `GET /symbol-master/coverage`, `POST /symbol-master/sync`
- Produces: `<UniverseRuleStep value={UniverseRule} onChange onValidityChange />`

UI 규약: 시장 Select(KOSPI|KOSDAQ), 상위 N Input(기본 200), [미리보기] 버튼 → 일정 표(리밸런스 날짜·종목 수), `uncoveredDates` 있으면 경고 + 날짜별 [동기화] 버튼(POST /symbol-master/sync 후 재미리보기), `missingCandleSymbols` 있으면 목록 경고(가격 데이터 탭 안내 링크). 미리보기 성공 & 경고 0 이어야 다음 단계 활성.

- [ ] **Step 1: 구현** → **Step 2: `pnpm typecheck && pnpm lint` PASS + `pnpm dev` 수동 확인** → **Step 3: 커밋**

```bash
git add src/web/features/backtests
git commit -m "feat(backtests): 위저드 2단계를 유니버스 규칙으로 교체한다"
```

---

### Task 6: 데이터셋·스냅샷 코드 제거

**Files:**
- Split: `src/server/modules/market-data/presentation/dataset-routes.ts` — 종목(가격 데이터) 라우트를 `symbol-routes.ts` 로 옮기고 데이터셋 라우트를 삭제한다. `registerSymbolRoutes(app, {symbolService, brokerSyncService, symbolInfoService, symbolMetricsService, factsSyncEstimator, ...}, requireAuth)` — 기존 시그니처에서 datasetService·hasActiveBacktests 만 뺀다.
- Delete: `src/server/modules/market-data/application/dataset-service.ts`, `application/universe-snapshot-service.ts`, `presentation/universe-routes.ts`
- Delete: `src/web/features/datasets/datasets-panel.tsx`, `src/web/lib/use-historical-universe.ts` (다른 소비처 없음 확인 후)
- Modify: `src/server/bootstrap/container.ts`·`server.ts` — 배선 제거, `src/web` 의 dataset API 참조 제거
- Delete/Modify: 관련 단위·통합 테스트 삭제, `combineMarketSnapshots`·`historical-universe.ts` 는 다른 소비처가 없으면 함께 삭제
- Test: 기존 스위트 전체

- [ ] **Step 1: 참조 역추적** — `grep -rn "DatasetService\|UniverseSnapshotService\|datasets\b\|universeSnapshot" src tests` 로 소비처 목록화. SymbolsPanel 이 쓰는 심볼 엔드포인트 경로는 절대 바꾸지 않는다(프론트 무수정 원칙).
- [ ] **Step 2: 제거·분리 수행** → **Step 3: `pnpm test && pnpm lint && pnpm typecheck` PASS** → **Step 4: 커밋**

```bash
git add -A
git commit -m "refactor(market-data): 데이터셋·스냅샷 개념을 제거한다"
```

---

### Task 7: 테이블 drop 마이그레이션

**Files:**
- Modify: `src/server/shared/db/schema.ts` — `datasets`·`datasetSymbols`·`universeSnapshots`·`universeSnapshotSymbols` 정의 삭제
- Create: `migrations/0006_*.sql` — drizzle-kit generate (DROP TABLE 4개)
- Test: `tests/unit/symbol-master-schema.test.ts` 실행으로 마이그레이션 적용 확인

- [ ] **Step 1: 스키마 삭제 → generate → 전체 테스트 PASS** → **Step 2: 커밋**

```bash
git add src/server/shared/db/schema.ts migrations
git commit -m "feat(db): 데이터셋·스냅샷 테이블을 제거한다"
```

---

### Task 8: e2e 재작성

**Files:**
- Delete: `tests/e2e/krx-universe.spec.ts`
- Create: `tests/e2e/symbol-master.spec.ts`
- Modify: `tests/e2e/mvp-flow.spec.ts` (데이터셋 의존 구간을 새 위저드 흐름으로)

시나리오(fake KRX 서버는 기존 krx-universe.spec 의 기동 방식을 재사용):
1. 데이터 탭 → 종목 마스터 기본 탭 확인 → 미수집 날짜 빈 상태 → [이 날짜 동기화] → 표 렌더 → 타임라인 coverage 반영.
2. 가격 데이터 탭(`?tab=symbols` 구링크 포함) 접근 확인.
3. 위저드: 유니버스 규칙 입력 → 미리보기 → uncovered 경고 → 동기화 → 제출 → 완료까지(mvp-flow 수준).
4. 스펙 셀프 정리: 생성한 마스터 데이터는 테스트 종료 시 정리(기존 자동 생성 데이터셋 정리 선례).

- [ ] **Step 1: 스펙 작성** → **Step 2: `pnpm test:e2e` PASS** → **Step 3: 커밋**

```bash
git add tests/e2e
git commit -m "test(e2e): 종목 마스터·유니버스 규칙 시나리오로 재작성한다"
```

---

## 완료 기준

- 위저드에서 데이터셋·스냅샷 개념이 사라지고 유니버스 규칙만 남는다.
- 제출→일정 pin→워커→엔진 경로가 통합 테스트·e2e 로 입증된다.
- `datasets`·`universeSnapshots` 계열 테이블·코드·참조가 저장소에 없다.
- `pnpm test && pnpm lint && pnpm typecheck && pnpm test:e2e` 전부 통과.
