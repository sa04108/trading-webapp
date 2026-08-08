# 자본변동 포지션 연속성 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스트 엔진이 액면분할을 걸친 보유 포지션을 조정하게 하고, 자본변동 이력이 없으면 제출을 막고 위저드에서 일괄 수집할 수 있게 한다.

**Architecture:** 원본 봉은 그대로 두고 효력발생일에 포지션 수량·평균단가를 조정한다. 제출 검증이 자본변동 커버리지를 확인해 미수집이면 400 을 내고, gap 이 난 종목은 통과시키되 이름으로 경고한다. 위저드가 그 자리에서 자본변동만 수집하는 잡을 띄우고 SSE 로 진행률을 받는다.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM(better-sqlite3), React + TanStack Query, Vitest, Playwright

**설계 문서:** `docs/superpowers/specs/2026-08-08-corporate-action-continuity-design.md`

## Global Constraints

- **이 계획은 스키마를 바꾼다.** Plan 1 과 다르다. 컬럼·테이블을 더할 때 `pnpm db:generate` 로 마이그레이션을 만들고 커밋한다. 기존 마이그레이션을 편집하지 않는다.
- 죽은 테이블(`symbol_slices`, `symbol_coverage`, `data_sync_jobs`) 삭제와 마이그레이션 스쿼시는 **후속 계획 B** 몫이다. 여기서 지우지 않는다.
- `data_sync_jobs` 를 되살리지 않는다. 자본변동 수집 잡은 **새 좁은 테이블**을 쓴다.
- 봉의 유일한 출처는 `krx_daily_bars` 다. 원본 봉을 소급 수정하지 않는다.
- 한국어 주석·문서는 `CLAUDE.md` 규칙을 따른다: 번역투 금지(~에 대해/~을 통해/~함으로써/~적인 남용 금지), 피동형 대신 능동형, 문어체 평서형(~한다/~이다), **한 문장에 하나의 내용만 담고 3줄 이상 이어지는 문장은 나눈다**, 불필요한 수식어 제거, 주석은 "왜"를 쓴다. 사용자 대상 UI 문구만 합쇼체(~합니다).
  - **경고: 이 저장소에서 문장 길이 규칙이 여섯 번 어겨졌고 그중 네 번은 그 규칙을 고치는 커밋에서 재발했다. 주석을 쓴 뒤 물리적 줄 수를 세어라.**
