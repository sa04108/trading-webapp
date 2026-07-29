# 웹 재무 동기화 + 백테스트 종목명 표시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데이터셋 카드의 「동기화」 옆에 「재무」 체크박스와 예상 소요시간을 붙여 DART 재무를 웹에서 받게 하고, 지원하지 않는 시장(US)을 고를 수 없게 이유와 함께 명시하고, 백테스트 화면의 종목코드를 `이름 (코드)` 로 바꾼다.

**Architecture:** 재무 수집은 봉 수집과 **같은 잡** 안에서 순차 실행한다 — 잡 id 하나, 취소 하나, 폴링 하나. `market-data` 와 `facts` 모듈은 서로를 import 하지 않고, 컨테이너가 함수(`factsPhase`, `factsSyncEstimator`)를 주입해 잇는다(기존 `hasActiveBacktests` 관례). 예상 소요시간과 실제 수집 계획은 **같은 순수 함수 두 개**(`deriveFactYearRange`, `planFactSync`)에서 나오므로 갈라질 수 없다. 종목명 표시는 이미 있는 `GET /symbols/info` 를 백테스트 화면에서 쓰는 것뿐이고 서버 API 를 건드리지 않는다.

**Tech Stack:** TypeScript 5.9 (strict, `noUncheckedIndexedAccess`), Node 24, Fastify, Drizzle ORM + better-sqlite3, DuckDB/Parquet, React 19 + TanStack Query, Tailwind + shadcn(radix-ui 통합 패키지), Vitest, Playwright.

## Global Constraints

- **스펙 문서:** `docs/superpowers/specs/2026-07-29-web-facts-sync-design.md`, `docs/superpowers/specs/2026-07-29-market-support-disclosure-design.md`, `docs/superpowers/specs/2026-07-29-symbol-name-display-design.md`
- **재무 수집은 국내(KR) 종목 전용이다** — DART 는 국내 공시 기관이다. 이 사실은 재무 체크박스 툴팁에 **상시** 표시한다(미지원일 때만이 아니다).
- **US 는 데이터셋 자체를 만들 수 없다** — 거래소 세션이 정의되지 않아 `getSessionForMarket` 이 던지고, 증권사·CSV 두 생성 경로가 모두 그것을 호출한다(D-006). UI 는 고를 수 없게 막고 이유를 상시 노출한다. **서버 검증은 없애지 않는다** — UI 는 미리 알려주는 층이지 거부하는 층이 아니다.
- **DART 일일 호출 한도는 40,000** 이다. `fact-sync-service.ts:51-55` 의 "일 한도 20,000" 주석은 오류이므로 함께 고친다.
- **종목·연도당 DART 호출 9회** — `fnlttSinglAcntAll` 4 + `stockTotqySttus` 4 + `irdsSttus` 1.
- **`dart-fact-source.ts` 의 한도 주석은 이미 4만으로 정정돼 있다**(커밋 `366e28a`). 남은 오류는 `fact-sync-service.ts:52` 의 "일 한도 20,000" 하나이고 Task 4 가 고친다.
- **rate limiter 최소 간격 120ms** — `DART_MIN_INTERVAL_MS` 상수 한 곳에서만 정의하고 `dart-fact-source.ts` 가 그것을 쓴다. 두 곳에 숫자를 두면 화면 추정치만 조용히 틀려진다.
- **표기 규칙은 `이름 (코드)` 하나.** 공백 하나 포함. 이름을 모르면 코드만 — 빈 괄호를 만들지 않는다.
- **주석·UI 문구는 한국어.** 이 저장소의 관례다. 주석은 "무엇을" 이 아니라 "왜" 를 적는다.
- **React 컴포넌트 단위 테스트 환경이 없다** (jsdom·testing-library 없음, `vitest.config.ts` 는 `tests/{unit,integration,architecture}` 만 include). 판단은 순수 함수로 빼서 단위 테스트하고 렌더링은 Playwright 로 본다. 이 계획을 위해 테스트 인프라를 새로 들이지 않는다.
- **테스트 명령:** 단위 `pnpm vitest run tests/unit/<file>`, 전체 `pnpm test`, 타입 `pnpm typecheck`, 린트 `pnpm lint`, e2e `pnpm test:e2e`.
- **커밋:** 각 태스크 끝에서 커밋한다. 커밋 메시지는 한국어 본문 + conventional prefix.

## File Structure

**새로 만드는 파일**

| 파일 | 책임 |
|---|---|
| `src/server/modules/facts/domain/sync-plan.ts` | DART 호출 상수 + `planFactSync` (수집 계획·호출 수·예상 시간). 순수 함수. |
| `src/server/modules/facts/application/fact-coverage-store.ts` | `FactCoverageStore` 포트 + `SqliteFactCoverageStore` 구현. 종목별 수집 완료 연도. |
| `src/server/modules/market-data/domain/market-support.ts` | `listMarketSupport` — 시장별 데이터셋·재무 지원 여부와 이유. |
| `src/web/lib/use-market-support.ts` | `GET /markets` 조회 훅. 배포마다 고정이라 `staleTime: Infinity`. |
| `src/web/components/symbol-label.tsx` | `이름 (코드)` 렌더. 이름만 줄고 코드는 안 잘린다. |
| `src/web/features/backtests/symbol-summary.ts` | `formatSymbolLabel` · `formatSymbolSummary`. 표기 규칙의 단일 출처. |
| `src/web/lib/use-stock-names.ts` | `datasets-page.tsx` 에서 승격한 공유 훅 + `StockInfo` 타입. |
| `tests/unit/sync-plan.test.ts` | `planFactSync` 단위. |
| `tests/unit/fact-year-range.test.ts` | `deriveFactYearRange` 단위. |
| `tests/unit/market-support.test.ts` | `hasMarketSession`·`listMarketSupport` 단위 + 세션 조회 회귀. |
| `tests/unit/symbol-summary.test.ts` | `formatSymbolLabel`·`formatSymbolSummary` 단위. |

**수정하는 파일**

| 파일 | 변경 |
|---|---|
| `src/server/shared/db/schema.ts` | `dataImportJobs` + `phase`·`candlesMs`·`factsJson`; 새 `datasetFactsState` 테이블. |
| `src/server/modules/market-data/domain/candle.ts` | `ALL_MARKETS` 값 목록. |
| `src/server/modules/market-data/domain/exchange-session.ts` | `SESSIONS` 맵 기반으로 전환 + `hasMarketSession` 노출. |
| `src/server/modules/market-data/domain/fact-year-range.ts` | 신규: 커버리지 → 연도 범위. market-data 도메인에 둔다(커버리지·세션은 이 모듈의 지식). |
| `src/server/modules/facts/application/ports.ts` | `FetchFinancialsRequest` 를 연도 목록으로; `FactCoverageStore` 포트 재export. |
| `src/server/modules/facts/infrastructure/dart/dart-fact-source.ts` | 연도 목록 순회; `groupMinIntervalMs` 를 상수에서. |
| `src/server/modules/facts/application/fact-sync-service.ts` | `mode`·`shouldStop`·`stopReason`; 종목별 수집 연도 기록. |
| `src/server/cli.ts` | `mode: 'FULL'` 명시. |
| `src/server/modules/market-data/application/broker-sync-service.ts` | `factsPhase` 단계, `phase`·`candlesMs`·`factsJson` 기록. |
| `src/server/modules/market-data/application/dataset-service.ts` | `getCandleSyncEstimate` (직전 실행 실측치). |
| `src/server/modules/market-data/presentation/dataset-routes.ts` | `includeFacts` 검증, `syncEstimate` 응답, `GET /markets`. |
| `src/server/bootstrap/container.ts` | `factCoverageStore`·`factsPhase`·`factsSyncEstimator` 조립. |
| `src/server/bootstrap/server.ts` | `registerDatasetRoutes` 에 추정기 전달. |
| `.dependency-cruiser.cjs` | `market-data-no-facts` 규칙. |
| `src/web/components/ui/checkbox.tsx` | 신규 shadcn 프리미티브. |
| `src/web/features/datasets/datasets-page.tsx` | 체크박스·툴팁·예상 시간·진행 표시; 훅 import 로 교체; 시장 Select 두 곳을 `MarketSelect` 로. |
| `docs/DECISIONS.md` | D-027 — 미지원 시장을 UI 에서 고를 수 없게 한다. |
| `src/web/features/backtests/backtest-detail-page.tsx` | Description·거래 내역·종목 필터·종목별 성과에 종목명. |
| `src/web/features/backtests/backtests-page.tsx` | 목록 카드 Description 에 종목명. |
| `tests/unit/fact-sync-service.test.ts` | 포트·`mode` 변경 반영. |
| `tests/unit/dart-fact-source.test.ts` | 연도 목록 반영. |
| `tests/unit/broker-sync-service.test.ts` | 재무 단계 케이스. |
| `tests/e2e/mvp-flow.spec.ts` | 종목명·체크박스 확인. |

**태스크 순서 근거:** 1–2 는 순수 함수와 스키마라 뒤의 모든 것이 의존한다. 3–4 는 facts 모듈 내부 — 3(이력 저장소)이 먼저이고 4(포트 전환 + 증분 서비스)가 그것을 쓴다. 5–7 은 market-data 쪽(연도 도출 → 잡 단계 → 라우트·조립). 8–9 는 웹 재무 UI — 재무 툴팁의 "국내(KR) 종목만" 한 줄은 정적 문구라 Task 9 에 들어가고 Task 13 를 기다리지 않는다. 10–12 는 종목명 표시. 13–14 는 시장 지원 명시(서버 → 웹). 15 는 문서.

**모든 태스크의 커밋은 `pnpm typecheck && pnpm test` 를 통과한다.** Task 4 가 포트 변경과 그 유일한 소비자(`FactSyncService`)를 한 커밋에 담는 이유가 이것이다 — 나누면 앞 커밋이 컴파일되지 않고, 리뷰어가 한쪽만 승인할 수도 없다.

Task 13–14 를 뒤에 두는 이유: `exchange-session.ts` 를 맵 기반으로 바꾸는 것이 세션을 쓰는 모든 테스트(`aggregate`·`coverage`·`session-policy`·`broker-sync-service`)의 회귀 대상이라, 앞선 태스크들이 통과한 상태에서 해야 회귀 원인을 가릴 수 있다.

---

### Task 1: DART 수집 계획 순수 함수

**Files:**
- Create: `src/server/modules/facts/domain/sync-plan.ts`
- Test: `tests/unit/sync-plan.test.ts`

**Interfaces:**
- Consumes: 없음 (순수 함수, 첫 태스크)
- Produces: `DART_CALLS_PER_SYMBOL_YEAR`, `DART_SHARE_ANCHOR_CALLS`, `DART_MIN_INTERVAL_MS`, `DART_DAILY_CALL_LIMIT`, `type FactSyncMode = 'FULL' | 'INCREMENTAL'`, `interface FactSyncPlan`, `planFactSync(args) => FactSyncPlan`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/sync-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DART_DAILY_CALL_LIMIT,
  planFactSync,
} from '../../src/server/modules/facts/domain/sync-plan.js';

const BASE = {
  symbols: ['005930', '000660'],
  fromYear: 2020,
  toYear: 2022,
  currentYear: 2022,
  coveredBySymbol: new Map<string, readonly number[]>(),
};

