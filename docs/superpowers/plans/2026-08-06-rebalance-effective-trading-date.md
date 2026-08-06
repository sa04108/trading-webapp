# 리밸런스 적용 거래일 해소 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 리밸런스 날짜가 휴장일이면 직전 거래일로 해소해 그 날짜의 유니버스를 쓰고, 해소 결과를 일정에 기록한다.

**Architecture:** 거래일을 명시 테이블에 기록해 "커버됨"과 "거래일임"을 구분한다. 동기화는 휴장일을 만나면 직전 거래일까지 소급 수집해 재구성 앵커를 보장한다. resolver 는 요청 날짜가 아니라 적용 거래일로 유니버스·시총을 읽는다.

**Tech Stack:** Fastify, Drizzle(SQLite), zod, vitest, playwright.

## 배경 (실장애)

운영에서 `POST /backtests/universe-preview` 가 500 으로 죽었다.
`SymbolMasterNotCoveredError: 종목 마스터가 2025-01-01 를 커버하지 않는다`.

원인 사슬:

1. 2025-01-01 은 신정 휴장일이다. 동기화가 `ingestDate` 를 부르면 두 시장 모두 거래가
   없어 `HOLIDAY` 분기를 타고 `mergeCoverage` 만 한다 — 체크포인트도 이벤트도 없다.
2. 그래서 `isCovered('2025-01-01')` 은 true 가 된다.
3. 재미리보기의 `resolve` 가 이 게이트를 통과하고 `getUniverseAsOf` 를 부른다.
   체크포인트 테이블이 비어 `nearestCheckpoint` 가 undefined 를 반환하고 던진다.
4. 라우트에 이 오류 매핑이 없어 500 으로 나간다.

깨진 불변식: **`isCovered(date)` 가 true 라고 `getUniverseAsOf(date)` 가 되는 게 아니다.**

`computeRebalanceDates` 가 캘린더 날짜를 그대로 쓰므로(1일 기준 월 리밸런싱이면
2025-02-01 토, 2025-03-01 토·삼일절 …) 비거래일 리밸런스는 예외가 아니라 다수다.

## Global Constraints

- 한국어 주석·문서는 CLAUDE.md 규칙(문어체 평서형, 번역투 금지, "왜"를 쓴다)을 따른다.
- UI 문구는 간결체(합쇼체 금지) — symbol-master/backtests feature 규칙.
- `pnpm lint && pnpm typecheck && pnpm vitest run tests/unit tests/integration` 커밋 전 통과.
- import 는 `.js` 확장자. 날짜는 ISO `YYYY-MM-DD`.
- 마이그레이션은 `pnpm db:generate` 산출물. **0004 는 이미 배포됐으므로 수정 금지** — 새 파일로 만든다.
- 기존 백테스트 데이터 보존 의무 없음(개발 단계).
- 소급 수집 상한은 캘린더 10일 — 설·추석 연휴가 주말과 붙어도 5~6일이라 여유가 있다.

---

### Task 1: 거래일 기록과 적용 거래일 조회

**Files:**
- Modify: `src/server/shared/db/schema.ts` (테이블 추가)
- Create: `migrations/0005_*.sql` (drizzle-kit 생성 + 백필 구문 수동 추가)
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts`
- Test: `tests/unit/symbol-master-trading-days.test.ts`

**Interfaces:**
- Produces:

```typescript
// schema.ts
export const symbolMasterTradingDays = sqliteTable('symbol_master_trading_days', {
  date: text('date').primaryKey(),
});