- 커밋 메시지 형식: `<type>(<scope>): <한국어 요약>`.
- 검증 명령: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm test:e2e`. 각 태스크 끝에서 최소한 관련 테스트와 `pnpm typecheck` 가 통과해야 한다.
- **현재 기준선: `pnpm test` 871 pass / 0 fail.** 실패가 늘면 회귀다.

---

## File Structure

### 신설

| 경로 | 책임 |
|---|---|
| `src/server/modules/backtest/domain/corporate-action-adjust.ts` | 포지션 하나에 자본변동 하나를 적용하는 순수 함수. 단주 현금 환산 포함 |
| `tests/unit/corporate-action-adjust.test.ts` | 위 함수의 경계 검증 |
| `src/server/modules/facts/application/corporate-action-coverage.ts` | 자본변동 수집·gap 연도 저장소 |
| `tests/unit/corporate-action-coverage.test.ts` | 위 저장소 검증 |
| `src/server/modules/facts/presentation/corporate-action-routes.ts` | 수집 잡 생성·조회·취소·SSE |
| `src/web/features/backtests/corporate-action-gate.tsx` | 위저드의 미수집 안내와 수집 버튼 |

### 수정

| 경로 | 변경 |
|---|---|
| `src/server/shared/db/schema.ts` | `symbol_facts_state` 에 자본변동 수집·gap 연도 컬럼 추가. 수집 잡 테이블 추가 |
| `src/server/modules/backtest/domain/engine.ts` | 봉 루프에 자본변동 조정 단계 추가 |
| `src/server/modules/market-data/application/symbol-master-service.ts` | `writeDailyBars` 를 `onConflictDoNothing` 으로, OHLC 검사 추가 |
| `src/server/modules/facts/application/fact-sync-service.ts` | 자본변동 전용 경로, gap 영속 |
| `src/server/modules/backtest/presentation/backtest-routes.ts` | 제출 검증에 자본변동 게이트 |
| `src/server/bootstrap/container.ts`, `server.ts` | 새 저장소·서비스·라우트 조립 |
| `src/web/features/backtests/new-backtest-wizard.tsx` | 게이트 컴포넌트 배치 |

---

### Task 1: 자본변동 조정 함수

포지션 하나에 자본변동 하나를 적용하는 순수 함수를 만든다. 엔진에 끼우기 전에 규칙을 테스트로 못박는다.

**Files:**
- Create: `src/server/modules/backtest/domain/corporate-action-adjust.ts`
- Test: `tests/unit/corporate-action-adjust.test.ts`

**Interfaces:**
- Consumes: `Position` (`src/server/modules/backtest/domain/types.ts:61`) — `{ symbol, quantity, avgEntryPrice, entryCosts, entryTsMs }`. `CorporateAction` (`src/server/modules/facts/domain/fact.ts:42`) — `{ effectiveTsMs, ratio }`
- Produces:
  - `export interface AdjustResult { readonly quantity: number; readonly avgEntryPrice: number; readonly cashFromFraction: number; readonly closed: boolean; }`
  - `export function adjustForRatio(quantity: number, avgEntryPrice: number, ratio: number, fractionPrice: number): AdjustResult`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/corporate-action-adjust.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { adjustForRatio } from '../../src/server/modules/backtest/domain/corporate-action-adjust.js';

describe('adjustForRatio', () => {
  it('5:1 분할은 수량을 5배로 늘리고 단가를 5분의 1로 줄인다', () => {
    const result = adjustForRatio(10, 100_000, 5, 20_000);
    expect(result.quantity).toBe(50);
    expect(result.avgEntryPrice).toBe(20_000);
    expect(result.cashFromFraction).toBe(0);
    expect(result.closed).toBe(false);
  });

  it('수량 × 단가를 보존한다', () => {
    const before = 7 * 30_000;
    const result = adjustForRatio(7, 30_000, 3, 10_000);
    expect(result.quantity * result.avgEntryPrice).toBe(before);
  });

  it('역분할 잔여를 현금으로 환산한다', () => {
    // 1:5 역병합(ratio 0.2) — 3주가 0.6주가 된다. 내림해 0주, 잔여 0.6주.
    const result = adjustForRatio(3, 10_000, 0.2, 50_000);
    expect(result.quantity).toBe(0);
    expect(result.cashFromFraction).toBeCloseTo(0.6 * 50_000, 6);
    expect(result.closed).toBe(true);
  });

  it('역분할에서 정수 몫이 남으면 포지션을 닫지 않는다', () => {
    // 12주 × 0.2 = 2.4주 → 2주 + 잔여 0.4주
    const result = adjustForRatio(12, 10_000, 0.2, 50_000);
    expect(result.quantity).toBe(2);
    expect(result.cashFromFraction).toBeCloseTo(0.4 * 50_000, 6);
    expect(result.closed).toBe(false);
  });

  it('단가는 잔여를 덜어내기 전 비율로 나눈다', () => {
    // 자산 보존: 조정 후 평가액 + 잔여 현금 = 조정 전 평가액
    const result = adjustForRatio(12, 10_000, 0.2, 50_000);
    expect(result.avgEntryPrice).toBe(50_000);
    expect(result.quantity * result.avgEntryPrice + result.cashFromFraction).toBeCloseTo(12 * 10_000, 6);
  });

  it('ratio 가 1 이면 아무것도 바꾸지 않는다', () => {
    const result = adjustForRatio(10, 100_000, 1, 100_000);
    expect(result).toEqual({
      quantity: 10,
      avgEntryPrice: 100_000,
      cashFromFraction: 0,
      closed: false,
    });
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run tests/unit/corporate-action-adjust.test.ts`
Expected: FAIL — `Failed to resolve import ".../corporate-action-adjust.js"`

- [ ] **Step 3: 구현한다**

**정정 (2026-08-08, Task 1 리뷰에서 발견): 아래 코드에 버그가 셋 있었다.** 실제로 커밋된 것은 `c82eb1d` 다. 이 계획서에서 브리프를 다시 만든다면 아래 코드를 그대로 쓰지 말고 그 커밋을 봐라.

1. `Math.floor(quantity * ratio)` 가 부동소수점 경계에서 한 주를 잃는다. `ratio = 3/11`, `quantity = 55` 면 `raw = 14.999999999999998` 이라 floor 이 14 다. `ratio` 는 DART 주식수 두 개의 나눗셈이라 임의 유리수가 나온다 — 정수만 오지 않는다. `ε = 1e-9` 안이면 반올림하고 아니면 내린다
2. `cashFromFraction` 주석의 "분할(ratio > 1)에서는 항상 0 이다" 가 거짓이다. `ratio = 1.5` 면 7주 × 1.5 = 10.5 로 잔여가 생긴다
3. `ratio <= 0` 이 무방비였다. `ratio === 0` 은 100% 무상감자라 포지션을 닫고 `avgEntryPrice: 0` 으로 돌려준다(0 으로 나누지 않는다). 음수는 받은 값을 담아 throw 한다

`src/server/modules/backtest/domain/corporate-action-adjust.ts`:

```ts
export interface AdjustResult {
  readonly quantity: number;
  readonly avgEntryPrice: number;
  /** 단주 잔여를 환산한 현금. 분할(ratio > 1)에서는 항상 0 이다 */
  readonly cashFromFraction: number;
  /** 조정 후 수량이 0 이 되어 포지션을 닫아야 하는가 */
  readonly closed: boolean;
}

/**
 * 자본변동 하나를 포지션 하나에 적용한다.
 *
 * 수량 × 단가를 보존하는 것이 규칙이다. 미실현 손익이 자본변동만으로 변하면 안 된다.
 *
 * 역분할은 수량이 정수로 떨어지지 않는다. 실제 제도가 단주를 현금으로 정산하므로
 * 내림하고 잔여를 현금으로 돌린다. 반올림하면 없던 주식이 생긴다.
 *
 * `fractionPrice` 는 효력발생일 봉의 시가다. 그 봉은 이미 자본변동 후 가격이라
 * 따로 환산하지 않는다.
 */
export function adjustForRatio(
  quantity: number,
  avgEntryPrice: number,
  ratio: number,
  fractionPrice: number,
): AdjustResult {
  const raw = quantity * ratio;
  const whole = Math.floor(raw);
  const fraction = raw - whole;
  return {
    quantity: whole,
    avgEntryPrice: avgEntryPrice / ratio,
    cashFromFraction: fraction * fractionPrice,
    closed: whole === 0,
  };
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/unit/corporate-action-adjust.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/backtest/domain/corporate-action-adjust.ts tests/unit/corporate-action-adjust.test.ts
git commit -m "feat(backtests): 자본변동을 포지션에 적용하는 함수를 더한다"
```