describe('planFactSync', () => {
  it('FULL 은 수집 이력을 무시하고 전 구간을 계획한다', () => {
    const plan = planFactSync({
      ...BASE,
      coveredBySymbol: new Map([['005930', [2020, 2021, 2022]]]),
      mode: 'FULL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([2020, 2021, 2022]);
    expect(plan.yearsBySymbol.get('000660')).toEqual([2020, 2021, 2022]);
  });

  it('INCREMENTAL 은 미수집 연도 + 현재 연도만 계획한다', () => {
    const plan = planFactSync({
      ...BASE,
      coveredBySymbol: new Map([['005930', [2020, 2022]]]),
      mode: 'INCREMENTAL',
    });
    // 2021 미수집 + 2022 는 현재 연도라 항상 다시 읽는다
    expect(plan.yearsBySymbol.get('005930')).toEqual([2021, 2022]);
    expect(plan.yearsBySymbol.get('000660')).toEqual([2020, 2021, 2022]);
  });

  it('불연속 수집 이력을 그대로 다룬다', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2018,
      toYear: 2024,
      currentYear: 2024,
      coveredBySymbol: new Map([['005930', [2018, 2019, 2023]]]),
      mode: 'INCREMENTAL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([2020, 2021, 2022, 2024]);
  });

  it('주식총수는 대상 연도 + 직전 1년을 읽는다 (자본변동 앵커)', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2022,
      currentYear: 2022,
      coveredBySymbol: new Map([['005930', [2020, 2021]]]),
      mode: 'INCREMENTAL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([2022]);
    expect(plan.shareYearsBySymbol.get('005930')).toEqual([2021, 2022]);
  });

  it('수집할 것이 없는 종목은 계획도 호출도 없다', () => {
    const plan = planFactSync({
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2021,
      currentYear: 2030,
      coveredBySymbol: new Map([['005930', [2020, 2021]]]),
      mode: 'INCREMENTAL',
    });
    expect(plan.yearsBySymbol.get('005930')).toEqual([]);
    expect(plan.shareYearsBySymbol.get('005930')).toEqual([]);
    expect(plan.calls).toBe(0);
    expect(plan.estimatedMs).toBe(0);
  });

  it('호출 수는 종목당 (연도 × 9 + 앵커 4) 이고 예상 시간은 × 120ms 다', () => {
    const plan = planFactSync({ ...BASE, mode: 'FULL' });
    // 종목 2개 × (3년 × 9 + 4) = 2 × 31 = 62
    expect(plan.calls).toBe(62);
    expect(plan.estimatedMs).toBe(62 * 120);
    expect(plan.overDailyLimit).toBe(false);
  });

  it('일일 한도(40,000) 초과를 표시한다', () => {
    const symbols = Array.from({ length: 200 }, (_, index) => String(index).padStart(6, '0'));
    const plan = planFactSync({
      symbols,
      fromYear: 2000,
      toYear: 2025,
      currentYear: 2025,
      coveredBySymbol: new Map(),
      mode: 'FULL',
    });
    // 200 × (26년 × 9 + 4) = 200 × 238 = 47,600
    expect(plan.calls).toBe(47_600);
    expect(plan.calls).toBeGreaterThan(DART_DAILY_CALL_LIMIT);
    expect(plan.overDailyLimit).toBe(true);
  });

  it('중복 심볼을 한 번만 계획한다', () => {
    const plan = planFactSync({
      symbols: ['005930', '005930'],
      fromYear: 2022,
      toYear: 2022,
      currentYear: 2022,
      coveredBySymbol: new Map(),
      mode: 'FULL',
    });
    expect(plan.yearsBySymbol.size).toBe(1);
    expect(plan.calls).toBe(13);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/sync-plan.test.ts`
Expected: FAIL — `Failed to resolve import ".../sync-plan.js"`

- [ ] **Step 3: 구현한다**

`src/server/modules/facts/domain/sync-plan.ts`:

```ts
/**
 * DART 수집 계획 — 무엇을 몇 번 호출하고 얼마나 걸리는지 한 곳에서 정한다.
 *
 * **추정 경로와 실행 경로가 같은 함수를 쓴다.** 화면에 "약 30분" 을 그리는 쪽과 실제로
 * DART 를 때리는 쪽이 규칙을 따로 갖고 있으면, 한쪽만 고쳐졌을 때 사용자에게 보이는
 * 숫자만 조용히 틀려진다 — 틀렸다는 사실도 드러나지 않는다.
 */

/** 종목·연도당 호출: fnlttSinglAcntAll 4 + stockTotqySttus 4 + irdsSttus 1 */
export const DART_CALLS_PER_SYMBOL_YEAR = 9;

/**
 * 자본변동 앵커용 추가 호출 (종목당 1회, 4개 보고서).
 * `fetchCorporateActions` 는 `sharesBefore()` 로 이벤트 직전 발행주식수를 찾아 분할
 * 비율을 만든다. 대상 연도만 읽으면 그 연도 연초 이벤트의 앵커가 없어 비율이 조용히
 * gap 이 된다 — 직전 1년의 주식총수를 함께 읽어 앵커를 확보한다.
 */
export const DART_SHARE_ANCHOR_CALLS = 4;

/**
 * RestClient 그룹 최소 간격. `dart-fact-source.ts` 가 이 상수를 rate limiter 에 넣는다 —
 * 숫자를 두 곳에 두면 여기만 고쳤을 때 추정치가 실제와 어긋난다.
 */
export const DART_MIN_INTERVAL_MS = 120;

/** DART OpenAPI 일일 호출 한도 */
export const DART_DAILY_CALL_LIMIT = 40_000;

export type FactSyncMode = 'FULL' | 'INCREMENTAL';

export interface FactSyncPlan {
  /** 종목 → 재무·자본변동을 수집할 연도 (오름차순) */
  readonly yearsBySymbol: ReadonlyMap<string, readonly number[]>;
  /** 종목 → 주식총수를 읽을 연도 (= 위 + 직전 1년) */
  readonly shareYearsBySymbol: ReadonlyMap<string, readonly number[]>;
  readonly calls: number;
  readonly estimatedMs: number;
  readonly overDailyLimit: boolean;
}

export interface PlanFactSyncArgs {
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  /** 오늘이 속한 연도 — 분기 보고서가 그 안에서 갱신되므로 증분에서도 다시 읽는다 */
  readonly currentYear: number;
  readonly coveredBySymbol: ReadonlyMap<string, readonly number[]>;
  readonly mode: FactSyncMode;
}

export function planFactSync(args: PlanFactSyncArgs): FactSyncPlan {
  const target: number[] = [];
  for (let year = args.fromYear; year <= args.toYear; year += 1) target.push(year);

  const yearsBySymbol = new Map<string, readonly number[]>();
  const shareYearsBySymbol = new Map<string, readonly number[]>();
  let calls = 0;

  // 같은 종목이 두 번 들어와도 한 번만 계획한다 — 호출 수가 부풀면 예상 시간도 부푼다
  for (const symbol of new Set(args.symbols)) {
    const years =
      args.mode === 'FULL' ? target : incrementalYears(target, args.coveredBySymbol.get(symbol) ?? [], args.currentYear);
    yearsBySymbol.set(symbol, years);

    const first = years[0];
    // 수집할 것이 없으면 앵커도 읽지 않는다 — 0건 종목에 호출을 쓰지 않는다
    const shareYears = first === undefined ? [] : [first - 1, ...years];
    shareYearsBySymbol.set(symbol, shareYears);

    calls += years.length * DART_CALLS_PER_SYMBOL_YEAR;
    if (years.length > 0) calls += DART_SHARE_ANCHOR_CALLS;
  }

  return {
    yearsBySymbol,
    shareYearsBySymbol,
    calls,
    estimatedMs: calls * DART_MIN_INTERVAL_MS,
    overDailyLimit: calls > DART_DAILY_CALL_LIMIT,
  };
}

function incrementalYears(
  target: readonly number[],
  covered: readonly number[],
  currentYear: number,
): number[] {
  const coveredSet = new Set(covered);
  return target.filter((year) => year === currentYear || !coveredSet.has(year));
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/sync-plan.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/facts/domain/sync-plan.ts tests/unit/sync-plan.test.ts
git commit -m "feat(facts): DART 수집 계획을 순수 함수로 뽑는다

추정 경로와 실행 경로가 같은 규칙을 쓰게 한다. 주식총수는 대상 연도 + 직전
1년을 읽어 자본변동 앵커를 잃지 않는다."
```

---

### Task 2: 스키마 — 잡 컬럼 3개 + 수집 이력 테이블

**Files:**
- Modify: `src/server/shared/db/schema.ts:105-145`
- Create: `migrations/0003_*.sql` (drizzle-kit 생성)

**Interfaces:**
- Consumes: 없음
- Produces: `dataImportJobs.phase`, `dataImportJobs.candlesMs`, `dataImportJobs.factsJson`, `datasetFactsState` 테이블 (`datasetId`, `symbol`, `coveredYearsJson`, `updatedAtMs`)

- [ ] **Step 1: `dataImportJobs` 에 컬럼 3개를 더한다**

`src/server/shared/db/schema.ts` — `dataImportJobs` 정의의 `completedAtMs` 아래에 추가:

```ts
    completedAtMs: integer('completed_at_ms'),
    /** CANDLES | FACTS — 봉·재무 두 단계로 진행되는 잡의 현재 단계 (BROKER 전용) */
    phase: text('phase'),
    /**
     * 봉 단계만의 소요시간. 잡 전체 소요시간에는 재무 단계가 섞여 있어 다음 실행의
     * 봉 예상치로 쓸 수 없다 — 봉만 따로 재어 둔다.
     */
    candlesMs: integer('candles_ms'),
    /** 재무 단계 진행·결과 (FactsJobState). null = 재무를 요청하지 않은 잡 */
    factsJson: text('facts_json'),
```

- [ ] **Step 2: `datasetFactsState` 테이블을 더한다**

`brokerSyncState` 정의 바로 아래에 추가:

```ts
/**
 * 종목별 재무 수집 완료 연도 (설계 2026-07-29-web-facts-sync-design.md §3).
 *
 * **범위 두 값이 아니라 연도 목록이다.** CLI 로 2010–2012 를, 웹으로 2019–2026 을
 * 받으면 수집 이력은 불연속이 된다 — `from`/`to` 로 접으면 2013–2018 을 수집했다고
 * 거짓말한다.
 *
 * 종목 단위인 이유는 저장이 종목 단위이기 때문이다 — 180/200 에서 중단된 실행도
 * 완료된 179종목만 기록되어 다음 실행이 정확히 이어받는다.
 */
export const datasetFactsState = sqliteTable(
  'dataset_facts_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    /** number[] 오름차순 JSON */
    coveredYearsJson: text('covered_years_json').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    uniqueIndex('idx_dataset_facts_state_dataset_symbol').on(table.datasetId, table.symbol),
  ],
);
```

- [ ] **Step 3: 마이그레이션을 생성한다**

Run: `pnpm db:generate`
Expected: `migrations/0003_<name>.sql` 이 만들어지고 `ALTER TABLE data_import_jobs ADD ...` 3줄 + `CREATE TABLE dataset_facts_state` + unique index 를 담는다.

생성된 SQL 을 읽어 확인한다: 새 컬럼 3개가 모두 nullable 이어야 한다 (기존 행이 그대로 남아야 하고, UI 는 `factsJson === null` 을 "재무 미요청" 으로 읽는다).

- [ ] **Step 4: 타입체크와 기존 테스트를 돌린다**

Run: `pnpm typecheck && pnpm vitest run tests/unit/broker-sync-service.test.ts`
Expected: PASS — 컬럼 추가는 기존 코드를 깨지 않는다.

- [ ] **Step 5: 커밋**

```bash
git add src/server/shared/db/schema.ts migrations/
git commit -m "feat(db): 잡 단계·봉 소요시간·재무 진행 컬럼과 재무 수집 이력 테이블

수집 이력은 범위가 아니라 연도 목록으로 둔다 — 불연속 이력을 범위로 접으면
수집하지 않은 구간을 수집했다고 거짓말한다."
```

---

### Task 3: 수집 이력 저장소

**Files:**
- Create: `src/server/modules/facts/application/fact-coverage-store.ts`
- Test: `tests/unit/fact-coverage-store.test.ts`

**Interfaces:**
- Consumes: `datasetFactsState` (Task 2)
- Produces: `interface FactCoverageStore { getCoveredYears(datasetId): ReadonlyMap<string, readonly number[]>; addCoveredYears(datasetId, symbol, years, nowMs): void }`, `class SqliteFactCoverageStore`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/fact-coverage-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SqliteFactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { datasets } from '../../src/server/shared/db/schema.js';

function setup() {
  const database = openDatabase(':memory:');
  database.db
    .insert(datasets)
    .values({
      id: 'ds-1',
      name: 'test',
      market: 'KR',
      timeframe: '1d',
      symbolsJson: JSON.stringify(['005930']),
      description: null,
      createdAtMs: 1,
    })
    .run();
  return { database, store: new SqliteFactCoverageStore(database.db) };
}

describe('SqliteFactCoverageStore', () => {
  it('기록이 없으면 빈 Map 이다', () => {
    const { store, database } = setup();
    expect(store.getCoveredYears('ds-1').size).toBe(0);
    database.close();
  });

  it('기록한 연도를 되돌려준다', () => {
    const { store, database } = setup();
    store.addCoveredYears('ds-1', '005930', [2021, 2020], 100);
    expect(store.getCoveredYears('ds-1').get('005930')).toEqual([2020, 2021]);
    database.close();
  });

  it('여러 번 기록하면 합집합이 되고 중복은 접힌다', () => {
    const { store, database } = setup();
    store.addCoveredYears('ds-1', '005930', [2020, 2021], 100);
    store.addCoveredYears('ds-1', '005930', [2021, 2022], 200);
    expect(store.getCoveredYears('ds-1').get('005930')).toEqual([2020, 2021, 2022]);
    database.close();
  });

  it('종목별로 따로 기록된다', () => {
    const { store, database } = setup();
    store.addCoveredYears('ds-1', '005930', [2020], 100);
    store.addCoveredYears('ds-1', '000660', [2021], 100);
    const covered = store.getCoveredYears('ds-1');
    expect(covered.get('005930')).toEqual([2020]);
    expect(covered.get('000660')).toEqual([2021]);
    database.close();
  });

  it('빈 연도 목록은 기록하지 않는다', () => {
    const { store, database } = setup();
    store.addCoveredYears('ds-1', '005930', [], 100);
    expect(store.getCoveredYears('ds-1').size).toBe(0);
    database.close();
  });

  it('깨진 JSON 은 빈 목록으로 읽어 수집을 멈추지 않는다', () => {
    const { store, database } = setup();
    database.sqlite
      .prepare(
        'INSERT INTO dataset_facts_state (dataset_id, symbol, covered_years_json, updated_at_ms) VALUES (?, ?, ?, ?)',
      )
      .run('ds-1', '005930', '{not json', 1);
    expect(store.getCoveredYears('ds-1').get('005930')).toEqual([]);
    database.close();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/fact-coverage-store.test.ts`
Expected: FAIL — `Failed to resolve import ".../fact-coverage-store.js"`

- [ ] **Step 3: 구현한다**

`src/server/modules/facts/application/fact-coverage-store.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { datasetFactsState } from '../../../shared/db/schema.js';

/**
 * 종목별 재무 수집 완료 연도. 증분 수집이 "무엇이 아직 없는지" 를 알기 위한 유일한
 * 근거다 (설계 2026-07-29-web-facts-sync-design.md §3).
 */
export interface FactCoverageStore {
  /** 데이터셋의 종목 → 수집 완료 연도 (오름차순) */
  getCoveredYears(datasetId: string): ReadonlyMap<string, readonly number[]>;
  /** 종목 하나의 완료 연도를 합집합으로 더한다. 팩트 저장 직후에 부른다. */
  addCoveredYears(
    datasetId: string,
    symbol: string,
    years: readonly number[],
    nowMs: number,
  ): void;
}

export class SqliteFactCoverageStore implements FactCoverageStore {
  constructor(private readonly db: AppDatabase) {}

  getCoveredYears(datasetId: string): ReadonlyMap<string, readonly number[]> {
    const rows = this.db
      .select()
      .from(datasetFactsState)
      .where(eq(datasetFactsState.datasetId, datasetId))
      .all();
    const result = new Map<string, readonly number[]>();
    for (const row of rows) {
      result.set(row.symbol, parseYears(row.coveredYearsJson));
    }
    return result;
  }

  addCoveredYears(
    datasetId: string,
    symbol: string,
    years: readonly number[],
    nowMs: number,
  ): void {
    // 빈 목록은 기록하지 않는다 — 아무것도 수집하지 않은 종목에 행을 만들면
    // "수집됨" 과 "수집할 게 없었음" 이 구분되지 않는다
    if (years.length === 0) return;

    const existing = this.db
      .select()
      .from(datasetFactsState)
      .where(and(eq(datasetFactsState.datasetId, datasetId), eq(datasetFactsState.symbol, symbol)))
      .get();

    const merged = [...new Set([...(existing ? parseYears(existing.coveredYearsJson) : []), ...years])].sort(
      (a, b) => a - b,
    );
    const coveredYearsJson = JSON.stringify(merged);

    if (existing) {
      this.db
        .update(datasetFactsState)
        .set({ coveredYearsJson, updatedAtMs: nowMs })
        .where(eq(datasetFactsState.id, existing.id))
        .run();
      return;
    }
    this.db
      .insert(datasetFactsState)
      .values({ datasetId, symbol, coveredYearsJson, updatedAtMs: nowMs })
      .run();
  }
}

/**
 * 깨진 JSON 을 빈 목록으로 읽는다 — 여기서 던지면 수집 전체가 시작조차 못 한다.
 * 빈 목록이면 그 종목을 전 구간 다시 받으므로(멱등) 결과는 옳고 비용만 든다.
 */
function parseYears(json: string): readonly number[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((year): year is number => typeof year === 'number').sort((a, b) => a - b);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/fact-coverage-store.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/facts/application/fact-coverage-store.ts tests/unit/fact-coverage-store.test.ts
git commit -m "feat(facts): 종목별 재무 수집 이력 저장소

깨진 JSON 은 빈 목록으로 읽는다 — 여기서 던지면 수집이 시작조차 못 하고,
빈 목록이면 그 종목만 다시 받으므로(멱등) 결과는 옳다."
```

---

### Task 4: 연도 목록 포트 전환 + 증분 수집 서비스

**이 태스크가 하나인 이유:** 포트(`FetchFinancialsRequest`)를 연도 목록으로 바꾸면 그
포트의 유일한 소비자인 `FactSyncService` 가 즉시 컴파일되지 않는다. 둘을 나누면 앞
태스크의 커밋이 `pnpm typecheck` 를 통과하지 못하고, 리뷰어는 한쪽만 승인할 수도 없다.
포트 변경과 그 소비자는 같은 허용 범위다.

**Files:**
- Modify: `src/server/modules/facts/application/ports.ts:34-40`
- Modify: `src/server/modules/facts/infrastructure/dart/dart-fact-source.ts`
- Modify: `src/server/modules/facts/application/fact-sync-service.ts`
- Modify: `src/server/cli.ts:184-231`
- Modify: `src/server/bootstrap/container.ts` (생성자 인자 1개 추가 — 최소 수정)
- Modify: `tests/unit/dart-fact-source.test.ts`
- Modify: `tests/unit/fact-sync-service.test.ts`

**Interfaces:**
- Consumes: `planFactSync`·`FactSyncMode`·`DART_MIN_INTERVAL_MS` (Task 1), `FactCoverageStore`·`SqliteFactCoverageStore` (Task 3)
- Produces: `FetchFinancialsRequest { symbols, years, shareYears, consolidated }`, `FactSyncRequest { datasetId, symbols, fromYear, toYear, consolidated, mode }`, `FactSyncHooks { onSymbolDone?, shouldStop? }`, `FactSyncReport { savedFacts, gaps, stoppedAtSymbol, stopReason, failureMessage }`

**진행 순서:** 어댑터 쪽(Step 1–5)을 먼저 바꾸고 서비스 쪽(Step 6–10)을 이어서 바꾼다.
**커밋은 Step 11 에서 한 번만 한다** — 중간에 끊으면 그 커밋이 컴파일되지 않는다.

#### 어댑터 — 포트를 연도 목록으로

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/dart-fact-source.test.ts` 에 추가 (기존 헬퍼를 재사용한다 — 파일 상단의 fake fetch 관례를 그대로 따른다):

```ts
  it('불연속 연도를 요청하면 그 연도만 호출한다', async () => {
    const calls: string[] = [];
    const source = createDartFactSource(
      { baseUrl: 'https://dart.test', apiKey: 'k' },
      LOGGER,
      {
        fetchImpl: async (url) => {
          calls.push(String(url));
          return jsonResponse({ status: '013', message: '조회된 데이터가 없습니다' });
        },
        sleep: async () => {},
        corpCodeResolver: { resolve: async () => '00126380' },
      },
    );

    await source.fetchFinancials({
      symbols: ['005930'],
      years: [2020, 2024],
      shareYears: [2019, 2020, 2024],
      consolidated: true,
    });

    const accountYears = calls
      .filter((url) => url.includes('fnlttSinglAcntAll'))
      .map((url) => new URL(url).searchParams.get('bsns_year'));
    expect([...new Set(accountYears)].sort()).toEqual(['2020', '2024']);

    const shareYears = calls
      .filter((url) => url.includes('stockTotqySttus'))
      .map((url) => new URL(url).searchParams.get('bsns_year'));
    expect([...new Set(shareYears)].sort()).toEqual(['2019', '2020', '2024']);
  });

  it('자본변동은 years 로, 주식총수 시계열은 shareYears 로 읽는다', async () => {
    const calls: string[] = [];
    const source = createDartFactSource(
      { baseUrl: 'https://dart.test', apiKey: 'k' },
      LOGGER,
      {
        fetchImpl: async (url) => {
          calls.push(String(url));
          return jsonResponse({ status: '013', message: '조회된 데이터가 없습니다' });
        },
        sleep: async () => {},
        corpCodeResolver: { resolve: async () => '00126380' },
      },
    );

    await source.fetchCorporateActions({
      symbols: ['005930'],
      years: [2024],
      shareYears: [2023, 2024],
      consolidated: true,
    });

    const issuanceYears = calls
      .filter((url) => url.includes('irdsSttus'))
      .map((url) => new URL(url).searchParams.get('bsns_year'));
    expect(issuanceYears).toEqual(['2024']);

    const shareYears = calls
      .filter((url) => url.includes('stockTotqySttus'))
      .map((url) => new URL(url).searchParams.get('bsns_year'));
    expect([...new Set(shareYears)].sort()).toEqual(['2023', '2024']);
  });
```

기존 테스트의 `fromYear`/`toYear` 호출부는 전부 `years`/`shareYears` 로 바꾼다. 예: `{ symbols: ['005930'], fromYear: 2024, toYear: 2024, consolidated: true }` → `{ symbols: ['005930'], years: [2024], shareYears: [2023, 2024], consolidated: true }`.

파일 상단에 `jsonResponse` / `LOGGER` 헬퍼가 이미 없다면 아래를 추가한다:

```ts
const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/dart-fact-source.test.ts`
Expected: FAIL — `years` 가 `FetchFinancialsRequest` 에 없다는 타입 오류, 또는 호출 연도가 기대와 다르다.

- [ ] **Step 3: 포트를 바꾼다**

`src/server/modules/facts/application/ports.ts` — `FetchFinancialsRequest` 를 교체:

```ts
export interface FetchFinancialsRequest {
  readonly symbols: readonly string[];
  /**
   * 재무제표·자본변동을 읽을 연도 (오름차순). 범위 두 값이 아닌 이유는 수집 이력이
   * 불연속일 수 있기 때문이다 — from/to 로 접으면 가운데 구멍을 수집했다고 거짓말한다.
   */
  readonly years: readonly number[];
  /**
   * 주식총수를 읽을 연도. `years` + 직전 1년이다 — 자본변동 비율은 이벤트 직전
   * 발행주식수를 앵커로 쓰므로, 대상 연도만 읽으면 연초 이벤트가 gap 이 된다.
   */
  readonly shareYears: readonly number[];
  /** true = 연결(CFS), false = 별도(OFS). 데이터셋 하나는 한 기준만 담는다 */
  readonly consolidated: boolean;
}
```

- [ ] **Step 4: 어댑터를 맞춘다**

`src/server/modules/facts/infrastructure/dart/dart-fact-source.ts`:

1. import 에 상수를 더한다:

```ts
import { DART_MIN_INTERVAL_MS } from '../../domain/sync-plan.js';
```

2. `groupMinIntervalMs` 를 상수로 바꾼다 (주석의 숫자 설명은 상수 정의로 옮겼으므로 참조만 남긴다):

```ts
    // 목적은 일일 한도 절약이 아니라 초당 폭주 방지다. 이 값을 화면 추정치와 공유하기
    // 위해 domain/sync-plan.ts 에서 가져온다 — 두 곳에 숫자를 두면 한쪽만 고쳐진다.
    groupMinIntervalMs: { default: DART_MIN_INTERVAL_MS },
```

3. `fetchFinancials` 의 연도 루프 두 개를 목록 순회로 바꾼다:

```ts
      for (const year of request.years) {
```

그리고 발행주식수 루프는 `request.shareYears` 를 돈다 — 재무 루프 **밖으로** 빼야 한다. 지금은 연도 루프 안에 중첩돼 있는데, `shareYears` 는 `years` 와 원소 수가 달라 안에 두면 연도가 어긋난다:

```ts
      for (const year of request.years) {
        const rowsByReport = new Map<DartReportCode, readonly DartFinancialRow[]>();
        // ... (기존 fnlttSinglAcntAll 수집·파싱 로직 그대로)
      }

      // 발행주식수 — 정기보고서별로 조회하고 그 보고서의 분기에 붙인다. DART
      // stockTotqySttus 는 사업보고서뿐 아니라 분기·반기보고서에도 '주식의 총수
      // 현황' 섹션을 담고 있어 네 보고서 모두 조회 대상이다.
      //
      // shareYears 는 years + 직전 1년이라 원소 수가 다르다 — 재무 루프 안에 두면
      // 연도가 어긋나므로 별도 루프로 돈다.
      for (const year of request.shareYears) {
        for (const reportCode of REPORT_ORDER) {
          const shareRows = await fetchShareRows(corpCode, year, reportCode);
          // ... (기존 보통주 선별·gap 처리 로직 그대로)
        }
      }
```

4. `fetchCorporateActions` 의 루프 두 개를 각각 바꾼다 — 주식총수 시계열은 `shareYears`, `irdsSttus` 는 `years`:

```ts
      for (const year of request.shareYears) {
        for (const reportCode of REPORT_ORDER) {
          // ... (기존 sharesByPeriod 채우기 그대로)
        }
      }
      sharesByPeriod.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));

      // ... sharesBefore 정의 그대로

      for (const year of request.years) {
        const rows = await call<DartIssuanceRow>('/api/irdsSttus.json', {
          // ... 그대로
        });
        // ... 그대로
      }
```

- [ ] **Step 5: 어댑터 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/dart-fact-source.test.ts`
Expected: PASS

**이 시점에 `pnpm typecheck` 는 아직 실패한다** — `fact-sync-service.ts` 가 옛 포트 모양으로
요청을 만들고 있다. 정상이다. Step 6–10 이 그것을 고치고 Step 11 에서 한 번에 커밋한다.
여기서 커밋하지 않는다.

#### 서비스 — 증분 모드와 취소

- [ ] **Step 6: 실패하는 테스트를 쓴다**

`tests/unit/fact-sync-service.test.ts` 에 추가. 기존 `fakeSource`/`fakeVersions` 헬퍼를 그대로 쓰고, 새로 필요한 가짜 저장소를 더한다:

```ts
import { SqliteFactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import type { FactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';

/** 기록을 메모리에 쌓는 가짜 이력 저장소 */
function fakeCoverage(
  initial: ReadonlyMap<string, readonly number[]> = new Map(),
): FactCoverageStore & { added: Array<{ symbol: string; years: readonly number[] }> } {
  const store = new Map<string, number[]>(
    [...initial].map(([symbol, years]) => [symbol, [...years]]),
  );
  const added: Array<{ symbol: string; years: readonly number[] }> = [];
  return {
    added,
    getCoveredYears: () => new Map([...store].map(([symbol, years]) => [symbol, [...years]])),
    addCoveredYears: (_datasetId, symbol, years) => {
      if (years.length === 0) return;
      added.push({ symbol, years: [...years] });
      store.set(symbol, [...new Set([...(store.get(symbol) ?? []), ...years])].sort((a, b) => a - b));
    },
  };
}

/** 요청을 기록하는 가짜 소스 — 어떤 연도를 요청했는지 확인한다 */
function recordingSource(): FactSource & { requests: FetchFinancialsRequest[] } {
  const requests: FetchFinancialsRequest[] = [];
  return {
    requests,
    fetchFinancials: async (request) => {
      requests.push(request);
      return { facts: [], gaps: [] };
    },
    fetchCorporateActions: async (request) => {
      requests.push(request);
      return { facts: [], gaps: [] };
    },
  };
}

describe('FactSyncService — 증분과 취소', () => {
  it('INCREMENTAL 은 미수집 연도 + 현재 연도만 요청한다', async () => {
    const source = recordingSource();
    const coverage = fakeCoverage(new Map([['005930', [2020, 2021]]]));
    const service = new FactSyncService(
      source,
      inMemoryRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
    );

    await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(source.requests[0]?.years).toEqual([2022]);
    expect(source.requests[0]?.shareYears).toEqual([2021, 2022]);
  });

  it('FULL 은 수집 이력을 무시한다', async () => {
    const source = recordingSource();
    const service = new FactSyncService(
      source,
      inMemoryRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      fakeCoverage(new Map([['005930', [2020, 2021, 2022]]])),
    );

    await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2022,
      consolidated: true,
      mode: 'FULL',
    });

    expect(source.requests[0]?.years).toEqual([2020, 2021, 2022]);
  });

  it('종목을 저장한 직후 그 종목의 연도를 이력에 남긴다', async () => {
    const coverage = fakeCoverage();
    const service = new FactSyncService(
      recordingSource(),
      inMemoryRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
    );

    await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930', '000660'],
      fromYear: 2021,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(coverage.added).toEqual([
      { symbol: '005930', years: [2021, 2022] },
      { symbol: '000660', years: [2021, 2022] },
    ]);
  });

  it('shouldStop 이 true 면 그 종목 전에 멈추고 CANCELLED 로 보고한다', async () => {
    const coverage = fakeCoverage();
    let calls = 0;
    const service = new FactSyncService(
      recordingSource(),
      inMemoryRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
    );

    const report = await service.sync(
      {
        datasetId: 'ds-1',
        symbols: ['005930', '000660', '035720'],
        fromYear: 2022,
        toYear: 2022,
        consolidated: true,
        mode: 'INCREMENTAL',
      },
      {
        shouldStop: () => {
          calls += 1;
          return calls > 2; // 두 종목 처리 후 취소
        },
      },
    );

    expect(report.stopReason).toBe('CANCELLED');
    expect(report.stoppedAtSymbol).toBe('035720');
    // 취소 전 두 종목은 이력에 남아 다음 실행이 이어받는다
    expect(coverage.added.map((entry) => entry.symbol)).toEqual(['005930', '000660']);
  });

  it('소스가 던지면 ERROR 로 보고하고 앞선 종목 이력은 남는다', async () => {
    const coverage = fakeCoverage();
    const source: FactSource = {
      fetchFinancials: async (request) => {
        if (request.symbols[0] === '000660') throw new Error('DART 응답 오류 020');
        return { facts: [], gaps: [] };
      },
      fetchCorporateActions: async () => ({ facts: [], gaps: [] }),
    };
    const service = new FactSyncService(
      source,
      inMemoryRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
    );

    const report = await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930', '000660'],
      fromYear: 2022,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(report.stopReason).toBe('ERROR');
    expect(report.stoppedAtSymbol).toBe('000660');
    expect(report.failureMessage).toContain('DART 응답 오류 020');
    expect(coverage.added.map((entry) => entry.symbol)).toEqual(['005930']);
  });

  it('수집할 연도가 없는 종목은 소스를 부르지 않는다', async () => {
    const source = recordingSource();
    const service = new FactSyncService(
      source,
      inMemoryRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2030, 0, 1) },
      fakeCoverage(new Map([['005930', [2021, 2022]]])),
    );

    await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2021,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(source.requests).toEqual([]);
  });
});
```

`inMemoryRepository()` 헬퍼가 파일에 없으면 추가한다:

```ts
function inMemoryRepository(): FactRepository {
  const store: Fact[] = [];
  return {
    getFacts: async () => [...store],
    saveFacts: async (_datasetId, facts) => {
      store.push(...facts);
    },
    hasFacts: () => store.length > 0,
  };
}
```

기존 테스트의 `sync({...})` 호출부에는 `mode: 'FULL'` 을 더하고, `new FactSyncService(...)` 호출부에는 여섯 번째 인자로 `fakeCoverage()` 를 더한다.

- [ ] **Step 7: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/fact-sync-service.test.ts`
Expected: FAIL — `FactSyncService` 생성자가 5개 인자만 받고 `mode`·`stopReason` 이 없다.

- [ ] **Step 8: 서비스를 바꾼다**

`src/server/modules/facts/application/fact-sync-service.ts`:

1. import 를 더한다:

```ts
import { planFactSync, type FactSyncMode } from '../domain/sync-plan.js';
import type { FactCoverageStore } from './fact-coverage-store.js';
```

2. 요청·훅·리포트 타입을 바꾼다:

```ts
export interface FactSyncRequest {
  readonly datasetId: string;
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  readonly consolidated: boolean;
  /**
   * FULL = 이력을 무시하고 지정 구간 전체 (CLI). INCREMENTAL = 미수집 연도 +
   * 현재 연도 (웹). 웹이 매번 전 구간을 다시 받으면 45분짜리 버튼이 된다.
   */
  readonly mode: FactSyncMode;
}

export interface FactSyncHooks {
  onSymbolDone?(progress: FactSyncProgress): void;
  /**
   * 종목 경계에서 확인하는 취소 신호. 봉 수집이 페이지 경계에서 확인하는 것과 같은
   * 입자다 — 저장이 종목 단위이므로 여기서 멈추면 저장분과 이력이 정합하게 남는다.
   */
  shouldStop?(): boolean;
}

export interface FactSyncReport {
  readonly savedFacts: number;
  readonly gaps: readonly FactIngestionGap[];
  /** 중단된 종목코드. 완주하면 null */
  readonly stoppedAtSymbol: string | null;
  /**
   * 중단 원인. 호출부가 잡 상태를 FAILED/CANCELLED 로 갈라야 하므로
   * stoppedAtSymbol 만으로는 부족하다.
   */
  readonly stopReason: 'ERROR' | 'CANCELLED' | null;
  /** 중단 사유 + 이어받는 방법을 담은 한국어 안내. 완주하면 null */
  readonly failureMessage: string | null;
}
```

3. 생성자에 이력 저장소를 더한다:

```ts
  constructor(
    private readonly source: FactSource,
    private readonly repository: FactRepository,
    private readonly logger: Logger,
    private readonly versions: DatasetVersionBumper,
    private readonly clock: Clock,
    private readonly coverage: FactCoverageStore,
  ) {}
```

4. `sync` 본문의 심볼 루프를 계획 기반으로 바꾼다. `fingerprintBefore` 계산 이후, 루프 앞에 계획을 만든다:

```ts
    const plan = planFactSync({
      symbols: request.symbols,
      fromYear: request.fromYear,
      toYear: request.toYear,
      currentYear: new Date(this.clock.now()).getUTCFullYear(),
      coveredBySymbol: this.coverage.getCoveredYears(request.datasetId),
      mode: request.mode,
    });
```

루프 본문을 교체한다:

```ts
    for (const [index, symbol] of request.symbols.entries()) {
      // 취소는 종목을 시작하기 전에 확인한다 — 시작한 종목을 중간에 버리면
      // 저장분과 이력이 어긋난다
      if (hooks.shouldStop?.()) {
        stoppedAtSymbol = symbol;
        stopReason = 'CANCELLED';
        break;
      }

      const years = plan.yearsBySymbol.get(symbol) ?? [];
      const shareYears = plan.shareYearsBySymbol.get(symbol) ?? [];
      if (years.length === 0) {
        // 받을 것이 없다 — 호출도 이력 갱신도 하지 않는다
        doneSymbols += 1;
        hooks.onSymbolDone?.({
          symbol,
          index: index + 1,
          total: request.symbols.length,
          savedFacts: 0,
          gapCount: 0,
        });
        continue;
      }

      try {
        const scoped = { symbols: [symbol], years, shareYears, consolidated: request.consolidated };
        const financials = await this.source.fetchFinancials(scoped);
        const actions = await this.source.fetchCorporateActions(scoped);
        const facts = [...financials.facts, ...actions.facts];
        const symbolGaps = [...financials.gaps, ...actions.gaps];

        // 종목마다 저장한다 — 뒤에서 터져도 여기까지는 남는다
        await this.repository.saveFacts(request.datasetId, facts);
        // 저장 직후에 이력을 남긴다. 순서가 뒤집히면 저장 실패한 연도를
        // 수집했다고 기록해 다음 실행이 그 구간을 건너뛴다.
        this.coverage.addCoveredYears(request.datasetId, symbol, years, this.clock.now());

        savedFacts += facts.length;
        doneSymbols += 1;
        gaps.push(...symbolGaps);
        hooks.onSymbolDone?.({
          symbol,
          index: index + 1,
          total: request.symbols.length,
          savedFacts: facts.length,
          gapCount: symbolGaps.length,
        });
      } catch (error) {
        stoppedAtSymbol = symbol;
        stopReason = 'ERROR';
        failureReason = error instanceof Error ? error.message : String(error);
        this.logger.error(
          {
            module: 'facts',
            event: 'facts.sync.aborted',
            datasetId: request.datasetId,
            symbol,
            symbolIndex: index + 1,
            symbolTotal: request.symbols.length,
            savedFacts,
            err: error,
          },
          'fact sync aborted — earlier symbols are already saved',
        );
        break;
      }
    }
```

루프 앞의 선언에 `stopReason` 을 더한다:

```ts
    let stoppedAtSymbol: string | null = null;
    let stopReason: 'ERROR' | 'CANCELLED' | null = null;
    let failureReason: string | null = null;
```

5. 반환부를 바꾼다:

```ts
    return {
      savedFacts,
      gaps,
      stoppedAtSymbol,
      stopReason,
      failureMessage:
        stoppedAtSymbol === null
          ? null
          : stopReason === 'CANCELLED'
            ? `수집이 사용자 요청으로 취소됐습니다 ` +
              `(${doneSymbols}/${request.symbols.length}종목 완료). ` +
              `수집된 팩트 ${savedFacts}건은 저장됐습니다 — 다시 실행하면 남은 종목만 이어받습니다.`
            : `수집이 ${stoppedAtSymbol} 에서 중단됐습니다 ` +
              `(${doneSymbols}/${request.symbols.length}종목 완료). ` +
              `사유: ${failureReason ?? '알 수 없음'}. ` +
              `여기까지 수집된 팩트 ${savedFacts}건은 이미 저장됐습니다 — 다시 실행하면 ` +
              `남은 구간만 이어받습니다.`,
    };
```

6. 파일 헤더 주석의 잘못된 한도를 고친다 (Global Constraints).

`fact-sync-service.ts:51-55` 의 현재 텍스트:

```
 * **종목 단위로 수집하고 종목 단위로 저장한다.** 전 종목을 모아 마지막에 한 번 저장하면
 * 200종목 × 12년 백필(종목·연도당 9회 ≈ 21,600 호출, 일 한도 20,000, rate limiter 로
 * 최소 40분)에서 180번째 종목의 오류 하나가 앞선 179종목의 결과를 통째로 버린다 —
 * 한도는 이미 소진된 상태로. 저장을 종목마다 끊으면 다시 실행할 때 `--from`/`--to` 를
 * 좁혀 남은 구간만 이어받을 수 있다.
```

이것으로 교체한다:

```
 * **종목 단위로 수집하고 종목 단위로 저장한다.** 전 종목을 모아 마지막에 한 번 저장하면
 * 200종목 × 12년 백필(종목·연도당 9회 ≈ 22,400 호출, 일 한도 40,000, rate limiter 로
 * 최소 45분)에서 180번째 종목의 오류 하나가 앞선 179종목의 결과를 통째로 버린다.
 * 저장을 종목마다 끊으면 수집 이력(dataset_facts_state)이 남아 다음 실행이 남은 종목만
 * 이어받는다.
```

두 곳을 고치는 것이다: **"일 한도 20,000" → 40,000**, 그리고 **"한도는 이미 소진된
상태로" 를 삭제** — 한도가 4만이면 21,600 호출은 한도를 소진하지 않으므로 그 결론 자체가
성립하지 않는다. 호출 수도 앵커 4회를 포함해 22,400 으로 맞춘다(Task 1 의 표와 일치).
같은 정정이 `dart-fact-source.ts` 에는 이미 커밋 `366e28a` 로 적용돼 있다.

- [ ] **Step 9: CLI 를 맞춘다**

`src/server/cli.ts` — `factsSync` 안의 `sync` 호출에 `mode` 를 더한다:

```ts
    const report = await container.factSyncService.sync(
      // CLI 는 지정한 구간을 전부 다시 받는다 — 과거 연도 정정공시 재수집이
      // 이 명령의 역할이다 (웹은 증분)
      { datasetId, symbols, fromYear, toYear, consolidated, mode: 'FULL' },
      {
```

- [ ] **Step 10: 컨테이너를 최소한만 맞춘다**

`FactSyncService` 생성자에 인자가 하나 늘었으므로 컨테이너가 컴파일되지 않는다. 여기서는
**그 한 줄만** 고친다 — `factsPhase`·`factsSyncEstimator` 조립은 Task 7 의 일이다.

`src/server/bootstrap/container.ts` — `factSyncService` 생성 부분을 바꾼다:

```ts
  const factCoverageStore = new SqliteFactCoverageStore(database.db);
  const factSyncService = new FactSyncService(
    factSource,
    factRepository,
    logger,
    datasetService,
    clock,
    factCoverageStore,
  );
```

import 를 더한다:

```ts
import { SqliteFactCoverageStore } from '../modules/facts/application/fact-coverage-store.js';
```

`factCoverageStore` 는 Task 7 의 추정기도 쓰므로 지역 상수로 남겨 둔다. `Container`
인터페이스에 노출할 필요는 없다.

- [ ] **Step 11: 전체 검증 — 여기서 처음으로 초록이 된다**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 전부 PASS. 이 태스크의 커밋이 컴파일되는 첫 지점이다 — typecheck 가 실패하면
Step 3·4·8·10 중 빠뜨린 곳이 있다.

특히 다음 기존 테스트가 통과해야 한다 (포트 변경의 회귀 감시):
- `tests/unit/dart-fact-source.test.ts`
- `tests/unit/fact-sync-service.test.ts`
- `tests/unit/fact-coverage-store.test.ts` (Task 3)
- `tests/unit/sync-plan.test.ts` (Task 1)

- [ ] **Step 12: 커밋 (이 태스크의 유일한 커밋)**

```bash
git add src/server/modules/facts/application/ports.ts src/server/modules/facts/infrastructure/dart/dart-fact-source.ts src/server/modules/facts/application/fact-sync-service.ts src/server/cli.ts src/server/bootstrap/container.ts tests/unit/dart-fact-source.test.ts tests/unit/fact-sync-service.test.ts
git commit -m "feat(facts): 연도 목록 포트로 전환하고 증분 수집을 넣는다

수집 이력이 불연속일 수 있어 from/to 두 값으로는 표현할 수 없다 — CLI 로
2010-2012 를, 웹으로 2019-2026 을 받으면 범위로 접는 순간 2013-2018 을
수집했다고 거짓말한다. 주식총수는 years 와 원소 수가 달라 별도 루프로 분리한다.

포트와 그 유일한 소비자를 한 커밋에 담는 이유는 나누면 중간 커밋이 컴파일되지
않기 때문이다. 이력은 저장 직후에 남긴다 — 순서가 뒤집히면 저장 실패한 연도를
수집했다고 기록해 다음 실행이 건너뛴다. stopReason 으로 실패와 취소를 가른다.
rate limiter 간격은 domain/sync-plan.ts 의 상수를 쓴다."
```

---

### Task 5: 커버리지 → 재무 연도 범위

**Files:**
- Create: `src/server/modules/market-data/domain/fact-year-range.ts`
- Test: `tests/unit/fact-year-range.test.ts`

**Interfaces:**
- Consumes: `getSessionForMarket` (`market-data/domain/exchange-session.ts`), `Market` (`market-data/domain/candle.ts`)
- Produces: `deriveFactYearRange(coverage, market) => { fromYear: number; toYear: number } | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/fact-year-range.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveFactYearRange } from '../../src/server/modules/market-data/domain/fact-year-range.js';

/** 2020-01-01 09:00 KST = 2019-12-31 00:00 UTC */
const KST_2020_OPEN = Date.UTC(2020, 0, 1, 0, 0);
/** 2024-06-03 09:00 KST */
const KST_2024 = Date.UTC(2024, 5, 3, 0, 0);
/** 2019-12-31 23:00 KST = 2019-12-31 14:00 UTC — KST 로는 아직 2019년 */
const KST_2019_LATE = Date.UTC(2019, 11, 31, 14, 0);

describe('deriveFactYearRange', () => {
  it('봉이 있는 종목의 최초·최종 연도를 돌려준다', () => {
    expect(
      deriveFactYearRange(
        [
          { firstTsMs: KST_2020_OPEN, lastTsMs: KST_2024, barCount: 100 },
          { firstTsMs: KST_2024, lastTsMs: KST_2024, barCount: 50 },
        ],
        'KR',
      ),
    ).toEqual({ fromYear: 2020, toYear: 2024 });
  });

  it('barCount 가 0 인 행은 무시한다', () => {
    expect(
      deriveFactYearRange(
        [
          { firstTsMs: KST_2020_OPEN, lastTsMs: KST_2020_OPEN, barCount: 0 },
          { firstTsMs: KST_2024, lastTsMs: KST_2024, barCount: 10 },
        ],
        'KR',
      ),
    ).toEqual({ fromYear: 2024, toYear: 2024 });
  });

  it('봉이 하나도 없으면 null 이다', () => {
    expect(deriveFactYearRange([], 'KR')).toBeNull();
    expect(
      deriveFactYearRange([{ firstTsMs: KST_2020_OPEN, lastTsMs: KST_2024, barCount: 0 }], 'KR'),
    ).toBeNull();
  });

  it('타임스탬프가 null 인 행은 무시한다', () => {
    expect(
      deriveFactYearRange(
        [
          { firstTsMs: null, lastTsMs: null, barCount: 5 },
          { firstTsMs: KST_2024, lastTsMs: KST_2024, barCount: 5 },
        ],
        'KR',
      ),
    ).toEqual({ fromYear: 2024, toYear: 2024 });
  });

  it('UTC 가 아니라 거래소 현지(KST) 연도로 자른다', () => {
    // UTC 로는 2019-12-31, KST 로도 2019-12-31 — 둘 다 2019
    expect(deriveFactYearRange([{ firstTsMs: KST_2019_LATE, lastTsMs: KST_2019_LATE, barCount: 1 }], 'KR')).toEqual({
      fromYear: 2019,
      toYear: 2019,
    });
    // UTC 로는 2019-12-31 15:00 이지만 KST 로는 2020-01-01 00:00 — 2020 이어야 한다
    const kstNewYear = Date.UTC(2019, 11, 31, 15, 0);
    expect(deriveFactYearRange([{ firstTsMs: kstNewYear, lastTsMs: kstNewYear, barCount: 1 }], 'KR')).toEqual({
      fromYear: 2020,
      toYear: 2020,
    });
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/fact-year-range.test.ts`
Expected: FAIL — `Failed to resolve import ".../fact-year-range.js"`

- [ ] **Step 3: 구현한다**

`src/server/modules/market-data/domain/fact-year-range.ts`:

```ts
import type { Market } from './candle.js';
import { getSessionForMarket } from './exchange-session.js';

const MS_PER_MINUTE = 60_000;

/** 재무 수집 연도 범위를 뽑을 때 보는 커버리지 필드만 */
export interface FactYearRangeCoverageRow {
  readonly firstTsMs: number | null;
  readonly lastTsMs: number | null;
  readonly barCount: number;
}

/**
 * 봉 커버리지에서 재무 수집 연도 범위를 뽑는다.
 *
 * 백테스트는 봉이 있는 구간만 돌므로 재무도 그 구간만 있으면 충분하다 — 봉이 2019년
 * 부터인데 2015년 재무를 긁는 것은 낭비다. 상장일을 쓰지 않는(쓸 수 없는) 이유이기도
 * 하다: 이 시스템에는 상장일 정보가 없고, 있어도 봉보다 앞선 구간은 쓸 데가 없다.
 *
 * 연도는 **거래소 현지 시각** 으로 자른다. UTC 로 자르면 KST 1월 1일 09:00 개장 봉이
 * 전년도로 밀려 그 해 재무를 수집 대상에서 빠뜨린다.
 *
 * 봉이 하나도 없으면 null — 호출부가 재무 단계를 건너뛰고 사유를 남긴다.
 */
export function deriveFactYearRange(
  coverage: readonly FactYearRangeCoverageRow[],
  market: Market,
): { fromYear: number; toYear: number } | null {
  const offsetMs = getSessionForMarket(market).utcOffsetMinutes * MS_PER_MINUTE;

  let fromYear: number | null = null;
  let toYear: number | null = null;
  for (const row of coverage) {
    if (row.barCount <= 0) continue;
    if (row.firstTsMs !== null) {
      const year = localYear(row.firstTsMs, offsetMs);
      if (fromYear === null || year < fromYear) fromYear = year;
    }
    if (row.lastTsMs !== null) {
      const year = localYear(row.lastTsMs, offsetMs);
      if (toYear === null || year > toYear) toYear = year;
    }
  }

  if (fromYear === null || toYear === null) return null;
  return { fromYear, toYear };
}

function localYear(tsMs: number, offsetMs: number): number {
  return new Date(tsMs + offsetMs).getUTCFullYear();
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/fact-year-range.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/domain/fact-year-range.ts tests/unit/fact-year-range.test.ts
git commit -m "feat(market-data): 봉 커버리지에서 재무 수집 연도 범위를 뽑는다

거래소 현지 시각으로 자른다 — UTC 로 자르면 KST 1월 1일 개장 봉이 전년도로
밀려 그 해 재무가 수집 대상에서 빠진다."
```

---

### Task 6: BrokerSyncService 재무 단계

**Files:**
- Modify: `src/server/modules/market-data/application/broker-sync-service.ts`
- Modify: `tests/unit/broker-sync-service.test.ts`

**Interfaces:**
- Consumes: `deriveFactYearRange` (Task 5), `dataImportJobs.phase|candlesMs|factsJson` (Task 2)
- Produces: `BrokerSyncDeps.factsPhase`, `interface FactPhaseProgress`, `interface FactPhaseResult`, `interface FactsJobState`, `BrokerSyncService.startSync(datasetId, options?: { includeFacts?: boolean })`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/broker-sync-service.test.ts` 에 추가. 기존 `FakeSource`·`InMemoryCandleRepository`·DB 셋업 헬퍼를 그대로 쓴다:

```ts
describe('재무 단계', () => {
  it('includeFacts 없이는 factsPhase 를 부르지 않고 factsJson 이 null 이다', async () => {
    const harness = setupHarness(); // 기존 테스트의 셋업 헬퍼 이름을 따른다
    let called = false;
    const service = harness.makeService({ factsPhase: async () => { called = true; return emptyFactResult(); } });

    const { done, job } = service.startSync(harness.datasetId);
    await done;

    expect(called).toBe(false);
    const row = harness.database.db
      .select()
      .from(dataImportJobs)
      .where(eq(dataImportJobs.id, job.id))
      .get();
    expect(row?.factsJson).toBeNull();
    expect(row?.candlesMs).not.toBeNull();
    expect(row?.status).toBe('COMPLETED');
  });

  it('includeFacts 면 봉 뒤에 재무를 돌리고 결과를 factsJson 에 남긴다', async () => {
    const harness = setupHarness();
    const seen: Array<{ fromYear: number; toYear: number }> = [];
    const service = harness.makeService({
      factsPhase: async ({ fromYear, toYear, onProgress }) => {
        seen.push({ fromYear, toYear });
        onProgress({ symbolsDone: 1, symbolTotal: 1, savedFacts: 12, gapCount: 3 });
        return { savedFacts: 12, gapCount: 3, stopReason: null, failureMessage: null };
      },
    });

    const { done, job } = service.startSync(harness.datasetId, { includeFacts: true });
    await done;

    expect(seen).toHaveLength(1);
    const row = harness.database.db
      .select()
      .from(dataImportJobs)
      .where(eq(dataImportJobs.id, job.id))
      .get();
    const facts = JSON.parse(row?.factsJson ?? 'null') as FactsJobState;
    expect(facts.savedFacts).toBe(12);
    expect(facts.gapCount).toBe(3);
    expect(facts.skipReason).toBeNull();
    expect(row?.status).toBe('COMPLETED');
  });

  it('봉이 하나도 없으면 재무를 건너뛰고 사유를 남긴다', async () => {
    const harness = setupHarness({ candles: [] }); // 소스가 봉을 주지 않는다
    let called = false;
    const service = harness.makeService({
      factsPhase: async () => { called = true; return emptyFactResult(); },
    });

    const { done, job } = service.startSync(harness.datasetId, { includeFacts: true });
    await done;

    expect(called).toBe(false);
    const row = harness.database.db
      .select()
      .from(dataImportJobs)
      .where(eq(dataImportJobs.id, job.id))
      .get();
    const facts = JSON.parse(row?.factsJson ?? 'null') as FactsJobState;
    expect(facts.skipReason).toContain('봉이 수집되지 않아');
  });

  it('재무 단계가 실패해도 봉 결과(rowsImported)는 남는다', async () => {
    const harness = setupHarness();
    const service = harness.makeService({
      factsPhase: async () => ({
        savedFacts: 5,
        gapCount: 0,
        stopReason: 'ERROR' as const,
        failureMessage: 'DART 응답 오류 020: 사용 한도 초과',
      }),
    });

    const { done, job } = service.startSync(harness.datasetId, { includeFacts: true });
    await done;

    const row = harness.database.db
      .select()
      .from(dataImportJobs)
      .where(eq(dataImportJobs.id, job.id))
      .get();
    expect(row?.status).toBe('FAILED');
    expect(row?.rowsImported).toBeGreaterThan(0);
    const facts = JSON.parse(row?.factsJson ?? 'null') as FactsJobState;
    expect(facts.savedFacts).toBe(5);
    expect(facts.failureMessage).toContain('한도 초과');
  });

  it('재무 단계 취소는 CANCELLED 로 기록된다', async () => {
    const harness = setupHarness();
    const service = harness.makeService({
      factsPhase: async () => ({
        savedFacts: 2,
        gapCount: 0,
        stopReason: 'CANCELLED' as const,
        failureMessage: '수집이 사용자 요청으로 취소됐습니다',
      }),
    });

    const { done, job } = service.startSync(harness.datasetId, { includeFacts: true });
    await done;

    const row = harness.database.db
      .select()
      .from(dataImportJobs)
      .where(eq(dataImportJobs.id, job.id))
      .get();
    expect(row?.status).toBe('CANCELLED');
  });

  it('factsPhase 가 주입되지 않았으면 includeFacts 를 건너뛴다', async () => {
    const harness = setupHarness();
    const service = harness.makeService({}); // factsPhase 없음

    const { done, job } = service.startSync(harness.datasetId, { includeFacts: true });
    await done;

    const row = harness.database.db
      .select()
      .from(dataImportJobs)
      .where(eq(dataImportJobs.id, job.id))
      .get();
    const facts = JSON.parse(row?.factsJson ?? 'null') as FactsJobState;
    expect(facts.skipReason).toContain('DART');
    expect(row?.status).toBe('COMPLETED');
  });
});

function emptyFactResult() {
  return { savedFacts: 0, gapCount: 0, stopReason: null, failureMessage: null };
}
```

**위 테스트 코드의 `setupHarness()`/`harness.makeService(...)` 는 실제 헬퍼 이름이 아니다 — 아래 실제 모양에 맞춰 옮겨 쓸 것.**

`tests/unit/broker-sync-service.test.ts:122-139` 에 이미 있는 헬퍼는 다음 하나다:

```ts
function buildHarness(source: MarketDataSource, options: { minFreeDiskBytes?: number; freeDiskBytes?: () => number } = {}) {
  const handle = openDatabase(':memory:');
  const repo = new InMemoryCandleRepository();
  const clock = { now: () => Date.UTC(2026, 6, 8, 12, 0) }; // 2026-07-08 수요일 21:00 KST
  const datasetService = new DatasetService(handle.db, repo, clock, logger, noopAudit);
  const sync = new BrokerSyncService({ db: handle.db, source, candleRepository: repo, datasetService, clock, logger, audit: noopAudit, minFreeDiskBytes: ..., freeDiskBytes: ... });
  return { db: handle.db, repo, datasetService, sync, clock };
}
```

**`options` 에 `factsPhase?` 를 하나 더 받아 `BrokerSyncService` deps 로 넘기도록 확장한다.** 새 헬퍼를 만들지 말고 이 함수를 넓힌다 — 기존 21개 테스트가 모두 이걸 쓰고 있어서 두 개로 갈라지면 셋업이 두 곳에서 표류한다.

데이터셋은 기존 테스트들이 하는 방식대로 `harness.datasetService.createBrokerDataset(...)` 로 만든다. 봉을 주지 않는 케이스는 `buildHarness(new FakeSource([]))` 로 만든다 — `setupHarness({ candles: [] })` 가 아니다.

`harness.sync.startSync(datasetId, { includeFacts: true })` 를 직접 부르고, 잡 행은 `harness.db.select().from(dataImportJobs).where(eq(dataImportJobs.id, job.id)).get()` 로 읽는다.

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/broker-sync-service.test.ts`
Expected: FAIL — `startSync` 가 두 번째 인자를 받지 않고 `factsPhase` 가 deps 에 없다.

- [ ] **Step 3: 타입과 deps 를 더한다**

`src/server/modules/market-data/application/broker-sync-service.ts` 상단에 추가:

```ts
import { deriveFactYearRange } from '../domain/fact-year-range.js';
```

`BrokerSyncDeps` 위에 타입을 정의한다:

```ts
/** 재무 단계 진행 — 45분짜리 단계가 조용하지 않게 한다 */
export interface FactPhaseProgress {
  readonly symbolsDone: number;
  readonly symbolTotal: number;
  readonly savedFacts: number;
  readonly gapCount: number;
}

export interface FactPhaseResult {
  readonly savedFacts: number;
  readonly gapCount: number;
  readonly stopReason: 'ERROR' | 'CANCELLED' | null;
  readonly failureMessage: string | null;
}

/** data_import_jobs.facts_json 의 내용. null 컬럼 = 재무를 요청하지 않은 잡 */
export interface FactsJobState {
  fromYear: number | null;
  toYear: number | null;
  symbolsDone: number;
  symbolTotal: number;
  savedFacts: number;
  gapCount: number;
  failureMessage: string | null;
  /** 재무 단계를 시작조차 하지 않은 사유 */
  skipReason: string | null;
}
```

`BrokerSyncDeps` 에 추가:

```ts
  /**
   * 재무 수집 단계. market-data 는 facts 모듈을 import 하지 않는다 — 컨테이너가
   * 클로저로 잇는다 (dataset-routes 의 hasActiveBacktests 와 같은 관례).
   * 주입되지 않았으면 DART 가 설정되지 않은 배포다.
   */
  readonly factsPhase?: (args: {
    datasetId: string;
    fromYear: number;
    toYear: number;
    onProgress: (progress: FactPhaseProgress) => void;
    shouldStop: () => boolean;
  }) => Promise<FactPhaseResult>;
```

- [ ] **Step 4: `startSync` 와 `run` 을 바꾼다**

`startSync` 시그니처와 `run` 호출:

```ts
  startSync(
    datasetId: string,
    options: { includeFacts?: boolean } = {},
  ): { job: { id: string }; done: Promise<void> } {
```

잡 INSERT 에 `phase` 를 더한다:

```ts
      .values({
        id: jobId,
        datasetId,
        status: 'RUNNING',
        sourceType: 'BROKER',
        phase: 'CANDLES',
        createdAtMs: this.deps.clock.now(),
      })
```

`run` 호출에 옵션을 넘긴다:

```ts
    const done = this.run(dataset, collect, jobId, options.includeFacts === true).finally(() => {
```

`run` 시그니처와 본문을 바꾼다. 봉 수집 성공 경로(`refreshCoverage` 이후, 잡 COMPLETED 이전)에 재무 단계를 끼운다:

```ts
  private async run(
    dataset: DatasetSummary,
    collect: '1m' | '1d',
    jobId: string,
    includeFacts: boolean,
  ): Promise<void> {
    let totalRows = 0;
    const candlesStartedAtMs = this.deps.clock.now();
    let candlesMs: number | null = null;
    try {
      // ... (기존 봉 수집 루프 그대로 — checkDisk 부터 심볼 루프 끝까지)

      await this.deps.datasetService.refreshCoverage(dataset.id, dataset.market, dataset.timeframe);
      candlesMs = this.deps.clock.now() - candlesStartedAtMs;
      if (totalRows > 0) {
        this.deps.datasetService.bumpVersion(
          dataset.id,
          `broker:${collect}:rows=${totalRows}:${this.deps.clock.now()}`,
          this.deps.clock.now(),
        );
      }

      const factsState = includeFacts ? await this.runFactsPhase(dataset, jobId) : null;

      // 재무 단계가 중단됐으면 잡도 그 상태를 따른다 — 봉 결과(rowsImported)는 남는다.
      // 건너뛴 경우(skipReason)는 중단이 아니다 — 봉은 성공했고 재무는 시작조차 안 했다.
      const factsStopped = factsState !== null && factsState.failureMessage !== null;
      this.deps.db
        .update(dataImportJobs)
        .set({
          status: factsStopped ? (this.cancelRequested.has(jobId) ? 'CANCELLED' : 'FAILED') : 'COMPLETED',
          rowsImported: totalRows,
          candlesMs,
          phase: null,
          ...(factsState ? { factsJson: JSON.stringify(factsState) } : {}),
          ...(factsStopped ? { error: factsState?.failureMessage } : {}),
          completedAtMs: this.deps.clock.now(),
        })
        .where(eq(dataImportJobs.id, jobId))
        .run();
      this.deps.audit.record('system', 'data.sync.completed', {
        datasetId: dataset.id,
        rows: totalRows,
        facts: factsState?.savedFacts ?? 0,
      });
    } catch (error) {
      const cancelled = error instanceof SyncCancelledError;
      this.deps.db
        .update(dataImportJobs)
        .set({
          status: cancelled ? 'CANCELLED' : 'FAILED',
          rowsImported: totalRows,
          candlesMs,
          error: error instanceof Error ? error.message : String(error),
          completedAtMs: this.deps.clock.now(),
        })
        .where(eq(dataImportJobs.id, jobId))
        .run();
      // ... (기존 로깅 그대로)
    }
  }
```

`runFactsPhase` 를 새로 더한다. **취소 상태를 리포트로 되돌리는 방식이라 여기서 throw 하지 않는다** — throw 하면 봉 결과를 기록할 자리가 없어진다:

```ts
  /**
   * 재무 단계. 봉 단계가 성공한 뒤에만 불린다.
   *
   * 여기서 throw 하지 않는 이유: 봉 수집은 이미 끝났고 그 결과(rowsImported)를
   * 기록해야 한다. 재무 실패를 예외로 올리면 catch 절이 봉 결과를 덮어 "봉도 실패"
   * 처럼 보인다 — 상태를 리포트로 되돌려 호출부가 둘을 함께 기록하게 한다.
   */
  private async runFactsPhase(
    dataset: DatasetSummary,
    jobId: string,
  ): Promise<FactsJobState> {
    const state: FactsJobState = {
      fromYear: null,
      toYear: null,
      symbolsDone: 0,
      symbolTotal: dataset.symbols.length,
      savedFacts: 0,
      gapCount: 0,
      failureMessage: null,
      skipReason: null,
    };

    if (!this.deps.factsPhase) {
      state.skipReason = 'DART_API_KEY 가 설정되지 않아 재무를 수집하지 않았습니다.';
      return state;
    }

    const coverage = this.deps.datasetService.getCoverage(dataset.id);
    const range = deriveFactYearRange(coverage, dataset.market);
    if (range === null) {
      state.skipReason =
        '봉이 수집되지 않아 재무 연도 범위를 정할 수 없습니다 — 봉을 먼저 수집하세요.';
      return state;
    }
    state.fromYear = range.fromYear;
    state.toYear = range.toYear;

    this.deps.db
      .update(dataImportJobs)
      .set({ phase: 'FACTS', factsJson: JSON.stringify(state) })
      .where(eq(dataImportJobs.id, jobId))
      .run();

    const result = await this.deps.factsPhase({
      datasetId: dataset.id,
      fromYear: range.fromYear,
      toYear: range.toYear,
      onProgress: (progress) => {
        state.symbolsDone = progress.symbolsDone;
        state.symbolTotal = progress.symbolTotal;
        state.savedFacts = progress.savedFacts;
        state.gapCount = progress.gapCount;
        // 조용한 45분은 멈춘 것과 구분되지 않는다 — 종목마다 잡을 갱신한다
        this.deps.db
          .update(dataImportJobs)
          .set({ factsJson: JSON.stringify(state) })
          .where(eq(dataImportJobs.id, jobId))
          .run();
      },
      shouldStop: () => this.cancelRequested.has(jobId),
    });

    state.savedFacts = result.savedFacts;
    state.gapCount = result.gapCount;
    state.failureMessage = result.failureMessage;
    return state;
  }
```

`cancelSync` 는 손대지 않는다 — `shouldStop` 이 같은 `cancelRequested` 집합을 읽으므로 봉·재무 두 단계에 그대로 전달된다.

- [ ] **Step 5: 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/broker-sync-service.test.ts`
Expected: PASS (기존 + 새 6개)

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/market-data/application/broker-sync-service.ts tests/unit/broker-sync-service.test.ts
git commit -m "feat(market-data): 동기화 잡에 재무 단계를 붙인다

재무 실패를 예외로 올리지 않는다 — 봉 수집은 이미 끝났고 그 결과를 기록해야
하는데, throw 하면 catch 절이 봉 결과를 덮어 봉도 실패한 것처럼 보인다.
factsPhase 는 컨테이너가 주입하므로 market-data 는 facts 를 import 하지 않는다."
```

---

### Task 7: 라우트·조립·경계 규칙

**Files:**
- Modify: `src/server/modules/market-data/application/dataset-service.ts`
- Modify: `src/server/modules/market-data/presentation/dataset-routes.ts`
- Modify: `src/server/bootstrap/container.ts`
- Modify: `src/server/bootstrap/server.ts:65-72`
- Modify: `.dependency-cruiser.cjs:48-55`
- Test: `tests/unit/candle-sync-estimate.test.ts`

**Interfaces:**
- Consumes: `planFactSync` (Task 1), `SqliteFactCoverageStore` (Task 3), `FactSyncService` (Task 4), `deriveFactYearRange` (Task 5), `FactsJobState`·`FactPhaseResult` (Task 6)
- Produces: `type FactsSyncEstimate`, `interface SyncEstimate`, `DatasetService.getCandleSyncEstimate(datasetId, symbols) => SyncEstimate['candles']`, `registerDatasetRoutes(..., factsSyncEstimator, requireAuth)`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/candle-sync-estimate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DatasetService } from '../../src/server/modules/market-data/application/dataset-service.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { brokerSyncState, dataImportJobs, datasets } from '../../src/server/shared/db/schema.js';

function setup() {
  const database = openDatabase(':memory:');
  database.db
    .insert(datasets)
    .values({
      id: 'ds-1',
      name: 'test',
      market: 'KR',
      timeframe: '1d',
      symbolsJson: JSON.stringify(['005930', '000660']),
      description: null,
      createdAtMs: 1,
      // datasets.updated_at_ms 는 NOT NULL 이다 — 빠뜨리면 insert 가 제약 위반으로 죽는다
      updatedAtMs: 1,
    })
    .run();
  return database;
}

function insertJob(
  database: ReturnType<typeof setup>,
  args: { id: string; createdAtMs: number; candlesMs: number | null; status?: string },
) {
  database.db
    .insert(dataImportJobs)
    .values({
      id: args.id,
      datasetId: 'ds-1',
      status: args.status ?? 'COMPLETED',
      sourceType: 'BROKER',
      createdAtMs: args.createdAtMs,
      completedAtMs: args.createdAtMs + (args.candlesMs ?? 0),
      candlesMs: args.candlesMs,
    })
    .run();
}

function markBackfillDone(database: ReturnType<typeof setup>, symbol: string, atMs: number) {
  database.db
    .insert(brokerSyncState)
    .values({ datasetId: 'ds-1', symbol, backfillDoneAtMs: atMs })
    .run();
}

describe('getCandleSyncEstimate', () => {
  it('백필이 끝나지 않은 종목이 있으면 UNKNOWN 이다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 1_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 2_000, candlesMs: 60_000 });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({ basis: 'UNKNOWN' });
    database.close();
  });

  it('백필 완료 이전에 시작된 잡은 쓰지 않는다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    // 백필을 포함한 실행 — 증분 예상치로 쓰면 과대 추정이 된다
    insertJob(database, { id: 'imp-1', createdAtMs: 1_000, candlesMs: 3_600_000 });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({ basis: 'UNKNOWN' });
    database.close();
  });

  it('백필 완료 이후의 최신 COMPLETED 잡 실측치를 쓴다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 6_000, candlesMs: 60_000 });
    insertJob(database, { id: 'imp-2', createdAtMs: 7_000, candlesMs: 30_000 });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({
      basis: 'LAST_RUN',
      ms: 30_000,
    });
    database.close();
  });

  it('candlesMs 가 없는 옛 잡은 건너뛴다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 6_000, candlesMs: 60_000 });
    insertJob(database, { id: 'imp-2', createdAtMs: 7_000, candlesMs: null });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({
      basis: 'LAST_RUN',
      ms: 60_000,
    });
    database.close();
  });

  it('실패한 잡은 쓰지 않는다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 6_000, candlesMs: 60_000, status: 'FAILED' });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({ basis: 'UNKNOWN' });
    database.close();
  });
});
```

`makeDatasetService(database)` 는 `broker-sync-service.test.ts:126` 과 같은 인자로 만든다:

```ts
function makeDatasetService(database: ReturnType<typeof setup>) {
  const repo = new InMemoryCandleRepository();  // 또는 이 테스트에 필요한 최소 스텁
  const clock = { now: () => Date.UTC(2026, 6, 8, 12, 0) };
  return new DatasetService(database.db, repo, clock, logger, noopAudit);
}
```

`DatasetService` 생성자는 `(db, candleRepository, clock, logger, audit)` 순서다. `logger` 는
`createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }))`, `noopAudit` 은
`{ record: () => {} } as unknown as AuditLogService` — 둘 다 `broker-sync-service.test.ts:23,120`
의 관례를 그대로 옮긴다. `getCandleSyncEstimate` 는 캔들 저장소를 건드리지 않으므로 repo 는
최소 스텁으로 충분하다.

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/candle-sync-estimate.test.ts`
Expected: FAIL — `getCandleSyncEstimate` 가 없다.

- [ ] **Step 3: `DatasetService` 에 추정 타입과 메서드를 더한다**

`src/server/modules/market-data/application/dataset-service.ts` 에 타입과 메서드를 추가한다:

```ts
/** 재무 수집 예상 — facts 모듈이 계산해 이 모듈이 응답에 실어 보낸다 */
export type FactsSyncEstimate =
  | { basis: 'UNSUPPORTED'; reason: string }
  | { basis: 'AFTER_CANDLES' }
  | {
      basis: 'PLANNED';
      fromYear: number;
      toYear: number;
      calls: number;
      estimatedMs: number;
      overDailyLimit: boolean;
    };

export interface SyncEstimate {
  readonly candles: { basis: 'LAST_RUN'; ms: number } | { basis: 'UNKNOWN' };
  readonly facts: FactsSyncEstimate;
}
```

```ts
  /**
   * 봉 수집 예상 소요시간. 계산으로는 안 나온다 — 페이지당 봉 수와 API 보관 깊이를
   * 미리 알 수 없다. 직전 실행의 실측치를 참고치로 쓴다.
   *
   * 두 개의 문턱이 있다. (1) 전 종목이 백필 완료 상태여야 한다 — 첫 백필과 증분은
   * 소요시간이 자릿수로 다르다. (2) 그 잡이 백필 완료 **이후** 에 시작됐어야 한다 —
   * 백필을 포함한 실행의 시간을 증분 예상치로 쓰면 과대 추정이 된다.
   */
  getCandleSyncEstimate(
    datasetId: string,
    symbols: readonly string[],
  ): SyncEstimate['candles'] {
    if (symbols.length === 0) return { basis: 'UNKNOWN' };

    const states = this.db
      .select()
      .from(brokerSyncState)
      .where(eq(brokerSyncState.datasetId, datasetId))
      .all();
    const doneAt = new Map(states.map((state) => [state.symbol, state.backfillDoneAtMs]));

    let latestBackfillMs = 0;
    for (const symbol of symbols) {
      const at = doneAt.get(symbol);
      if (at == null) return { basis: 'UNKNOWN' };
      if (at > latestBackfillMs) latestBackfillMs = at;
    }

    const job = this.db
      .select({ candlesMs: dataImportJobs.candlesMs })
      .from(dataImportJobs)
      .where(
        and(
          eq(dataImportJobs.datasetId, datasetId),
          eq(dataImportJobs.sourceType, 'BROKER'),
          eq(dataImportJobs.status, 'COMPLETED'),
          isNotNull(dataImportJobs.candlesMs),
          gt(dataImportJobs.createdAtMs, latestBackfillMs),
        ),
      )
      .orderBy(desc(dataImportJobs.completedAtMs))
      .limit(1)
      .get();

    if (!job?.candlesMs) return { basis: 'UNKNOWN' };
    return { basis: 'LAST_RUN', ms: job.candlesMs };
  }
```

import 에 `brokerSyncState`, `dataImportJobs` 와 drizzle 연산자 `and`·`gt`·`isNotNull`·`desc` 가 들어 있는지 확인하고 없으면 더한다.

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/candle-sync-estimate.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 라우트를 바꾼다**

`src/server/modules/market-data/presentation/dataset-routes.ts`:

1. `syncSchema` 를 바꾼다:

```ts
const syncSchema = z.object({
  datasetId: z.string().min(1),
  /** 재무(DART)까지 함께 수집할지. 기본은 봉만 */
  includeFacts: z.boolean().optional(),
});
```

2. 함수 시그니처에 추정기를 더한다 (`hasActiveBacktests` 바로 뒤, `requireAuth` 앞):

```ts
  /** 이 데이터셋을 참조하는 활성 백테스트 존재 여부 — 조립부가 backtest 모듈로 연결한다 */
  hasActiveBacktests: (datasetId: string) => boolean,
  /** 재무 수집 예상 — 조립부가 facts 모듈로 연결한다 (market-data 는 facts 를 모른다) */
  factsSyncEstimator: (datasetId: string) => FactsSyncEstimate,
  requireAuth: PreHandler,
```

import 에 타입을 더한다:

```ts
import type { DatasetService, FactsSyncEstimate, SyncEstimate } from '../application/dataset-service.js';
```

3. coverage 응답에 추정을 더한다:

```ts
  app.get('/datasets/:datasetId/coverage', { preHandler: requireAuth }, async (request, reply) => {
    const { datasetId } = request.params as { datasetId: string };
    const dataset = datasetService.getDataset(datasetId);
    if (!dataset) return reply.code(404).send({ error: '데이터셋을 찾을 수 없습니다' });
    const syncEstimate: SyncEstimate = {
      candles: datasetService.getCandleSyncEstimate(datasetId, dataset.symbols),
      facts: factsSyncEstimator(datasetId),
    };
    return {
      coverage: datasetService.getCoverage(datasetId).map((row) => ({
        // ... 기존 매핑 그대로
      })),
      syncEstimate,
      note: '공휴일 캘린더 미반영: 공휴일이 누락 구간으로 보고될 수 있습니다.',
    };
  });
```

4. sync 라우트에서 `includeFacts` 를 선검증한다:

```ts
  app.post('/datasets/sync', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = syncSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'datasetId 가 필요합니다' });
    if (!datasetService.getDataset(parsed.data.datasetId)) {
      return reply.code(404).send({ error: '데이터셋을 찾을 수 없습니다' });
    }
    // 재무 단계는 봉 뒤에 온다 — 여기서 막지 않으면 45분 봉 수집을 끝낸 뒤에야
    // "DART 키가 없습니다" 로 실패한다
    if (parsed.data.includeFacts === true) {
      const estimate = factsSyncEstimator(parsed.data.datasetId);
      if (estimate.basis === 'UNSUPPORTED') {
        return reply.code(400).send({ error: estimate.reason });
      }
    }
    try {
      const { job } = brokerSyncService.startSync(parsed.data.datasetId, {
        includeFacts: parsed.data.includeFacts === true,
      });
      return reply.code(202).send({ job });
    } catch (error) {
      // ... 기존 처리 그대로
    }
  });
```

- [ ] **Step 6: 컨테이너를 조립한다**

`src/server/bootstrap/container.ts`:

1. import 를 더한다 (`SqliteFactCoverageStore` 는 Task 4 가 이미 추가했다):

```ts
import { planFactSync } from '../modules/facts/domain/sync-plan.js';
import { deriveFactYearRange } from '../modules/market-data/domain/fact-year-range.js';
import type { FactsSyncEstimate } from '../modules/market-data/application/dataset-service.js';
```

2. `factCoverageStore`·`factSyncService` 는 Task 4 가 이미 만들어 뒀다. 그 지역 상수를
그대로 쓴다 — 다시 만들지 않는다.

3. `deps` 는 생성 시 고정이므로 `brokerSyncService` 가 만들어질 때 `factsPhase` 가 이미 있어야 한다. **`brokerSyncService` 를 내리지 말고 facts 블록(`factRepository`·`factSource`·`factCoverageStore`·`factSyncService`)을 `brokerSyncService` 생성 앞으로 올린다** — `brokerSyncService.recoverInterrupted()` 호출과 그 로깅이 컨테이너 앞부분에 있어서 서비스 생성을 뒤로 미루면 그 경로가 깨진다. facts 블록이 필요한 것(`duckdb`·`config.dataRoot`·`datasetService`·`clock`·`logger`·`database`)은 모두 `brokerSyncService` 보다 앞에서 만들어지므로 위로 올리는 데 제약이 없다.

그 다음 `factsPhase` 를 정의하고 `brokerSyncService` deps 에 넘긴다:

```ts
  // 재무 단계 — market-data 는 facts 를 import 하지 않는다. 조립부가 잇는다.
  // config.dartApiKey 가 없으면 넘기지 않는다 → BrokerSyncService 가 skipReason 을 남긴다.
  const factsPhase = config.dartApiKey
    ? async (args: {
        datasetId: string;
        fromYear: number;
        toYear: number;
        onProgress: (progress: {
          symbolsDone: number;
          symbolTotal: number;
          savedFacts: number;
          gapCount: number;
        }) => void;
        shouldStop: () => boolean;
      }) => {
        const dataset = datasetService.getDataset(args.datasetId);
        const symbols = dataset?.symbols ?? [];
        let savedFacts = 0;
        let gapCount = 0;
        const report = await factSyncService.sync(
          {
            datasetId: args.datasetId,
            symbols,
            fromYear: args.fromYear,
            toYear: args.toYear,
            // 웹은 증분이다 — 매번 전 구간을 다시 받으면 45분짜리 버튼이 된다.
            // 과거 연도 정정공시 전체 재수집은 CLI(facts:sync --from --to)가 담당한다.
            consolidated: true,
            mode: 'INCREMENTAL',
          },
          {
            shouldStop: args.shouldStop,
            onSymbolDone: (progress) => {
              savedFacts += progress.savedFacts;
              gapCount += progress.gapCount;
              args.onProgress({
                symbolsDone: progress.index,
                symbolTotal: progress.total,
                savedFacts,
                gapCount,
              });
            },
          },
        );
        return {
          savedFacts: report.savedFacts,
          gapCount: report.gaps.length,
          stopReason: report.stopReason,
          failureMessage: report.failureMessage,
        };
      }
    : undefined;
```

그리고 `brokerSyncService` 의 deps 에 `...(factsPhase ? { factsPhase } : {})` 를 더한다.

4. 추정기를 만든다:

```ts
  /**
   * 재무 수집 예상. 실행 경로(BrokerSyncService → factsPhase)와 **같은 두 함수** 를
   * 부른다 — deriveFactYearRange 로 연도를, planFactSync 로 호출 수·시간을. 갈라지면
   * 화면의 숫자만 조용히 틀려진다.
   */
  const factsSyncEstimator = (datasetId: string): FactsSyncEstimate => {
    if (!config.dartApiKey) {
      return { basis: 'UNSUPPORTED', reason: 'DART_API_KEY 가 설정되지 않았습니다.' };
    }
    const dataset = datasetService.getDataset(datasetId);
    if (!dataset) return { basis: 'UNSUPPORTED', reason: '데이터셋을 찾을 수 없습니다.' };
    if (dataset.market !== 'KR') {
      return { basis: 'UNSUPPORTED', reason: 'DART 재무 수집은 KR 시장 데이터셋만 지원합니다.' };
    }
    const range = deriveFactYearRange(datasetService.getCoverage(datasetId), dataset.market);
    if (range === null) return { basis: 'AFTER_CANDLES' };

    const plan = planFactSync({
      symbols: dataset.symbols,
      fromYear: range.fromYear,
      toYear: range.toYear,
      currentYear: new Date(clock.now()).getUTCFullYear(),
      coveredBySymbol: factCoverageStore.getCoveredYears(datasetId),
      mode: 'INCREMENTAL',
    });
    return {
      basis: 'PLANNED',
      fromYear: range.fromYear,
      toYear: range.toYear,
      calls: plan.calls,
      estimatedMs: plan.estimatedMs,
      overDailyLimit: plan.overDailyLimit,
    };
  };
```

5. `Container` 인터페이스와 반환 객체에 `factsSyncEstimator` 를 더한다:

```ts
  readonly factsSyncEstimator: (datasetId: string) => FactsSyncEstimate;
```

- [ ] **Step 7: 서버 조립에 전달한다**

`src/server/bootstrap/server.ts`:

```ts
      registerDatasetRoutes(
        api,
        container.datasetService,
        container.brokerSyncService,
        container.symbolInfoService,
        (datasetId) => container.jobQueue.activeCountForDataset(datasetId) > 0,
        container.factsSyncEstimator,
        requireAuth,
      );
```

- [ ] **Step 8: 경계 규칙을 더한다**

`.dependency-cruiser.cjs` — `market-data-no-broker` 규칙 바로 뒤에 추가:

```js
    {
      name: 'market-data-no-facts',
      severity: 'error',
      comment:
        'market-data → facts 금지 (§7) — 조립부가 factsPhase·factsSyncEstimator 클로저로 잇는다',
      from: { path: 'src/server/modules/market-data' },
      to: { path: 'src/server/modules/facts' },
    },
```

- [ ] **Step 9: 전체 검증**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 전부 PASS. `tests/architecture/module-boundaries.test.ts` 가 새 규칙 위반이 없음을 확인한다 — 위반이 나오면 `market-data` 안에 facts import 가 남아 있다는 뜻이므로 해당 import 를 조립부 클로저로 옮긴다.

- [ ] **Step 10: 커밋**

```bash
git add src/server/modules/market-data/application/dataset-service.ts src/server/modules/market-data/presentation/dataset-routes.ts src/server/bootstrap/container.ts src/server/bootstrap/server.ts .dependency-cruiser.cjs tests/unit/candle-sync-estimate.test.ts
git commit -m "feat(api): 재무 포함 동기화와 예상 소요시간 응답

추정 경로가 실행 경로와 같은 두 함수(deriveFactYearRange, planFactSync)를 쓴다.
includeFacts 는 라우트에서 선검증한다 — 재무는 봉 뒤에 오므로 여기서 막지
않으면 45분 봉 수집을 끝낸 뒤에야 DART 키 부재로 실패한다.
market-data-no-facts 경계 규칙으로 모듈 방향을 강제한다."
```

---

### Task 8: Checkbox 프리미티브

**Files:**
- Create: `src/web/components/ui/checkbox.tsx`

**Interfaces:**
- Consumes: `radix-ui` 통합 패키지, `@/lib/utils` 의 `cn`
- Produces: `Checkbox` (props = `React.ComponentProps<typeof CheckboxPrimitive.Root>`)

- [ ] **Step 1: 컴포넌트를 만든다**

기존 프리미티브(`tooltip.tsx`)와 같은 관례를 따른다: `radix-ui` 통합 패키지에서 named import, `data-slot` 속성, `cn` 병합.

`src/web/components/ui/checkbox.tsx`:

```tsx
import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <Check className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
```

- [ ] **Step 2: 빌드가 되는 것을 확인한다**

Run: `pnpm typecheck && pnpm build:web`
Expected: PASS. `radix-ui` 에 `Checkbox` export 가 없다는 오류가 나면 설치된 버전을 확인한다: `node -e "console.log(Object.keys(require('radix-ui')))"` — 없으면 `pnpm add @radix-ui/react-checkbox` 후 import 를 `import * as CheckboxPrimitive from "@radix-ui/react-checkbox"` 로 바꾼다.

- [ ] **Step 3: 커밋**

```bash
git add src/web/components/ui/checkbox.tsx package.json pnpm-lock.yaml
git commit -m "feat(web): Checkbox 프리미티브 추가"
```

---

### Task 9: 데이터셋 카드 — 재무 체크박스·툴팁·예상 시간

**Files:**
- Modify: `src/web/features/datasets/datasets-page.tsx`

**Interfaces:**
- Consumes: `Checkbox` (Task 8), `SyncEstimate` 응답 (Task 7), `Tooltip*` (`@/components/ui/tooltip`)
- Produces: 없음 (UI 말단)

- [ ] **Step 1: 응답 타입과 포맷 헬퍼를 더한다**

`src/web/features/datasets/datasets-page.tsx` 상단의 타입 선언 근처에 추가:

```tsx
type FactsSyncEstimate =
  | { basis: 'UNSUPPORTED'; reason: string }
  | { basis: 'AFTER_CANDLES' }
  | {
      basis: 'PLANNED';
      fromYear: number;
      toYear: number;
      calls: number;
      estimatedMs: number;
      overDailyLimit: boolean;
    };

interface SyncEstimate {
  candles: { basis: 'LAST_RUN'; ms: number } | { basis: 'UNKNOWN' };
  facts: FactsSyncEstimate;
}

interface FactsJobState {
  fromYear: number | null;
  toYear: number | null;
  symbolsDone: number;
  symbolTotal: number;
  savedFacts: number;
  gapCount: number;
  failureMessage: string | null;
  skipReason: string | null;
}

/** ms → "약 5분" / "약 1시간 12분". 1분 미만은 "1분 미만" */
function formatEstimate(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '1분 미만';
  if (minutes < 60) return `약 ${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `약 ${hours}시간` : `약 ${hours}시간 ${rest}분`;
}

/** 연도 범위 표기 — 한 해면 "2026년 갱신", 여러 해면 "2019~2026년" */
function formatYearRange(fromYear: number, toYear: number): string {
  return fromYear === toYear ? `${fromYear}년 갱신` : `${fromYear}~${toYear}년`;
}
```

- [ ] **Step 2: `DataJob` 타입과 coverage 쿼리를 넓힌다**

`DataJob` 인터페이스(파일 상단, `rowsImported`·`error` 가 있는 것)에 필드를 더한다:

```tsx
  phase: string | null;
  candlesMs: number | null;
  factsJson: string | null;
```

`DatasetCard` 안의 coverage 쿼리 타입을 바꾼다:

```tsx
  const { data } = useQuery({
    queryKey: ['datasets', dataset.id, 'coverage'],
    queryFn: () =>
      api<{ coverage: CoverageRow[]; syncEstimate: SyncEstimate; note: string }>(
        `/datasets/${dataset.id}/coverage`,
      ),
  });
```

- [ ] **Step 3: 체크박스 상태와 mutation 을 바꾼다**

`DatasetCard` 안의 상태 선언에 추가:

```tsx
  // 기본 해제이고 기억하지 않는다 — 저장하면 데이터셋을 갱신할 때마다 의도 없이
  // 45분짜리 재무 수집이 걸린다
  const [includeFacts, setIncludeFacts] = useState(false);
```

`syncMutation` 을 바꾼다:

```tsx
  const syncMutation = useMutation({
    mutationFn: () =>
      postJson<{ job: { id: string } }>('/datasets/sync', {
        datasetId: dataset.id,
        includeFacts,
      }),
    onSuccess: ({ job }) => setStartedJobId(job.id),
    onError: (error: unknown) => toast.error(errorMessage(error, '동기화 시작 실패')),
  });
```

- [ ] **Step 4: 완료 토스트에 재무 결과를 싣는다**

`useEffect` 안의 완료 분기를 바꾼다:

```tsx
  useEffect(() => {
    const job = syncJob.data?.job;
    if (!job || syncJobId === null) return;
    const facts: FactsJobState | null = job.factsJson
      ? (JSON.parse(job.factsJson) as FactsJobState)
      : null;
    if (job.status === 'COMPLETED') {
      const factsPart =
        facts === null
          ? ''
          : ` · 재무 ${facts.savedFacts}건${facts.gapCount > 0 ? ` (누락 ${facts.gapCount}건)` : ''}`;
      toast.success(`동기화 완료: ${dataset.name} · ${job.rowsImported ?? 0}봉${factsPart}`);
      // 재무를 요청했는데 건너뛴 경우는 성공 토스트만으로는 드러나지 않는다 —
      // 사용자는 재무를 받았다고 믿는다
      if (facts?.skipReason) toast.warning(`재무 미수집: ${facts.skipReason}`);
    } else if (job.status === 'FAILED') {
      toast.error(`동기화 실패: ${job.error ?? '원인 미상'}`);
    } else if (job.status === 'CANCELLED') {
      toast.info(`동기화 취소됨: ${dataset.name} — 재실행 시 이어받습니다`);
    } else {
      return; // 진행 중 — 계속 폴링
    }
    setStartedJobId(null);
    void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    void queryClient.invalidateQueries({ queryKey: ['datasets', dataset.id, 'coverage'] });
  }, [syncJob.data, syncJobId, dataset.name, dataset.id, queryClient]);
```

- [ ] **Step 5: 체크박스·툴팁을 헤더에 넣는다**

import 를 더한다:

```tsx
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Info } from 'lucide-react';
```

헤더의 `<span className="ml-auto flex gap-2">` 안, 동기화 버튼 **앞** 에 넣는다:

```tsx
          <span className="ml-auto flex items-center gap-2">
            {syncJobId === null ? (
              <span className="flex items-center gap-1.5">
                <Checkbox
                  id={`facts-${dataset.id}`}
                  checked={includeFacts}
                  // 추정을 아직 못 받았으면 잠가 둔다 — 열어 두면 UNSUPPORTED 데이터셋에서
                  // 체크가 가능해지고, 라우트가 400 으로 막을 때까지 알 수 없다
                  disabled={factsEstimate === undefined || factsEstimate.basis === 'UNSUPPORTED'}
                  onCheckedChange={(checked) => setIncludeFacts(checked === true)}
                />
                <label
                  htmlFor={`facts-${dataset.id}`}
                  className="text-sm text-muted-foreground"
                >
                  재무
                </label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label="재무 함께 수집 설명">
                      <Info className="size-3.5 text-muted-foreground" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="end" className="max-w-xs flex-col items-start gap-1">
                    <span>이 데이터셋 종목의 재무제표까지 함께 받습니다.</span>
                    {/* 미지원일 때만 띄우면 KR 데이터셋에서는 "재무가 국내 전용" 이라는
                        사실이 아예 드러나지 않는다 — 항상 보인다 */}
                    <span>국내(KR) 종목만 가능합니다 — DART 는 국내 공시 기관입니다.</span>
                    <span>봉만 받는 것보다 오래 걸립니다 — 아래 예상 시간을 확인하세요.</span>
                    {factsEstimate?.basis === 'UNSUPPORTED' ? (
                      <span className="text-destructive">{factsEstimate.reason}</span>
                    ) : null}
                  </TooltipContent>
                </Tooltip>
              </span>
            ) : null}
            {/* ... 기존 동기화/취소·삭제 버튼 그대로 ... */}
          </span>
```

`factsEstimate` 를 렌더 앞에서 뽑는다:

```tsx
  const syncEstimate = data?.syncEstimate;
  const factsEstimate = syncEstimate?.facts;
```

- [ ] **Step 6: 예상 시간 줄과 진행 표시를 넣는다**

`<CardContent className="space-y-3 text-sm">` 의 맨 앞(종목 목록 map 앞)에 넣는다:

```tsx
        {syncJobId !== null ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {syncJob.data?.job.phase === 'FACTS' ? (() => {
              const facts: FactsJobState | null = syncJob.data?.job.factsJson
                ? (JSON.parse(syncJob.data.job.factsJson) as FactsJobState)
                : null;
              return facts
                ? `재무 수집 중 · ${facts.symbolsDone}/${facts.symbolTotal}종목 · ${facts.savedFacts}건`
                : '재무 수집 중…';
            })() : '봉 수집 중…'}
          </p>
        ) : syncEstimate ? (
          <p className={cn('text-xs', factsEstimate?.basis === 'PLANNED' && factsEstimate.overDailyLimit ? 'text-destructive' : 'text-muted-foreground')}>
            {syncEstimate.candles.basis === 'LAST_RUN'
              ? `봉 ${formatEstimate(syncEstimate.candles.ms)} (직전 실행 기준)`
              : '첫 수집은 소요 시간을 예측할 수 없습니다'}
            {includeFacts && factsEstimate?.basis === 'PLANNED'
              ? ` + 재무 ${formatYearRange(factsEstimate.fromYear, factsEstimate.toYear)} · ${formatEstimate(factsEstimate.estimatedMs)}`
              : ''}
            {includeFacts && factsEstimate?.basis === 'AFTER_CANDLES'
              ? ' + 재무 범위는 봉 수집 후 결정됩니다'
              : ''}
            {includeFacts && factsEstimate?.basis === 'PLANNED' && factsEstimate.overDailyLimit
              ? ' · DART 일일 한도(40,000회)를 넘습니다 — 남은 구간은 다음 날 이어받으세요'
              : ''}
          </p>
        ) : null}
```

`cn` 이 import 되어 있지 않으면 `import { cn } from '@/lib/utils';` 를 더한다.

- [ ] **Step 7: 확인한다**

Run: `pnpm typecheck && pnpm lint && pnpm build:web`
Expected: PASS

수동 확인: `pnpm dev` + `pnpm dev:web` 으로 띄워 데이터셋 카드에서
(1) 체크박스를 켜고 끄면 예상 시간 줄이 바뀌는지,
(2) ⓘ 에 hover 하면 툴팁 두 줄이 뜨는지,
(3) DART 키가 없는 환경(`.env` 에서 `DART_API_KEY` 제거)에서 체크박스가 disabled 되고 툴팁에 이유가 뜨는지.

- [ ] **Step 8: 커밋**

```bash
git add src/web/features/datasets/datasets-page.tsx
git commit -m "feat(web): 동기화에 재무 체크박스와 예상 소요시간

체크 상태는 기억하지 않는다 — 저장하면 데이터셋을 갱신할 때마다 의도 없이
45분짜리 재무 수집이 걸린다. 재무를 건너뛴 경우는 성공 토스트만으로 드러나지
않으므로 경고 토스트를 따로 띄운다."
```

---

### Task 10: 종목 표기 순수 함수

**Files:**
- Create: `src/web/features/backtests/symbol-summary.ts`
- Test: `tests/unit/symbol-summary.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `SYMBOL_SUMMARY_LIMIT`, `formatSymbolLabel(symbol, name) => string`, `formatSymbolSummary(symbols, nameOf, limit?) => string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/symbol-summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  formatSymbolLabel,
  formatSymbolSummary,
} from '../../src/web/features/backtests/symbol-summary.js';

const NAMES: Record<string, string> = {
  '005930': '삼성전자',
  '000660': 'SK하이닉스',
  '035720': '카카오',
  '035420': 'NAVER',
  '373220': 'LG에너지솔루션',
  '267260': 'HD현대일렉트릭',
};
const nameOf = (symbol: string): string | null => NAMES[symbol] ?? null;

describe('formatSymbolLabel', () => {
  it('이름이 있으면 "이름 (코드)" 다', () => {
    expect(formatSymbolLabel('005930', '삼성전자')).toBe('삼성전자 (005930)');
  });

  it('이름이 없으면 코드만이다 — 빈 괄호를 만들지 않는다', () => {
    expect(formatSymbolLabel('005930', null)).toBe('005930');
  });

  it('빈 문자열 이름도 코드만으로 다룬다', () => {
    expect(formatSymbolLabel('005930', '')).toBe('005930');
  });
});

describe('formatSymbolSummary', () => {
  it('빈 배열은 빈 문자열이다', () => {
    expect(formatSymbolSummary([], nameOf)).toBe('');
  });

  it('상한 이하면 전부 나열하고 접미사가 없다', () => {
    expect(formatSymbolSummary(['005930', '000660'], nameOf)).toBe(
      '삼성전자 (005930), SK하이닉스 (000660)',
    );
  });

  it('정확히 상한이면 접미사가 없다', () => {
    const five = ['005930', '000660', '035720', '035420', '373220'];
    const result = formatSymbolSummary(five, nameOf);
    expect(result).not.toContain('외');
    expect(result.split(', ')).toHaveLength(5);
  });

  it('상한을 넘으면 앞 5개 + "외 N종목" 이다', () => {
    const six = ['005930', '000660', '035720', '035420', '373220', '267260'];
    expect(formatSymbolSummary(six, nameOf)).toBe(
      '삼성전자 (005930), SK하이닉스 (000660), 카카오 (035720), NAVER (035420), LG에너지솔루션 (373220) 외 1종목',
    );
  });

  it('200종목이면 나머지를 개수로 접는다', () => {
    const many = Array.from({ length: 200 }, (_, index) => String(index).padStart(6, '0'));
    expect(formatSymbolSummary(many, nameOf)).toContain('외 195종목');
  });

  it('이름을 모르는 항목은 코드만 쓴다', () => {
    expect(formatSymbolSummary(['005930', '999999'], nameOf)).toBe('삼성전자 (005930), 999999');
  });

  it('전부 이름을 모르면 코드만 나열한다', () => {
    expect(formatSymbolSummary(['999999', '888888'], () => null)).toBe('999999, 888888');
  });

  it('limit 을 조정할 수 있다', () => {
    expect(formatSymbolSummary(['005930', '000660', '035720'], nameOf, 1)).toBe(
      '삼성전자 (005930) 외 2종목',
    );
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/symbol-summary.test.ts`
Expected: FAIL — `Failed to resolve import ".../symbol-summary.js"`

- [ ] **Step 3: 구현한다**

`src/web/features/backtests/symbol-summary.ts`:

```ts
/**
 * 종목 표기 규칙의 단일 출처.
 *
 * 코드를 외우고 있는 사람만 결과를 읽을 수 있으면 안 된다 — 이름을 주로, 코드를
 * 괄호에 둔다. 형식을 한 가지로 통일하는 이유는 자리마다 다르면 규칙도 테스트도
 * 둘이 되기 때문이다.
 *
 * 렌더링(잘림 처리)은 `components/symbol-label.tsx` 가 맡는다. 이 파일은 문자열만
 * 다루므로 컴포넌트 테스트 환경 없이 단위 테스트할 수 있다.
 */

/** Description 에 나열할 종목 수. 200종목을 다 나열하면 화면 여러 줄을 잡아먹는다 */
export const SYMBOL_SUMMARY_LIMIT = 5;

/** '삼성전자 (005930)' / 이름을 모르면 '005930' — 빈 괄호를 만들지 않는다 */
export function formatSymbolLabel(symbol: string, name: string | null): string {
  return name ? `${name} (${symbol})` : symbol;
}

/**
 * 앞 `limit` 개를 나열하고 나머지는 개수로 접는다. 전체 목록은 거래 내역의 종목
 * 필터와 종목별 성과 표에 있으므로 여기서 잃어도 접근성이 사라지지 않는다.
 */
export function formatSymbolSummary(
  symbols: readonly string[],
  nameOf: (symbol: string) => string | null,
  limit = SYMBOL_SUMMARY_LIMIT,
): string {
  if (symbols.length === 0) return '';
  const shown = symbols
    .slice(0, limit)
    .map((symbol) => formatSymbolLabel(symbol, nameOf(symbol)))
    .join(', ');
  const rest = symbols.length - limit;
  return rest > 0 ? `${shown} 외 ${rest}종목` : shown;
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/symbol-summary.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/backtests/symbol-summary.ts tests/unit/symbol-summary.test.ts
git commit -m "feat(web): 종목 표기 규칙을 순수 함수로 뽑는다

'이름 (코드)' 한 가지 형식만 쓴다 — 자리마다 다르면 규칙도 테스트도 둘이 된다.
Description 은 앞 5개만 나열한다."
```

---

### Task 11: 공유 훅 승격 + SymbolLabel 컴포넌트

**Files:**
- Create: `src/web/lib/use-stock-names.ts`
- Create: `src/web/components/symbol-label.tsx`
- Modify: `src/web/features/datasets/datasets-page.tsx:64-86`

**Interfaces:**
- Consumes: `formatSymbolLabel` (Task 10), `api` (`@/lib/api-client`)
- Produces: `interface StockInfo`, `useStockNames(symbols) => ReadonlyMap<string, StockInfo>`, `SymbolLabel({ symbol, name, className })`

- [ ] **Step 1: 훅을 옮긴다**

`src/web/lib/use-stock-names.ts` 를 만든다 — `datasets-page.tsx:64-86` 의 내용을 그대로 옮긴다:

```ts
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface StockInfo {
  symbol: string;
  name: string;
  englishName: string | null;
  market: string;
  status: string;
}

/**
 * 코드 → 종목정보. 소스 미설정이면 빈 Map 이라 코드만 표시된다 —
 * `SymbolInfoService` 는 소스 미설정을 에러가 아니라 빈 결과로 다룬다.
 */
export function useStockNames(symbols: readonly string[]): ReadonlyMap<string, StockInfo> {
  const key = symbols.join(',');
  const { data } = useQuery({
    queryKey: ['symbol-info', key],
    queryFn: () => api<{ stocks: StockInfo[] }>(`/symbols/info?symbols=${encodeURIComponent(key)}`),
    enabled: symbols.length > 0,
    staleTime: 60 * 60 * 1000, // 종목명은 사실상 불변
  });
  return new Map(data?.stocks.map((stock) => [stock.symbol, stock]) ?? []);
}
```

- [ ] **Step 2: `datasets-page.tsx` 를 import 로 바꾼다**

`interface StockInfo {...}` 와 `function useStockNames(...) {...}` 두 블록을 지우고 import 를 더한다:

```tsx
import { useStockNames, type StockInfo } from '@/lib/use-stock-names';
```

`useSymbolPreview` 는 그대로 둔다 — 데이터셋 입력 확인 전용이라 옮길 이유가 없다. 이 함수가 `StockInfo` 를 참조하므로 위 import 의 타입이 그것을 만족한다.

- [ ] **Step 3: `SymbolLabel` 을 만든다**

`src/web/components/symbol-label.tsx`:

```tsx
import { cn } from '@/lib/utils';

/**
 * `이름 (코드)` 렌더. **코드는 절대 잘리지 않는다.**
 *
 * 이름 쪽만 `truncate` + `max-w-40` 으로 줄어들고, 코드 쪽은 `shrink-0` 으로 flex
 * 축소 대상에서 빠진다 — 코드가 잘리면 종목을 식별할 유일한 수단이 사라진다.
 * 문자 수로 자르는 방식은 한글·영문 혼용 이름(`HD현대일렉트릭`)에서 실제 픽셀 폭과
 * 어긋나므로 쓰지 않는다.
 *
 * 같은 규칙의 문자열 버전이 `features/backtests/symbol-summary.ts` 의
 * `formatSymbolLabel` 이다 — 그쪽은 문단용(줄바꿈), 이쪽은 표용(잘림)이라 형태가
 * 다르다. 규칙이 갈리지 않는지는 두 곳의 "이름 없으면 코드만" 분기로 확인한다:
 * `formatSymbolLabel` 이 단위 테스트로 그 분기를 지킨다.
 */
export function SymbolLabel({
  symbol,
  name,
  className,
}: {
  symbol: string;
  name: string | null;
  className?: string;
}) {
  if (!name) return <span className={className}>{symbol}</span>;
  return (
    <span className={cn('flex items-baseline gap-1', className)}>
      <span className="max-w-40 truncate" title={name}>
        {name}
      </span>
      <span className="shrink-0 text-muted-foreground">({symbol})</span>
    </span>
  );
}
```

- [ ] **Step 4: 확인한다**

Run: `pnpm typecheck && pnpm lint && pnpm build:web && pnpm vitest run tests/unit/symbol-summary.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/web/lib/use-stock-names.ts src/web/components/symbol-label.tsx src/web/features/datasets/datasets-page.tsx
git commit -m "refactor(web): 종목명 훅을 공유 위치로 올리고 SymbolLabel 을 만든다

코드가 안 잘리는 근거는 shrink-0 이다 — 이름 쪽만 축소·생략되고 코드는 flex
축소 대상에서 빠진다."
```

---

### Task 12: 백테스트 화면에 종목명 적용

**Files:**
- Modify: `src/web/features/backtests/backtest-detail-page.tsx`
- Modify: `src/web/features/backtests/backtests-page.tsx`
- Modify: `tests/e2e/mvp-flow.spec.ts`

**Interfaces:**
- Consumes: `useStockNames`·`StockInfo` (Task 11), `SymbolLabel` (Task 11), `formatSymbolSummary`·`SYMBOL_SUMMARY_LIMIT` (Task 10)
- Produces: 없음 (UI 말단)

- [ ] **Step 1: 상세 페이지에 훅을 연결한다**

`src/web/features/backtests/backtest-detail-page.tsx` — import 를 더한다:

```tsx
import { SymbolLabel } from '@/components/symbol-label';
import { useStockNames } from '@/lib/use-stock-names';
import { formatSymbolSummary } from './symbol-summary';
```

페이지 컴포넌트 안(`job` 을 얻은 뒤)에서 이름을 한 번 조회한다:

```tsx
  // 전 종목을 한 번에 조회한다 — 거래 내역·종목별 성과·Description 이 같은 Map 을
  // 쓴다. 데이터셋 심볼 상한이 1,000 이라 /symbols/info 상한을 넘지 않는다.
  const stockNames = useStockNames(job?.request.universe.symbols ?? []);
  const nameOf = (symbol: string): string | null => stockNames.get(symbol)?.name ?? null;
```

- [ ] **Step 2: Description 을 바꾼다**

`backtest-detail-page.tsx:465-468` 을 교체:

```tsx
      <p className="text-sm text-muted-foreground">
        {formatSymbolSummary(job.request.universe.symbols, nameOf)} · {job.request.period.from} ~{' '}
        {job.request.period.to} · 생성 {formatDateTime(job.createdAtMs)}
      </p>
```

- [ ] **Step 3: 종목별 성과 표를 바꾼다**

`backtest-detail-page.tsx:539` 를 교체:

```tsx
                            <TableCell>
                              <SymbolLabel symbol={row.symbol} name={nameOf(row.symbol)} />
                            </TableCell>
```

- [ ] **Step 4: `TradesSection` 에 이름을 넘긴다**

`TradesSection` props 에 `nameOf` 를 더한다:

```tsx
function TradesSection({
  jobId,
  symbols,
  run,
  periodTo,
  nameOf,
}: {
  jobId: string;
  symbols: string[];
  run: RunMetadata | null;
  periodTo: string;
  nameOf: (symbol: string) => string | null;
}) {
```

호출부(`backtest-detail-page.tsx:561-566`)에 넘긴다:

```tsx
          <TradesSection
            jobId={id}
            symbols={job.request.universe.symbols}
            run={run ?? null}
            periodTo={job.request.period.to}
            nameOf={nameOf}
          />
```

- [ ] **Step 5: 거래 내역의 세 자리를 바꾼다**

종목 필터 (`:122-133`) — 트리거를 넓히고 항목에 이름을 넣는다. **`value` 는 코드를 유지한다** — 표시만 바뀌고 `?symbol=` 쿼리는 그대로다:

```tsx
          <SelectTrigger className="h-9 w-56" aria-label="종목 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">전체 종목</SelectItem>
            {symbols.map((s) => (
              <SelectItem key={s} value={s}>
                <SymbolLabel symbol={s} name={nameOf(s)} />
              </SelectItem>
            ))}
          </SelectContent>
```

미청산 행 (`:158`):

```tsx
                    <TableCell className="font-medium">
                      <SymbolLabel symbol={row.symbol} name={nameOf(row.symbol)} />
                    </TableCell>
```

체결 행 (`:188`):

```tsx
                    <TableCell className="font-medium">
                      <SymbolLabel symbol={trade.symbol} name={nameOf(trade.symbol)} />
                    </TableCell>
```

- [ ] **Step 6: 목록 페이지를 바꾼다**

`src/web/features/backtests/backtests-page.tsx` — import 를 더한다:

```tsx
import { useStockNames } from '@/lib/use-stock-names';
import { formatSymbolSummary, SYMBOL_SUMMARY_LIMIT } from './symbol-summary';
```

목록 컴포넌트(카드를 map 하는 쪽)에서 **표시할 앞 5개씩만** 모아 한 번 조회한다:

```tsx
  // 카드마다 훅을 부르면 카드 수만큼 요청이 난다. 전체 심볼 합집합은
  // /symbols/info 의 1,000개 상한에 걸릴 수 있다 — 어차피 5개만 표시하므로
  // 상한이 (5 × 페이지당 잡 수)로 묶인다.
  const previewSymbols = [
    ...new Set(
      (jobs ?? []).flatMap((job) => job.request.universe.symbols.slice(0, SYMBOL_SUMMARY_LIMIT)),
    ),
  ];
  const stockNames = useStockNames(previewSymbols);
  const nameOf = (symbol: string): string | null => stockNames.get(symbol)?.name ?? null;
```

**실제 파일 구조 (확인됨):** `backtests-page.tsx:12` 의 `JobCard({ job }: { job: JobSummary })` 가 분리된 컴포넌트이고, `BacktestsPage`(`:58`)가 `useBacktests(5_000)` 의 결과를 `data.jobs.map(...)`(`:79`)으로 돈다.

따라서 훅은 `BacktestsPage` 안에서 부르고 `data.jobs` 를 쓴다:

```tsx
  const previewSymbols = [
    ...new Set(
      (data?.jobs ?? []).flatMap((job) =>
        job.request.universe.symbols.slice(0, SYMBOL_SUMMARY_LIMIT),
      ),
    ),
  ];
  const stockNames = useStockNames(previewSymbols);
  const nameOf = (symbol: string): string | null => stockNames.get(symbol)?.name ?? null;
```

`data` 는 `isLoading` 동안 undefined 이므로 `?? []` 로 받는다 — 훅은 빈 배열이면 요청하지 않는다.

`nameOf` 를 `JobCard` 의 prop 으로 넘긴다:

```tsx
function JobCard({ job, nameOf }: { job: JobSummary; nameOf: (symbol: string) => string | null }) {
```

```tsx
          {data.jobs.map((job) => (
            <JobCard key={job.id} job={job} nameOf={nameOf} />
          ))}
```

`key` 등 기존 props 는 실제 코드의 것을 그대로 유지한다.

`backtests-page.tsx:31` 을 교체:

```tsx
          <div className="text-xs text-muted-foreground">
            {formatSymbolSummary(job.request.universe.symbols, nameOf)} · {job.request.period.from} ~{' '}
            {job.request.period.to}
          </div>
```

- [ ] **Step 7: e2e 에 확인을 더한다**

`tests/e2e/mvp-flow.spec.ts` 의 결과 화면 검증 구간(거래 필터를 다루는 부분)에 추가한다. 픽스처가 어떤 종목을 쓰는지 확인하고 그 코드를 쓴다:

```ts
  // 종목 표기: 이름을 알면 '이름 (코드)', 모르면 코드만. 어느 쪽이든 코드는 온전하다.
  const symbolCell = page.getByRole('cell', { name: /005930/ }).first();
  await expect(symbolCell).toContainText('005930');

  // 종목 필터의 value 는 코드다 — 표시가 바뀌어도 필터가 동작해야 한다
  await page.getByLabel('종목 필터').click();
  await page.getByRole('option', { name: /005930/ }).click();
  await expect(page.getByRole('cell', { name: /005930/ }).first()).toBeVisible();
```

- [ ] **Step 8: 확인한다**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS

Run: `pnpm test:e2e`
Expected: PASS. 실패하면 픽스처의 종목 코드가 다른 것이므로 e2e 의 코드를 실제 픽스처에 맞춘다.

수동 확인: 백테스트 결과 화면에서 (1) 종목명이 주로 뜨고 코드가 괄호에 있는지, (2) 긴 이름에서 이름만 `…` 로 줄고 코드가 온전한지, (3) 종목 필터가 여전히 동작하는지.

- [ ] **Step 9: 커밋**

```bash
git add src/web/features/backtests/backtest-detail-page.tsx src/web/features/backtests/backtests-page.tsx tests/e2e/mvp-flow.spec.ts
git commit -m "feat(web): 백테스트 화면에 종목명을 주로 표시한다

Description·거래 내역(종목 열·필터)·종목별 성과·목록 카드 전부. 필터의 value 는
코드를 유지해 서버 API 를 건드리지 않는다. 목록은 표시할 앞 5개씩만 조회해
카드 수만큼 요청이 나지 않게 한다."
```

---

### Task 13: 지원 시장 단일 출처 + `GET /markets`

**Files:**
- Modify: `src/server/modules/market-data/domain/candle.ts:1`
- Modify: `src/server/modules/market-data/domain/exchange-session.ts:16-33`
- Create: `src/server/modules/market-data/domain/market-support.ts`
- Modify: `src/server/modules/market-data/presentation/dataset-routes.ts`
- Test: `tests/unit/market-support.test.ts`

**Interfaces:**
- Consumes: `Market`, `ExchangeSession`, `KR_SESSION`, `UnsupportedMarketSessionError`
- Produces: `ALL_MARKETS: readonly Market[]`, `hasMarketSession(market) => boolean`, `interface MarketSupport { market, datasetsSupported, factsSupported, reason }`, `listMarketSupport() => readonly MarketSupport[]`, `GET /markets`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/market-support.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  KR_SESSION,
  UnsupportedMarketSessionError,
  getSessionForMarket,
  hasMarketSession,
} from '../../src/server/modules/market-data/domain/exchange-session.js';
import { listMarketSupport } from '../../src/server/modules/market-data/domain/market-support.js';

describe('hasMarketSession', () => {
  it('KR 은 세션이 있고 US 는 없다', () => {
    expect(hasMarketSession('KR')).toBe(true);
    expect(hasMarketSession('US')).toBe(false);
  });
});

describe('getSessionForMarket 회귀 (맵 기반으로 바꾼 뒤)', () => {
  it('KR 은 KR_SESSION 을 돌려준다', () => {
    expect(getSessionForMarket('KR')).toBe(KR_SESSION);
  });

  it('US 는 UnsupportedMarketSessionError 를 던진다', () => {
    expect(() => getSessionForMarket('US')).toThrow(UnsupportedMarketSessionError);
  });
});

describe('listMarketSupport', () => {
  it('선언된 모든 시장을 담는다', () => {
    expect(listMarketSupport().map((entry) => entry.market)).toEqual(['KR', 'US']);
  });

  it('KR 은 전부 지원이고 이유가 없다', () => {
    const kr = listMarketSupport().find((entry) => entry.market === 'KR');
    expect(kr).toEqual({
      market: 'KR',
      datasetsSupported: true,
      factsSupported: true,
      reason: null,
    });
  });

  it('US 는 전부 미지원이고 이유에 세션과 재무 두 근거가 다 있다', () => {
    const us = listMarketSupport().find((entry) => entry.market === 'US');
    expect(us?.datasetsSupported).toBe(false);
    expect(us?.factsSupported).toBe(false);
    // 사용자가 "왜 회색인지" 를 이 문구 하나로 알 수 있어야 한다
    expect(us?.reason).toContain('세션');
    expect(us?.reason).toContain('DART');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/market-support.test.ts`
Expected: FAIL — `hasMarketSession` 과 `market-support.js` 가 없다.

- [ ] **Step 3: `Market` 값 목록을 타입 옆에 둔다**

`src/server/modules/market-data/domain/candle.ts` 1행 아래에 추가:

```ts
export type Market = 'KR' | 'US';
/** 선언된 시장 전체. 타입과 값 목록이 떨어져 있으면 시장을 추가할 때 한쪽만 고쳐진다. */
export const ALL_MARKETS: readonly Market[] = ['KR', 'US'];
```

- [ ] **Step 4: 세션 조회를 맵 기반으로 바꾼다**

`src/server/modules/market-data/domain/exchange-session.ts` — `KR_SESSION` 정의 아래,
`getSessionForMarket` 을 교체한다:

```ts
/**
 * 시장 → 세션. **"이 시장을 지원하는가" 의 단일 출처다.**
 *
 * 이전에는 지원 여부가 `getSessionForMarket` 이 던진다는 사실 안에 암묵적으로만
 * 있었다 — 화면이 그걸 물어볼 방법이 없어서 UI 에 시장 목록을 따로 박아야 했고,
 * 세션이 추가되는 날 화면만 낡은 채로 남는다.
 */
const SESSIONS: Partial<Record<Market, ExchangeSession>> = { KR: KR_SESSION };

/** 시장별 세션 해석. 세션이 정의되지 않은 시장은 명시적으로 거부한다. */
export function getSessionForMarket(market: Market): ExchangeSession {
  const session = SESSIONS[market];
  if (!session) throw new UnsupportedMarketSessionError(market);
  return session;
}

/** 세션이 정의된 시장인지 — 데이터셋 생성·집계·coverage 가능 여부와 같은 질문이다 */
export function hasMarketSession(market: Market): boolean {
  return SESSIONS[market] !== undefined;
}
```

`UnsupportedMarketSessionError` 클래스 정의가 `SESSIONS` 보다 아래에 있으면 위로 옮긴다
(클래스는 호이스팅되지 않는다).

- [ ] **Step 5: 시장 지원 정보를 만든다**

`src/server/modules/market-data/domain/market-support.ts`:

```ts
import { ALL_MARKETS, type Market } from './candle.js';
import { hasMarketSession } from './exchange-session.js';

export interface MarketSupport {
  readonly market: Market;
  /** 데이터셋 생성·수집 가능 여부 (거래소 세션 정의 여부와 같다) */
  readonly datasetsSupported: boolean;
  /** DART 재무 수집 대상 시장인지 — DART 는 국내 공시 기관이다 */
  readonly factsSupported: boolean;
  /** 지원되지 않는 이유 (한국어). 전부 지원되면 null */
  readonly reason: string | null;
}

/**
 * 화면이 "무엇을 고를 수 있는지" 를 물어보는 자리.
 *
 * `factsSupported` 는 **시장 자격만** 본다 — DART_API_KEY 설정 여부는 배포 상태이지
 * 시장 속성이 아니다. 그건 데이터셋별 추정기(factsSyncEstimator)가 답한다. 둘을 한
 * 필드에 섞으면 "KR 인데 재무 불가" 의 원인이 시장인지 키인지 구분되지 않는다.
 */
export function listMarketSupport(): readonly MarketSupport[] {
  return ALL_MARKETS.map((market) => {
    const datasetsSupported = hasMarketSession(market);
    // DART 는 국내 공시 기관이다 — US 세션이 정의된 뒤에도 남는 제약이라 세션과
    // 따로 판단한다
    const factsSupported = market === 'KR';
    if (datasetsSupported && factsSupported) {
      return { market, datasetsSupported, factsSupported, reason: null };
    }
    const reasons: string[] = [];
    if (!datasetsSupported) {
      reasons.push('거래소 세션 정의가 없어(DST 미지원) 데이터셋을 만들 수 없습니다');
    }
    if (!factsSupported) {
      reasons.push('DART 재무 수집은 국내 종목 전용입니다');
    }
    return { market, datasetsSupported, factsSupported, reason: `${reasons.join('. ')}.` };
  });
}
```

- [ ] **Step 6: 라우트를 더한다**

`src/server/modules/market-data/presentation/dataset-routes.ts` — `/symbols/info` 바로 위에
추가한다:

```ts
  /** 지원 시장 목록. 배포마다 고정이므로 클라이언트가 길게 캐시한다. */
  app.get('/markets', { preHandler: requireAuth }, async () => ({
    markets: listMarketSupport(),
  }));
```

import 를 더한다:

```ts
import { listMarketSupport } from '../domain/market-support.js';
```

- [ ] **Step 7: 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run tests/unit/market-support.test.ts && pnpm test && pnpm typecheck`
Expected: PASS. `aggregate.test.ts`·`session-policy.test.ts`·`coverage.test.ts` 등 세션을
쓰는 기존 테스트가 전부 통과해야 한다 — 맵 기반 전환이 동작을 바꾸지 않았다는 확인이다.

- [ ] **Step 8: 커밋**

```bash
git add src/server/modules/market-data/domain/candle.ts src/server/modules/market-data/domain/exchange-session.ts src/server/modules/market-data/domain/market-support.ts src/server/modules/market-data/presentation/dataset-routes.ts tests/unit/market-support.test.ts
git commit -m "feat(market-data): 지원 시장을 선언적으로 물어볼 수 있게 한다

지원 여부가 getSessionForMarket 이 던진다는 사실 안에만 있어서 화면이 물어볼
방법이 없었다 — 맵을 단일 출처로 두고 hasMarketSession 을 노출한다.
factsSupported 는 시장 자격만 본다 (DART 키 여부는 배포 상태다)."
```

---

### Task 14: 시장 선택에 미지원 시장을 명시

**Files:**
- Create: `src/web/lib/use-market-support.ts`
- Modify: `src/web/features/datasets/datasets-page.tsx:481-488` (생성 dialog), `:603-610` (CSV 가져오기 dialog)
- Modify: `tests/e2e/mvp-flow.spec.ts`

**Interfaces:**
- Consumes: `GET /markets` (Task 13), `api` (`@/lib/api-client`)
- Produces: `interface MarketSupport`, `useMarketSupport() => readonly MarketSupport[]`

- [ ] **Step 1: 훅을 만든다**

`src/web/lib/use-market-support.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface MarketSupport {
  market: string;
  datasetsSupported: boolean;
  factsSupported: boolean;
  reason: string | null;
}

/** 지원 시장 목록. 배포마다 고정이라 재조회하지 않는다. */
export function useMarketSupport(): readonly MarketSupport[] {
  const { data } = useQuery({
    queryKey: ['markets'],
    queryFn: () => api<{ markets: MarketSupport[] }>('/markets'),
    staleTime: Infinity,
  });
  return data?.markets ?? [];
}
```

- [ ] **Step 2: 생성 dialog 의 Select 를 바꾼다**

`datasets-page.tsx` — import 를 더한다:

```tsx
import { useMarketSupport, type MarketSupport } from '@/lib/use-market-support';
```

생성 dialog 컴포넌트(`const [market, setMarket] = useState('KR');` 가 있는 쪽) 안에서:

```tsx
  const markets = useMarketSupport();
  const unsupported = markets.filter((entry) => !entry.datasetsSupported);
```

`:481-488` 의 Select 를 교체한다:

```tsx
              <Select value={market} onValueChange={setMarket}>
                <SelectTrigger id="market" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {markets.map((entry) => (
                    <SelectItem
                      key={entry.market}
                      value={entry.market}
                      // 고를 수 있게 두고 400 을 받게 하는 것은 명시가 아니다 —
                      // 사용자는 종목을 다 넣은 뒤에야 알게 된다
                      disabled={!entry.datasetsSupported}
                    >
                      {entry.market}
                      {entry.datasetsSupported ? '' : ' (지원 예정)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
```

`SelectItem`·`SelectTrigger` 등의 id/className 은 각 dialog 의 기존 값을 그대로 쓴다
(생성 dialog 와 CSV dialog 가 다르다 — 생성 쪽은 `className="h-11 w-full"` 이 없을 수
있으니 기존 마크업을 확인하고 유지한다).

- [ ] **Step 3: 미지원 이유를 상시 노출한다**

같은 dialog 의 Select 바로 아래에 넣는다. **접었다 펴는 자리에 숨기지 않는다** — 선택지가
회색인 이유를 찾으러 다니게 하면 명시한 것이 아니다:

```tsx
              {unsupported.map((entry) => (
                <p key={entry.market} className="text-xs text-muted-foreground">
                  {entry.market} 는 아직 지원하지 않습니다 — {entry.reason}
                </p>
              ))}
```

- [ ] **Step 4: CSV 가져오기 dialog 에도 같은 것을 적용한다**

`:603-610` 의 Select 와 그 아래에 Step 2·3 과 같은 내용을 넣는다. 해당 컴포넌트에도
`const markets = useMarketSupport();` 와 `const unsupported = ...` 를 더한다.

두 dialog 가 같은 마크업을 갖게 되므로, 이 시점에 작은 컴포넌트로 뽑는다 —
`datasets-page.tsx` 안의 지역 컴포넌트로 충분하다(파일 밖으로 낼 소비자가 없다):

```tsx
/** 시장 선택 + 미지원 시장 사유. 두 dialog 가 같은 규칙을 쓰게 묶는다. */
function MarketSelect({
  id,
  value,
  onChange,
  markets,
}: {
  id: string;
  value: string;
  onChange: (market: string) => void;
  markets: readonly MarketSupport[];
}) {
  const unsupported = markets.filter((entry) => !entry.datasetsSupported);
  return (
    <>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-11 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {markets.map((entry) => (
            <SelectItem key={entry.market} value={entry.market} disabled={!entry.datasetsSupported}>
              {entry.market}
              {entry.datasetsSupported ? '' : ' (지원 예정)'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {unsupported.map((entry) => (
        <p key={entry.market} className="text-xs text-muted-foreground">
          {entry.market} 는 아직 지원하지 않습니다 — {entry.reason}
        </p>
      ))}
    </>
  );
}
```

두 dialog 는 이걸 쓴다:

```tsx
              <MarketSelect id="market" value={market} onChange={setMarket} markets={markets} />
```

- [ ] **Step 5: e2e 에 확인을 더한다**

`tests/e2e/mvp-flow.spec.ts` — 데이터셋 생성 dialog 를 다루는 구간(없으면 새 테스트
블록)에 추가한다:

```ts
  // 미지원 시장은 고를 수 없고 이유가 보인다 — 종목을 다 넣은 뒤 400 을 받게 하지 않는다
  await page.getByRole('button', { name: /데이터셋 만들기|새 데이터셋/ }).click();
  await page.getByLabel('시장').click();
  await expect(page.getByRole('option', { name: /US/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/US 는 아직 지원하지 않습니다/)).toBeVisible();
  await expect(page.getByText(/DART 재무 수집은 국내 종목 전용/)).toBeVisible();
```

버튼·라벨 이름은 실제 마크업에 맞춘다. `getByRole('option')` 이 안 잡히면 Radix Select 가
`listbox`/`option` role 을 쓰는지 확인하고 `getByText` 로 대체한다.

- [ ] **Step 6: 확인한다**

Run: `pnpm typecheck && pnpm lint && pnpm build:web && pnpm test`
Expected: PASS

Run: `pnpm test:e2e`
Expected: PASS

수동 확인: 데이터셋 생성 dialog 와 CSV 가져오기 dialog 양쪽에서 (1) US 가 회색이고
`(지원 예정)` 이 붙는지, (2) 클릭해도 선택되지 않는지, (3) Select 아래에 이유가 항상
보이는지.

- [ ] **Step 7: 커밋**

```bash
git add src/web/lib/use-market-support.ts src/web/features/datasets/datasets-page.tsx tests/e2e/mvp-flow.spec.ts
git commit -m "feat(web): 미지원 시장을 고를 수 없게 하고 이유를 상시 노출한다

지금까지 US 를 고를 수 있었고, 안내는 종목을 다 넣고 만들기를 누른 뒤 오는 400
하나뿐이었다. 이유는 접는 자리에 숨기지 않는다 — 선택지가 회색인 까닭을 찾으러
다니게 하면 명시한 것이 아니다."
```

---

### Task 15: 문서 갱신

**Files:**
- Modify: `docs/IMPLEMENTATION_STATUS.md:32`
- Modify: `docs/DECISIONS.md` (D-027 추가)

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: 범위 제외 목록에서 해소된 항목을 고친다**

`docs/IMPLEMENTATION_STATUS.md:32` 의 "`facts:sync` 웹 라우트화는 이번 범위가 아니다" 를 지우고, 대신 남은 한계를 적는다:

```
- 거시 지표 수집(`FactScope.MACRO`)·시점별 지수 구성·업종 분류·US 재무제표(SEC EDGAR)는 이번 범위가 아니다. 웹 동기화의 「재무」 체크박스는 **증분**(미수집 연도 + 현재 연도)만 수집한다 — 과거 연도 정정공시를 다시 받으려면 `pnpm cli facts:sync --dataset <id> --from <연도> --to <연도>` 를 쓴다. 웹 수집은 연결(CFS) 고정이며 별도(OFS)는 CLI `--fs-div OFS` 로만 가능하다. **재무 수집은 국내(KR) 종목 전용이다** — DART 는 국내 공시 기관이다.
```

- [ ] **Step 2: D-027 을 추가한다**

`docs/DECISIONS.md` 맨 뒤(D-026 아래)에 추가한다. 기존 항목들의 4줄 형식(변경 내용·이유·영향)을 따른다:

```markdown
## D-027: 미지원 시장을 UI 에서 고를 수 없게 한다

- **변경 내용:** 데이터셋 생성·CSV 가져오기 폼의 시장 선택을 `GET /markets` 응답으로 렌더하고, 세션이 정의되지 않은 시장(US)은 `disabled` + `(지원 예정)` 으로 두고 이유를 Select 아래에 상시 표시한다. 지원 여부의 단일 출처는 `exchange-session.ts` 의 `SESSIONS` 맵이며 `hasMarketSession` 이 그것을 노출한다. 재무(DART) 수집이 국내 전용이라는 사실은 재무 체크박스 툴팁에 상시 표시한다.
- **이유:** D-006 이 US 를 거부하도록 고쳤지만 UI 는 계속 US 를 선택지로 내놓았다 — 사용자가 받는 안내는 시장을 고르고 종목을 다 넣고 「만들기」를 누른 뒤 오는 400 하나뿐이었다. 거부를 코드가 알고 있는데 화면이 말하지 않는 상태였다. 지원 여부를 `getSessionForMarket` 이 던진다는 사실 안에만 두면 화면이 물어볼 방법이 없어 UI 에 시장 목록을 따로 박게 되고, 세션이 추가되는 날 화면만 낡은 채로 남는다.
- **영향:** 서버 검증(`createBrokerDataset`·`importCsv` 의 `getSessionForMarket` 호출)과 `z.enum(['KR','US'])` 는 그대로 둔다 — UI 는 미리 알려주는 층이지 거부하는 층이 아니고, 스키마에서 US 를 빼면 400 메시지가 "필드가 올바르지 않습니다" 로 뭉개져 시장이 원인이라는 정보가 사라진다.
- **남은 한계:** `formatKrw`/`formatSignedKrw` 가 통화를 원화로 고정한다(`format.ts:8-11`). US 데이터셋이 존재할 수 없어 지금은 드러나지 않지만, US 지원 작업은 DST 포함 세션 정의와 통화 표시 일반화를 **함께** 해결해야 한다. 한쪽만 하면 미국 종목 손익이 "원" 으로 표시된다.
```

- [ ] **Step 3: 커밋**

```bash
git add docs/IMPLEMENTATION_STATUS.md docs/DECISIONS.md
git commit -m "docs: 재무 수집 웹 라우트화와 시장 지원 명시를 기록한다

웹은 증분·CFS·KR 전용이고 임의 범위·OFS 는 CLI 담당이라는 역할 분담을 적는다.
D-027 에 통화 표시가 US 지원의 남은 한계임을 남긴다 — 세션만 정의하면 미국
종목 손익이 원화로 표시된다."
```

---

## 검증 체크리스트 (전체 완료 후)

- [ ] `pnpm typecheck` PASS
- [ ] `pnpm lint` PASS
- [ ] `pnpm test` PASS (`tests/architecture/module-boundaries.test.ts` 포함 — `market-data-no-facts` 위반 0)
- [ ] `pnpm test:e2e` PASS
- [ ] `pnpm cli facts:sync --dataset <id> --from 2024 --to 2024` 가 여전히 동작한다 (CLI 무회귀)
- [ ] 웹에서 「재무」 체크 → 봉·재무가 순차로 돌고 완료 토스트에 두 건수가 뜬다
- [ ] 같은 데이터셋을 재무 체크로 두 번 돌리면 두 번째 예상 시간이 눈에 띄게 짧다 (증분 동작)
- [ ] 재무 툴팁에 "국내(KR) 종목만 가능합니다" 가 **KR 데이터셋에서도** 보인다
- [ ] 데이터셋 생성·CSV 가져오기 두 dialog 에서 US 가 회색이고 선택되지 않으며, 이유가 Select 아래에 항상 보인다
- [ ] `POST /datasets` 에 `market: 'US'` 를 직접 보내면 여전히 400 이다 (서버 검증 무회귀)