// SymbolMasterService
/** date 이하에서 가장 가까운 거래일. 없으면 undefined — 재구성 앵커가 없다는 뜻이다. */
effectiveTradingDate(date: string): string | undefined;
```

동작 규약:

1. `ingestDate` 가 거래일로 판정한 경우(최초 수집 분기·일반 분기 **둘 다**)
   `symbolMasterTradingDays` 에 그 날짜를 기록한다. 이벤트·coverage 갱신과 **같은
   트랜잭션**에 넣는다 — 따로 두면 중간에 죽었을 때 거래일 기록만 빠진다.
   재수집 대비로 `onConflictDoNothing()` 을 쓴다.
2. 휴장일(`HOLIDAY`) 은 기록하지 않는다. 이 구분이 이 태스크의 핵심이다 —
   변경이 0건인 거래일과 휴장일은 이벤트만으로는 구별되지 않는다.
3. `effectiveTradingDate(date)` 는 `date <= ?` 인 거래일의 최댓값을 반환한다.
4. 마이그레이션은 기존 데이터를 백필한다. 체크포인트 날짜와 이벤트 `effective_date` 는
   정의상 거래일이므로 그대로 넣는다:

```sql
INSERT OR IGNORE INTO `symbol_master_trading_days` (`date`)
  SELECT `checkpoint_date` FROM `symbol_master_checkpoints`;
INSERT OR IGNORE INTO `symbol_master_trading_days` (`date`)
  SELECT DISTINCT `effective_date` FROM `symbol_master_events`;
```

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/symbol-master-trading-days.test.ts` — fake KRX 서버로 다음 4케이스를 전체 코드로 작성한다.
기존 `tests/unit/symbol-master-ingest.test.ts` 의 setup/`setTradingDay` 헬퍼 패턴을 그대로 재사용한다.

```typescript
it('거래일 수집은 거래일로 기록한다', async () => {
  // 2023-01-02 를 거래일로 세팅 후 ingestDate → effectiveTradingDate('2023-01-02') === '2023-01-02'
});

it('휴장일 수집은 거래일로 기록하지 않는다', async () => {
  // 응답 없는 날짜 ingestDate → HOLIDAY, effectiveTradingDate 는 undefined
});

it('휴장일의 적용 거래일은 직전 거래일이다', async () => {
  // 2023-01-02 거래일 수집 후 2023-01-03 휴장 수집
  // → effectiveTradingDate('2023-01-03') === '2023-01-02'
});

it('거래일 이전 날짜는 적용 거래일이 없다', async () => {
  // 2023-01-02 거래일만 수집 → effectiveTradingDate('2023-01-01') === undefined
});
```

- [ ] **Step 2: 실행해 실패 확인** — `pnpm vitest run tests/unit/symbol-master-trading-days.test.ts` → FAIL(메서드 없음)
- [ ] **Step 3: 구현** — 스키마·서비스. 거래일 기록은 두 분기 모두에서 같은 트랜잭션에 넣는다.
- [ ] **Step 4: 마이그레이션 생성** — `pnpm db:generate --name trading_days` 후 백필 구문 수동 추가
- [ ] **Step 5: 통과 확인** — 신규 테스트 + `pnpm vitest run tests/unit` 회귀
- [ ] **Step 6: 커밋**

```bash
git add src/server tests/unit/symbol-master-trading-days.test.ts migrations
git commit -m "feat(symbol-master): 거래일을 명시 기록하고 적용 거래일 조회를 추가한다"
```

---

### Task 2: 휴장일 소급 수집

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts`
- Modify: `src/server/modules/market-data/presentation/symbol-master-routes.ts`
- Modify: `src/shared/schemas/symbol-master.ts` (동기화 응답 DTO)
- Test: `tests/unit/symbol-master-ensure-trading-day.test.ts`, `tests/integration/symbol-master-routes.test.ts`(케이스 추가)

**Interfaces:**
- Consumes: Task 1 `effectiveTradingDate`
- Produces:

```typescript
export interface EnsureTradingDayResult {
  readonly requestedDate: string;
  /** 해소된 적용 거래일. 상한까지 거슬러도 못 찾으면 null */
  readonly effectiveTradingDate: string | null;
  /** 이번 호출이 실제로 수집한 날짜들 (이미 커버된 날짜는 빠진다) */
  readonly ingestedDates: readonly string[];
}