---

### Task 2: 엔진 봉 루프에 조정 단계를 끼운다

Task 1 의 함수를 엔진이 부르게 한다. 자리와 순서가 이 태스크의 핵심이다.

**Files:**
- Modify: `src/server/modules/backtest/domain/engine.ts:176-215`
- Test: `tests/unit/engine.test.ts`

**Interfaces:**
- Consumes: `adjustForRatio` (Task 1), `factView.corporateActions(symbol, tsMs)` (`src/server/modules/facts/domain/pit-fact-view.ts:182`)
- Produces: 엔진이 자본변동을 반영한다. 외부 시그니처는 바뀌지 않는다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/engine.test.ts` 에 추가한다. 기존 헬퍼를 재사용해라: `bar(index, price, overrides)`(25행), `buyAtBarStrategy(buyIndex, quantity)`(40행), `ZERO_COST`(19행), `START = Date.UTC(2026, 6, 6, 0, 0)`, `HOUR`.

**먼저 픽스처 함정을 해소해라.** 기존 `bar()` 는 `timeframe: '1d'` 인데 `tsMs` 를 `START + index * HOUR` 로 **한 시간씩** 띄운다. 자본변동 효력발생일은 `periodKey`(`'YYYY-MM-DD'`)에서 만들어지므로, 봉 간격이 한 시간이면 효력 시각이 어느 봉 사이에 떨어지는지 통제할 수 없다.

이 테스트들만 쓰는 **일 간격 봉 헬퍼**를 따로 만들어라:

```ts
const DAY = 86_400_000;

/** 자본변동 테스트 전용 — 효력발생일이 봉 사이에 정확히 떨어지도록 하루 간격으로 띄운다 */
function dailyBar(index: number, price: number): Candle {
  return { ...bar(index, price), tsMs: START + index * DAY };
}
```

**효력 시각을 직접 확인해라.** `pit-fact-view.ts` 가 `periodKey` 를 `effectiveTsMs` 로 어떻게 바꾸는지 읽고(거래소 현지 자정을 UTC 로 옮긴다), 그 값이 **분할 봉의 tsMs 이하이면서 직전 봉의 tsMs 보다 큰지** 단언으로 먼저 고정해라. 여기가 어긋나면 나머지 세 테스트가 조용히 엉뚱한 것을 검증한다.

```ts
it('효력발생일이 의도한 봉 사이에 떨어진다', () => {
  // periodKey 로 만든 effectiveTsMs 가 dailyBar(1).tsMs 초과, dailyBar(2).tsMs 이하
});

it('분할일을 걸쳐 보유하면 평가금액이 이어진다', () => {
  // 봉 0~3 종가 100_000 / 100_000 / 20_000 / 20_000, 봉 2 에 5:1 분할
  // buyAtBarStrategy(0, 10) 으로 10주 매수
  // equityPoints[1].equity 와 equityPoints[2].equity 가 같아야 한다 (ZERO_COST)
});

it('분할일 매도는 조정된 수량으로 체결된다', () => {
  // 봉 2 에 전량 매도 → fills 의 체결 수량이 50 이어야 한다 (10 × 5)
});

it('분할 후 진입한 포지션은 그 분할의 영향을 받지 않는다', () => {
  // buyAtBarStrategy(3, 10) → 봉 3 에서 10주 매수, 수량이 10 그대로여야 한다
});
```

`facts` 입력에는 `CORPORATE_ACTION_FIELD`(`'SPLIT_RATIO'`, `facts/domain/fact.ts:40`) 팩트를 넣는다 — `periodKey` 가 효력발생일(`'YYYY-MM-DD'`), `value` 가 배수다. `runBacktest` 의 `facts` 파라미터는 `engine.ts:42` 에 있다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run tests/unit/engine.test.ts`
Expected: 새 테스트 3개 FAIL. 평가금액이 −80% 로 떨어지고, 매도 수량이 조정되지 않는다

- [ ] **Step 3: 엔진에 조정 단계를 넣는다**

`engine.ts` 의 봉 루프에서 `factView.advanceTo(tsMs);` **바로 뒤**, `// 1~2. 대기 주문 체결` **바로 앞**에 넣는다:

```ts
    // 자본변동을 포지션에 반영한다 — 대기 주문 체결보다 먼저다. 분할일 매도 신호는
    // 조정된 수량으로 팔아야 한다.
    //
    // (prevTsMs, tsMs] 에 효력이 발생한 이벤트만 적용한다. 이 구간 판정이 "이미
    // 적용했는가" 를 종목별로 기억하지 않아도 되게 해 준다.
    for (const position of [...positions.values()]) {
      const bar = bars.get(position.symbol);
      if (!bar) continue; // 거래 정지 등으로 봉이 없으면 다음 봉에서 적용한다
      const due = factView
        .corporateActions(position.symbol, tsMs)
        .filter((action) => action.effectiveTsMs > prevTsMs);
      if (due.length === 0) continue;
      // 같은 날 여러 이벤트는 배수를 곱해 합성한다 — 순서에 무관하다
      const ratio = due.reduce((acc, action) => acc * action.ratio, 1);
      if (ratio === 1) continue;
      const adjusted = adjustForRatio(position.quantity, position.avgEntryPrice, ratio, bar.open);
      cash += adjusted.cashFromFraction;
      if (adjusted.closed) {
        positions.delete(position.symbol);
        continue;
      }
      position.quantity = adjusted.quantity;
      position.avgEntryPrice = adjusted.avgEntryPrice;
    }
```

루프 시작 전에 `let prevTsMs = -1;` 을 선언하고, 루프 **끝**에서 `prevTsMs = tsMs;` 로 갱신한다. 첫 봉에서는 포지션이 비어 있어 과거 이벤트가 모두 "due" 로 잡혀도 아무 일도 일어나지 않는다.

import 를 더한다:

```ts
import { adjustForRatio } from './corporate-action-adjust.js';
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/unit/engine.test.ts`
Expected: PASS. 기존 엔진 테스트도 전부 통과해야 한다 — 자본변동 팩트가 없는 테스트는 `due` 가 비어 아무것도 하지 않는다

Run: `pnpm vitest run tests/unit/`
Expected: 실패 0

- [ ] **Step 5: 낡은 경고 문구를 고친다**

`engine.ts:300-302` 의 경고가 "보정을 사용하는 전략의 신호 계산에만 반영됩니다" 라고 말한다. 이제 포지션도 반영하므로 사실이 아니다. 무엇이 반영되고 무엇이 안 되는지 정확히 다시 쓴다 — 포지션 수량·평균단가는 반영되고, 이미 체결된 거래의 체결가는 그대로다.

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/backtest/domain/engine.ts tests/unit/engine.test.ts
git commit -m "fix(backtests): 분할을 걸친 보유 포지션을 조정한다"
```

---

### Task 3: 봉을 구조적 불변으로 만들고 OHLC 를 검사한다

설계 §4.1·§4.2 다. 엔진과 독립이라 따로 간다.

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts` (`writeDailyBars`)
- Test: `tests/unit/symbol-master-daily-bars.test.ts`

**Interfaces:**
- Consumes: `isValidCandle` (`src/server/modules/market-data/domain/candle.ts:22`)
- Produces: 없음 — 내부 동작만 바뀐다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/symbol-master-daily-bars.test.ts` 에 추가한다. 기존 테스트가 `ingestDate` 를 어떻게 부르는지 읽고 그 패턴을 따른다.

```ts
it('이미 있는 날짜의 봉을 덮어쓰지 않는다', async () => {
  // 같은 (shortCode, date) 로 다른 값을 다시 쓰려 해도 기존 값이 유지된다
});

it('high < low 인 행을 저장하지 않는다', async () => {
  // KRX 응답에 어긋난 행을 섞고, 그 종목의 봉이 저장되지 않았는지 본다
});