/** 요청 날짜와, 그 날짜가 휴장이면 직전 거래일까지 수집해 재구성 앵커를 보장한다 */
async ensureTradingDay(date: string, maxLookbackDays?: number): Promise<EnsureTradingDayResult>;
```

동작 규약:

1. `ingestDate(date)` 를 먼저 부른다.
2. `effectiveTradingDate(date)` 가 값을 주면 그대로 반환한다.
3. 없으면 `date - 1` 부터 하루씩 거슬러 `ingestDate` 를 부른다. 매번 다시
   `effectiveTradingDate(date)` 를 확인해 값이 생기면 멈춘다.
4. 상한(기본 10)까지 못 찾으면 `effectiveTradingDate: null` 로 반환한다 — 던지지 않는다.
   호출부가 사용자에게 설명해야 하는 상황이지 예외가 아니다.
5. 이미 커버된 날짜는 `ingestDate` 가 `ALREADY_COVERED` 를 주므로 `ingestedDates` 에 넣지 않는다.
   **주의**: 커버는 됐지만 거래일 기록이 없는 날짜(운영에 실재하는 상태 — 휴장만 수집된 2025-01-01)
   도 소급 대상이다. 판단 기준은 coverage 가 아니라 `effectiveTradingDate` 다.

라우트 변경:

- `POST /symbol-master/sync` 가 `ingestDate` 대신 `ensureTradingDay` 를 부르고
  `EnsureTradingDayResult` 를 반환한다.
- `SymbolMasterNotCoveredError` 를 409 로 매핑한다 — 이 오류가 500 으로 새면 안 된다.
  `symbol-master-routes.ts` 와 `backtest-routes.ts` 양쪽 모두에 넣는다
  (`backtest-routes.ts` 는 기존 `sendIfKrxError` 헬퍼 옆에 나란히 둔다).

- [ ] **Step 1: 실패하는 테스트 작성** — 전체 코드로:

```typescript
it('휴장일 요청은 직전 거래일까지 소급 수집한다', async () => {
  // 2023-01-02 거래일, 2023-01-03·01-04 휴장 세팅
  // ensureTradingDay('2023-01-04') → effectiveTradingDate '2023-01-02',
  // ingestedDates 에 01-04·01-03·01-02 포함
});

it('이미 거래일이면 소급하지 않는다', async () => {
  // ensureTradingDay('2023-01-02') → ingestedDates 는 01-02 하나
});

it('커버는 됐지만 거래일 기록이 없으면 소급한다', async () => {
  // 2023-01-03 을 휴장으로 먼저 ingestDate (coverage 만 생김)
  // → ensureTradingDay('2023-01-03') 이 01-02 까지 거슬러 앵커를 만든다
});

it('상한까지 못 찾으면 null 을 반환하고 던지지 않는다', async () => {
  // 전 구간 휴장 세팅, maxLookbackDays: 3 → effectiveTradingDate null
});
```

  통합 테스트에는 `POST /symbol-master/sync` 가 휴장일 요청에 소급 결과를 돌려주는 케이스를 더한다.

- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인**(`pnpm vitest run tests/unit tests/integration`)
- [ ] **Step 5: 커밋**

```bash
git add src/server src/shared tests
git commit -m "feat(symbol-master): 휴장일 동기화가 직전 거래일까지 소급하게 한다"
```

---

### Task 3: resolver 가 적용 거래일로 해소

**Files:**
- Modify: `src/server/modules/backtest/application/universe-rule-resolver.ts`
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts` (미리보기 응답)
- Modify: `src/workers/backtest-child.ts` (타입 반영 — 활성 시점은 그대로)
- Test: `tests/unit/universe-rule-resolver.test.ts`(케이스 추가), `tests/integration/backtest-universe-preview.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface UniverseScheduleEntry {
  readonly rebalanceDate: string;
  /** 유니버스·시총을 실제로 읽은 거래일. 휴장이면 rebalanceDate 보다 앞선다 */
  readonly effectiveTradingDate: string;
  readonly symbols: readonly string[];
}
```

동작 규약:

1. 날짜별로 `isCovered(date)` 와 `effectiveTradingDate(date)` 를 **둘 다** 본다.
   둘 중 하나라도 없으면 `uncoveredDates` 에 요청 날짜를 담고 건너뛴다.
   `isCovered` 를 함께 보는 이유: 적용 거래일만 보면 coverage 가 한참 전에서 끊긴
   먼 미래 날짜도 옛 유니버스로 조용히 해소돼 버린다.
2. `getUniverseAsOf` 와 `getMarketCapsAt` 에 **적용 거래일**을 넘긴다.
   시총은 특히 중요하다 — 휴장일에는 MKTCAP 행이 없어 상위 N 이 빈 목록이 된다.
3. `schedule` 항목에 `effectiveTradingDate` 를 담는다. `scheduleHash` 는 자연히 바뀐다
   (저장된 실행 기록이 없어 하위호환 부담이 없다).
4. 엔진 활성 시점은 **rebalanceDate 그대로**다 — 리밸런스가 일어나는 시점은 요청 날짜지,
   데이터를 읽은 날짜가 아니다. `backtest-child.ts` 의 `fromTsMs` 계산은 건드리지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성** — 전체 코드로:

```typescript
it('휴장 리밸런스 날짜는 직전 거래일 유니버스로 해소한다', async () => {
  // 01-02 거래일 수집, 01-03 휴장 수집
  // resolve(rule, ['2023-01-03']) → schedule[0].effectiveTradingDate === '2023-01-02',
  // symbols 가 비어 있지 않다
});

it('적용 거래일이 없으면 uncovered 로 분류한다', async () => {
  // 휴장만 커버된 상태 → uncoveredDates 에 요청 날짜
});

it('coverage 밖 날짜는 적용 거래일이 있어도 uncovered 다', async () => {
  // 01-02 만 커버된 상태에서 resolve(rule, ['2026-01-01'])
});
```

- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인**(전체 회귀 포함)
- [ ] **Step 5: 커밋**

```bash
git add src/server src/workers tests
git commit -m "feat(backtest): 리밸런스 유니버스를 적용 거래일로 해소한다"
```

---

### Task 4: 위저드 표기와 e2e

**Files:**
- Modify: `src/web/features/backtests/universe-rule-step.tsx`
- Modify: `tests/e2e/mvp-flow.spec.ts` 또는 `tests/e2e/symbol-master.spec.ts`

동작 규약:

1. 일정 표에 적용 거래일을 보여준다. 요청 날짜와 다를 때만 덧붙인다 —
   같은 날이면 잡음이다. 예: `2025-01-01 (적용 2024-12-31)`.
2. `UniverseScheduleEntryDto` 에 `effectiveTradingDate` 를 더한다.
3. 동기화 버튼 문구·흐름은 그대로 둔다. 소급 수집은 서버가 알아서 한다.
4. e2e: 휴장일이 섞인 리밸런스 일정으로 미리보기 → 동기화 → 일정이 채워지고
   적용 거래일이 표기되는 것까지 확인한다. fake KRX 서버에서 특정 날짜만
   거래일로 세팅하면 재현된다.

- [ ] **Step 1: 구현** → **Step 2: `pnpm lint && pnpm typecheck && pnpm build && pnpm test:e2e`** → **Step 3: 커밋**

```bash
git add src/web tests/e2e
git commit -m "feat(backtests): 일정에 적용 거래일을 표기한다"
```

---

## 완료 기준

- 2025-01-01 같은 휴장 리밸런스 날짜를 동기화하면 직전 거래일까지 수집돼 미리보기가 채워진다.
- `SymbolMasterNotCoveredError` 가 어떤 경로로도 500 이 되지 않는다.
- `pnpm test && pnpm lint && pnpm typecheck && pnpm test:e2e` 전부 통과.