it('어긋난 행 건수를 로그에 남긴다', async () => {
  // logger.debug 호출을 확인한다 — null 행을 다루는 기존 방식과 같다
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run tests/unit/symbol-master-daily-bars.test.ts`
Expected: 새 테스트 FAIL

- [ ] **Step 3: `writeDailyBars` 를 고친다**

`onConflictDoUpdate` 블록을 `onConflictDoNothing()` 으로 바꾼다. `set` 절이 통째로 사라진다.

주석을 새로 쓴다 — 왜 덮어쓰지 않는지:

```ts
    // 이미 있는 날짜는 건드리지 않는다. 자본변동은 계산 시점에 반영하므로(설계
    // 2026-08-08-corporate-action-continuity) 봉을 고쳐 받을 이유가 없다.
    // ingestDate 의 isCovered 게이트가 이미 재수집을 막지만, 저장 계층도 같은
    // 규칙을 말해야 읽는 사람이 "봉이 바뀔 수 있다" 고 오해하지 않는다.
```

행을 만드는 루프에서 null 검사 다음에 OHLC 검사를 더한다. `isValidCandle` 은 `Candle` 을 받으므로 `krxDailyBars` 행이 아니라 그 앞 단계에서 검사하거나, 같은 조건을 직접 쓴다. **`isValidCandle` 을 재사용하는 쪽을 택해라** — 검사 규칙이 두 벌이 되면 갈라진다. `Candle` 을 만들어 넘기고 통과한 것만 행으로 바꾼다.

건너뛴 건수는 기존 `skipped` 와 **따로 센다.** null 때문에 건너뛴 것과 값이 어긋나 건너뛴 것은 원인이 다르다 — 로그에서 구분돼야 한다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/unit/symbol-master-daily-bars.test.ts tests/unit/krx-daily-bars-schema.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/symbol-master-service.ts tests/unit/symbol-master-daily-bars.test.ts
git commit -m "fix(market-data): 봉을 덮어쓰지 않고 어긋난 행을 거른다"
```

---

### Task 4: 자본변동 커버리지 저장소

설계의 "커버리지를 따로 기록한다" 와 "gap 을 저장해야 한다" 다.

**Files:**
- Modify: `src/server/shared/db/schema.ts` (`symbolFactsState`)
- Create: `src/server/modules/facts/application/corporate-action-coverage.ts`
- Create: `tests/unit/corporate-action-coverage.test.ts`
- Create: `migrations/<생성됨>.sql`

**Interfaces:**
- Consumes: `AppDatabase`, `symbolFactsState`
- Produces:
  - `export interface CorporateActionCoverageStore { getCoveredYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]>; getGapYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]>; addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void; addGapYears(symbol: string, years: readonly number[], nowMs: number): void; }`
  - `export class SqliteCorporateActionCoverageStore implements CorporateActionCoverageStore`

- [ ] **Step 1: 스키마에 컬럼을 더한다**

`symbolFactsState` 에 두 컬럼을 더한다. 기존 `coveredYearsJson` 은 **재무용으로 그대로 둔다**:

```ts
  /** 자본변동을 수집한 연도 (number[] 오름차순 JSON). 제출 게이트가 읽는다 */
  actionCoveredYearsJson: text('action_covered_years_json'),
  /** 자본변동 수집에서 gap 이 난 연도 (number[] 오름차순 JSON). 경고가 읽는다 */
  actionGapYearsJson: text('action_gap_years_json'),
```

둘 다 nullable 이다 — 기존 행에 값이 없다.

Run: `pnpm db:generate`
Expected: `migrations/` 에 새 `.sql` 과 스냅샷이 생긴다

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`tests/unit/corporate-action-coverage.test.ts`. `createTestApp()` 의 컨테이너 DB 를 쓰고 `afterEach` 에서 닫는다 — `tests/unit/krx-daily-bars-schema.test.ts` 가 본보기다.

```ts
it('수집 연도를 합집합으로 더한다', () => { /* [2025] + [2026] = [2025, 2026] */ });
it('gap 연도를 따로 관리한다', () => { /* covered 와 gap 이 섞이지 않는다 */ });
it('재무 커버리지를 건드리지 않는다', () => { /* coveredYearsJson 이 그대로다 */ });
it('없는 종목은 빈 목록을 준다', () => {});
it('연도를 오름차순으로 돌려준다', () => {});
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run tests/unit/corporate-action-coverage.test.ts`
Expected: FAIL — 모듈을 찾을 수 없다

- [ ] **Step 4: 저장소를 구현한다**

`fact-coverage-store.ts` 의 `SqliteFactCoverageStore` 를 본보기로 삼는다. `parseYears` 같은 헬퍼가 거기 있으니 재사용할지 복제할지 판단해라 — **재사용을 우선한다.** 필요하면 그 파일에서 export 한다.

`addCoveredYears` 의 기존 주석("빈 목록은 기록하지 않는다 — 아무것도 수집하지 않은 종목에 행을 만들면 '수집됨' 과 '수집할 게 없었음' 이 구분되지 않는다")과 같은 판단을 따라야 하는지 검토하고, 자본변동에서는 어떻게 할지 결정해 주석에 남겨라.

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/unit/corporate-action-coverage.test.ts`
Expected: PASS

Run: `pnpm typecheck`
Expected: 오류 0

- [ ] **Step 6: 커밋**

```bash
git add src/server/shared/db/schema.ts src/server/modules/facts/application/corporate-action-coverage.ts tests/unit/corporate-action-coverage.test.ts migrations/
git commit -m "feat(facts): 자본변동 수집·gap 연도를 따로 기록한다"
```

---

### Task 5: 자본변동 전용 수집 경로

`FactSyncService` 에 재무를 건너뛰는 경로를 낸다.

**Files:**
- Modify: `src/server/modules/facts/application/fact-sync-service.ts`
- Test: `tests/unit/fact-sync-service.test.ts`

**Interfaces:**
- Consumes: `CorporateActionCoverageStore` (Task 4), `FactSource.fetchCorporateActions` (`facts/application/ports.ts:68`)
- Produces: `syncCorporateActions(request: FactSyncRequest, hooks?: FactSyncHooks): Promise<FactSyncReport>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

기존 `tests/unit/fact-sync-service.test.ts` 의 fake source 패턴을 읽고 따른다.

```ts
it('재무를 부르지 않는다', async () => {
  // fake source 의 fetchFinancials 호출 수가 0 이어야 한다
});
it('자본변동 커버리지만 갱신한다', async () => {
  // actionCoveredYears 는 늘고 재무 coveredYears 는 그대로다
});
it('gap 이 난 연도를 기록한다', async () => {
  // fake 가 gap 을 돌려주면 actionGapYears 에 남는다
});
it('gap 이 나도 커버리지는 기록한다', async () => {
  // "물어봤다" 는 사실은 남아야 게이트가 영원히 막지 않는다
});
it('종목마다 저장해 중단 지점까지 남는다', async () => {});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run tests/unit/fact-sync-service.test.ts`
Expected: 새 테스트 FAIL

- [ ] **Step 3: 구현한다**

기존 `sync` 를 복제하지 마라. 종목 루프·저장·취소·리포트 조립이 같으므로 **공통 부분을 뽑아 재사용한다.** 갈리는 것은 "무엇을 fetch 하는가" 와 "어느 커버리지를 갱신하는가" 둘뿐이다.

`planFactSync` 는 그대로 쓴다 — 자본변동은 `shareYears` 를 쓰므로 계획 함수가 이미 맞다. 다만 `calls` 추정이 재무 호출을 포함하므로, 자본변동 전용 추정이 필요하면 그 부분을 나눠야 한다. **`sync-plan.ts` 를 읽고 판단해 리포트에 근거를 적어라.**

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/unit/fact-sync-service.test.ts tests/unit/sync-plan.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/facts/application/fact-sync-service.ts tests/unit/fact-sync-service.test.ts
git commit -m "feat(facts): 자본변동만 수집하는 경로를 더한다"
```

---

### Task 6: 제출 게이트

**Files:**
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts`
- Modify: `src/server/bootstrap/container.ts`, `src/server/bootstrap/server.ts`
- Test: `tests/integration/backtest-universe-rule-run.test.ts`

**Interfaces:**
- Consumes: `CorporateActionCoverageStore` (Task 4)
- Produces: `BacktestRouteDeps` 에 `corporateActionCoverage` 추가

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Task 6 의 등록 게이트 테스트(같은 파일에 있다)를 본보기로 삼는다.

```ts
it('자본변동을 수집하지 않은 종목이 있으면 400 이다', async () => {
  // 봉과 등록은 있고 자본변동 커버리지만 없는 종목 → 400, 큐에 안 들어감
});
it('수집했고 분할이 없는 종목은 통과한다', async () => {
  // 커버리지만 있고 팩트 0건 → 200
});
it('gap 이 난 종목은 통과하고 경고에 이름이 나온다', async () => {
  // 커버리지 + gap → 200, warnings 에 그 종목코드
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run tests/integration/backtest-universe-rule-run.test.ts`
Expected: 새 테스트 FAIL

- [ ] **Step 3: 게이트를 넣는다**

`validateSubmission` 안, 등록 게이트 옆이다. 백테스트 기간이 걸치는 연도를 구해 유니버스 각 종목의 자본변동 커버리지와 대조한다.

- 커버리지에 그 연도가 없는 종목이 하나라도 있으면 **400**. 에러 메시지에 그 종목들을 이름으로 담는다
- 커버리지는 있는데 gap 연도가 걸치면 **통과 + 경고**. 경고에 그 종목들을 이름으로 담는다

경고 문구는 합쇼체다. 무엇이 위험한지 말한다 — 분할이 있었다면 결과가 틀어진다는 것.

**기간 끝이 최근이면 아직 공시되지 않은 자본변동이 있을 수 있다는 경고를 함께 남긴다** (설계의 "게이트가 보장하지 못하는 것"). 이 경고는 커버리지가 온전해도 뜬다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/integration/`
Expected: 실패 0. 기존 통합 테스트가 자본변동 커버리지 없이 제출하고 있으면 픽스처에 커버리지를 심어야 한다 — **테스트를 약하게 만들지 말고 픽스처를 고쳐라**

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "feat(backtests): 자본변동 미수집이면 제출을 막는다"
```

---

### Task 7: 수집 잡과 SSE 라우트

**Files:**
- Modify: `src/server/shared/db/schema.ts` (새 테이블)
- Create: `src/server/modules/facts/presentation/corporate-action-routes.ts`
- Modify: `src/server/bootstrap/container.ts`, `src/server/bootstrap/server.ts`
- Create: `migrations/<생성됨>.sql`
- Test: `tests/integration/corporate-action-sync.test.ts`

**Interfaces:**
- Consumes: `syncCorporateActions` (Task 5)
- Produces: 라우트 — 잡 생성(POST), 조회(GET), 취소(POST), 진행률(SSE)

- [ ] **Step 1: 잡 테이블을 만든다**

`data_sync_jobs` 를 되살리지 않는다. 자본변동 수집 하나만 담는 좁은 테이블이다. 담을 것:

- 잡 id, 상태(QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED)
- 대상 종목 목록, 대상 연도 범위
- 진행 — 완료 종목 수, 전체 종목 수
- 결과 — 저장 팩트 수, gap 건수
- 실패 사유, 생성·완료 시각

컬럼 이름과 타입은 기존 `backtestJobs` 의 관례를 따른다. `pnpm db:generate` 로 마이그레이션을 만든다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`tests/integration/corporate-action-sync.test.ts`. 기존 통합 테스트의 `createTestApp` + 인증 패턴을 따른다.

```ts
it('잡을 만들고 진행률을 준다', async () => {});
it('취소하면 그 지점까지 저장된 커버리지가 남는다', async () => {});
it('동시에 두 잡을 만들지 않는다', async () => {});
it('끝나면 커버리지가 늘어 게이트가 통과한다', async () => {});
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run tests/integration/corporate-action-sync.test.ts`
Expected: FAIL

- [ ] **Step 4: 라우트를 구현한다**

SSE 는 백테스트 진행률(`GET /backtests/:id/events`)의 패턴을 그대로 따른다 — 그 코드를 먼저 읽어라.

`syncCorporateActions` 의 `hooks.onSymbolDone` 을 SSE 로 흘린다. 취소는 `sync` 가 이미 다루는 `stopReason: 'CANCELLED'` 경로를 쓴다.

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/integration/`
Expected: 실패 0

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat(facts): 자본변동 수집 잡과 진행률 라우트를 더한다"
```

---

### Task 8: 위저드 게이트 화면

**Files:**
- Create: `src/web/features/backtests/corporate-action-gate.tsx`
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx`
- Test: `tests/unit/corporate-action-gate.test.ts` (순수 로직만)

**Interfaces:**
- Consumes: Task 7 의 라우트
- Produces: 위저드가 미수집 종목을 안내하고 수집을 띄운다

- [ ] **Step 1: 화면을 만든다**

제출이 막힌 자리에 붙인다. 설계의 화면 구성을 따른다:

```
자본변동 이력이 없는 종목 23개가 있습니다.
액면분할이 있었다면 결과가 틀어집니다.

수집 대상: 23종목 × 2025–2026년
예상 호출: 약 690회 · 예상 시간 약 4분

[자본변동 이력 수집]
```

숫자는 서버가 준다 — `planFactSync` 결과를 라우트가 돌려주게 한다. **화면이 따로 추정하지 마라.** 실행과 추정이 갈리면 안 된다.

수집 중에는 진행률(완료/전체)을 보여주고 취소 버튼을 둔다.

- [ ] **Step 2: 끝난 뒤 게이트를 다시 평가한다**

수집이 끝나면 미리보기를 다시 불러 게이트를 재평가한다. 통과하면 제출 버튼이 열린다.

여전히 실패한 종목이 있으면 **이름으로 밝힌다.** "일부 실패" 로 뭉뚱그리지 않는다.

- [ ] **Step 3: 검증한다**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`
Expected: 전부 통과

- [ ] **Step 4: 커밋**

```bash
git add -A
git commit -m "feat(web): 자본변동 미수집을 안내하고 일괄 수집을 붙인다"
```

---

### Task 9: 전략 상태의 가격도 분할을 넘게 한다

**추가 (2026-08-08, Task 2 리뷰가 범위 밖에서 발견):** 이 계획은 포지션 수량만 봤다. 전략이 봉 사이에 들고 다니는 **가격 상태**는 그대로 남는다.

`src/server/modules/strategy/strategies/shared/trailing-stop.ts:9-17` 의 `HoldingState` 가 세 가격 필드를 갖는다 — `entryAtr`, `stopLevel`, `highestClose`. 전부 분할 전 단위다.

5:1 분할 후 원본 종가가 1/5 로 떨어지면 `close < stopLevel` 이 즉시 참이 된다. `ema-trend-switch`·`rsi-reversion`·`range-breakout` 이 **허위 스톱 청산**을 낸다. 우리가 고친 것과 같은 병이고 자리만 다르다.

**전략이 스스로 처리하게 두지 않는다.** `context.corporateActions(symbol)` 는 "그 시점까지 전부" 를 주지 "이번 봉에 새로 생긴 것" 을 주지 않는다. 전략마다 커서를 두면 Task 2 가 네 라운드에 걸쳐 푼 문제를 전략 수만큼 다시 만든다. 엔진은 이미 `due` 와 합성 `ratio` 를 정확한 시점에 계산하므로 그것을 전략에 넘긴다.

**Files:**
- Modify: `src/server/modules/strategy/domain/strategy.ts` (선택적 훅 추가)
- Modify: `src/server/modules/backtest/domain/engine.ts` (조정 루프에서 훅 호출)
- Modify: `src/server/modules/strategy/strategies/shared/trailing-stop.ts` (가격 필드 스케일 헬퍼)
- Modify: `ema-trend-switch.ts`, `rsi-reversion.ts`, `range-breakout.ts` (훅 구현)
- Test: `tests/unit/trailing-stop.test.ts`(없으면 신설), `tests/unit/engine.test.ts`

**Interfaces:**
- Produces: `TradingStrategy` 에 선택적 훅. 이름·시그니처는 기존 `onBars` 관례를 읽고 맞춰라. 엔진이 종목과 합성 `ratio` 를 넘기고, 전략이 자기 상태를 고친다
- Produces: `trailing-stop.ts` 에 `HoldingState` 의 세 가격 필드를 `ratio` 로 나누는 함수. `null` 필드는 그대로 둔다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

두 층이다.

`tests/unit/engine.test.ts` — 분할일에 훅이 불리는지, 그리고 **불리지 않아야 할 때 안 불리는지**:

```ts
it('분할 효력 봉에서 전략의 자본변동 훅을 부른다', () => {
  // 훅 호출을 기록하는 가짜 전략. 심볼과 합성 ratio 가 정확한지 단언
});

it('자본변동이 없는 봉에서는 훅을 부르지 않는다', () => {
  // 호출 0회
});
```

전략 층 — 허위 스톱 청산이 실제로 사라지는지:

```ts
it('분할 후에도 스톱이 발동하지 않는다', () => {
  // 진입가 100_000, 스톱 90_000. 5:1 분할로 종가가 20_000 이 된다.
  // 조정 없으면 즉시 청산되고, 조정하면 스톱이 18_000 이라 살아남는다
});
```

기존 전략 테스트의 `HoldingState` 조립 패턴을 먼저 읽고 그것을 따라라 — `ema-trend-switch.ts` 를 겨누는 테스트가 이미 있다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run tests/unit/engine.test.ts tests/unit/ema-trend-switch.test.ts`
Expected: 새 테스트 FAIL. **허위 청산이 실제로 일어나는 것을 출력에서 확인하고 리포트에 적어라** — 이 태스크가 고치는 것이 그것이다.

- [ ] **Step 3: 훅과 스케일 함수를 만든다**

`trailing-stop.ts` 의 함수는 `null` 을 보존한다. 진입 확인 전(`entryAtr === null`)에 분할이 나면 고칠 값이 없다.

엔진은 **포지션 조정과 같은 자리에서** 훅을 부른다. 순서는 대기 주문 체결보다 먼저다 — 스톱 판정이 조정된 값으로 나야 한다.

훅은 **선택적**이다. 구현하지 않은 전략은 영향이 없어야 한다.

- [ ] **Step 4: 세 전략에 훅을 붙인다**

`ema-trend-switch`, `rsi-reversion`, `range-breakout` 이 `HoldingState` 를 쓴다. 각자 자기 상태 맵을 순회해 해당 종목 항목을 고친다.

**전략마다 상태를 어디에 어떻게 들고 있는지 다르다.** 각 파일을 읽고 맞춰라. 세 곳에 같은 코드를 복사하게 되면 `trailing-stop.ts` 로 올려라.

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm test`
Expected: 0 fail. 기준선은 이 태스크 시작 시점의 통과 수다

**각 테스트의 판별력을 되돌려-깨뜨려 확인해라.** 훅 호출을 지우면 스톱 테스트가 깨져야 한다. 확인 방법을 리포트에 적어라 — 이 계획에서 "통과 확인" 만으로 세 번 놓쳤다.

- [ ] **Step 6: `ENGINE_VERSION` 을 올린다**

`engine.ts:83` 의 `ENGINE_VERSION` 이 `1.3.0` 그대로다. 이 계획이 체결 수량·평균단가·스톱 판정을 바꾸므로 §9.5 재현성 기준으로 올려야 한다. 기존 버전 증가 관례를 확인하고 맞춰라.

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "fix(backtests): 전략이 들고 있는 가격 상태도 분할을 넘게 한다"
```

---

### Task 10: e2e·문서·최종 검증

**Files:**
- Modify: `tests/e2e/mvp-flow.spec.ts`, `scripts/e2e-server.ts`
- Modify: `docs/DECISIONS.md`, `docs/SPEC.md`

- [ ] **Step 1: e2e 를 고친다**

제출 게이트가 생겼으므로 e2e 픽스처가 자본변동 커버리지를 갖춰야 한다. `scripts/e2e-server.ts` 의 가짜 DART 응답에 자본변동을 더하거나, 커버리지를 직접 심는다. **어느 쪽을 택했는지 근거를 남겨라.**

Run: `pnpm test:e2e`
Expected: 통과. **백그라운드로 띄운 서버를 반드시 정리해라** — 남으면 다음 실행이 포트 충돌과 `.e2e-data` 오염으로 죽는다

- [ ] **Step 2: 결정 기록을 남긴다**

`docs/DECISIONS.md` 에 D-043 을 더한다. 다음 번호가 맞는지 `grep -n "^## D-0" docs/DECISIONS.md | tail -3` 로 확인해라 — 앞선 계획이 번호를 잘못 가정한 적이 있다.

담을 것: 엔진이 분할을 걸친 포지션·대기 주문·전략 가격 상태를 조정하지 않아 결과가 조용히 틀렸다는 것, 원본 봉을 고치지 않고 계산 시점에 반영하기로 한 이유, 게이트가 커버리지로 막고 gap 은 경고만 하는 이유(상장폐지 종목이 영원히 막히면 생존편향 제거와 충돌한다), 봉을 `onConflictDoNothing` 으로 바꾼 이유.

- [ ] **Step 3: 스펙을 갱신한다**

`docs/SPEC.md` 에서 자본변동 처리와 제출 게이트를 다루는 절을 찾아 고친다. 절 번호를 바꾸지 마라 — 코드가 `스펙 §11` 식으로 인용한다.

- [ ] **Step 4: 전체 검증**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`
Expected: 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "docs(decisions): 자본변동 포지션 연속성 결정을 남긴다"
```

---

## 후속 계획 B 에 넘기는 것

- **`data_sync_jobs` 는 "삭제" 가 아니라 "좁은 테이블로 교체" 다.** 이 계획이 새 테이블을 만들었으므로 B 는 옛 테이블만 지운다
- 이 계획이 더한 마이그레이션 두 개(컬럼·테이블)는 B 의 스쿼시에 함께 접힌다
