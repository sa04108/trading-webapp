# 상장폐지 청산과 거래불가일 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 봉이 없는 날의 원인을 상장폐지·거래불가·알 수 없음으로 나눠, 폐지 종목은 마지막 실거래가로 청산하고 거래불가 종목은 유니버스·체결에서 빼고, 실행 경고가 실제 보정 상태를 말하게 한다.

**Architecture:** KRX 일별매매정보가 이미 주고 있으나 `isValidCandle` 이 버리던 거래불가 행을 새 테이블 `krx_non_trading_days` 에 저장한다. 봉 테이블은 건드리지 않아 `Candle` 타입과 전략 코드가 그대로다. 엔진은 워커가 조립한 거래불가 집합과 폐지 시점 맵을 받아 매수 후보에서 빼고 마지막 거래 가능 봉 종가로 강제 청산한다.

**Tech Stack:** TypeScript 5.9 / Node 24(운영)·22(개발) / drizzle-orm + better-sqlite3 v12 / vitest / Playwright / React

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-08-08-delisting-and-non-trading-days-design.md`
- 한국어 문서·주석 규칙은 `CLAUDE.md` 를 따른다. 문어체 평서형(~한다/~이다), 번역투 금지, 주석은 "왜" 를 쓴다.
- **없는 가격을 만들지 않는다.** KRX 가 준 값만 저장하고 계산한다. flat 봉(`O=H=L=C`) 합성 금지.
- 거래정지와 무거래를 나누지 않는다. 이름은 `halted` 가 아니라 `non_trading` 이다.
- `krx_non_trading_days.last_close` 는 평가용이다. **체결가로 절대 쓰지 않는다.**
- 폐지 청산가는 엔진 타임라인에 실제로 들어온 그 종목의 마지막 봉 종가다.
- 청산에 수수료·매도세·슬리피지를 정상 매도와 똑같이 적용한다.
- 폐지 정보를 `StrategyBarContext` 에 노출하지 않는다.
- 각 태스크 끝에 `pnpm lint && pnpm typecheck && pnpm test` 가 통과해야 한다.
- 커밋 메시지는 한국어 conventional commit 이다 (`feat(engine):`, `fix(test):`, `docs(specs):` 등).

---

## File Structure

**신규**

| 파일 | 책임 |
|---|---|
| `src/server/modules/market-data/domain/non-trading-day.ts` | KRX 일별 행이 거래불가인지 판정하는 순수 함수 |
| `tests/unit/non-trading-day.test.ts` | 위 판정 함수 단위 테스트 |
| `tests/unit/engine-non-trading.test.ts` | 엔진의 거래불가·강제청산 단위 테스트 |
| `tests/unit/symbol-master-non-trading.test.ts` | 수집·조회·백필이 테이블을 채우는지 (fake KRX 서버) |
| `tests/unit/universe-rule-resolver-non-trading.test.ts` | 유니버스가 거래불가 종목을 빼는지 |
| `migrations/0012_*.sql` | `drizzle-kit generate` 산출물 |

**수정**

| 파일 | 변경 |
|---|---|
| `src/server/shared/db/schema.ts` | 테이블 둘 추가 |
| `src/server/modules/market-data/application/symbol-master-service.ts` | `writeDailyBars` 분기, 백필, 조회 메서드, 주석 정정 |
| `src/server/cli.ts` | `krx:backfill-non-trading` 케이스 |
| `src/server/modules/backtest/application/universe-rule-resolver.ts` | 거래불가 종목 후보 제외 |
| `src/server/modules/strategy/domain/strategy.ts` | `onForcedExit` 훅 |
| `src/server/modules/backtest/domain/engine.ts` | 입력 둘, 후보 제외, 강제 청산, 경고 재작성, 버전 |
| `src/server/modules/backtest/domain/types.ts` | `OpenPositionSnapshot.lastPriceTsMs` |
| `src/workers/backtest-child.ts` | 엔진 입력 조립 |
| `src/web/features/backtests/backtest-detail-page.tsx` | 청산·제외·stale 표시 |
| `docs/IMPLEMENTATION_STATUS.md`, `docs/DECISIONS.md` | 상태 갱신 |

---

## Task 1: 거래불가 판정 함수

**Files:**
- Create: `src/server/modules/market-data/domain/non-trading-day.ts`
- Test: `tests/unit/non-trading-day.test.ts`

**Interfaces:**
- Consumes: `KrxDailyTradeRow` (`src/server/modules/market-data/domain/krx-universe-types.ts`) — 필드는 `shortCode, name, marketCapRaw, open, high, low, close, volume` 이고 수치는 `number | null` 이다.
- Produces: `isNonTradingRow(row: KrxDailyTradeRow): boolean`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/non-trading-day.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isNonTradingRow } from '../../src/server/modules/market-data/domain/non-trading-day.js';
import type { KrxDailyTradeRow } from '../../src/server/modules/market-data/domain/krx-universe-types.js';

function row(partial: Partial<KrxDailyTradeRow>): KrxDailyTradeRow {
  return {
    shortCode: '000000',
    name: '테스트',
    marketCapRaw: '1000',
    open: 1_000,
    high: 1_100,
    low: 900,
    close: 1_050,
    volume: 10_000,
    ...partial,
  };
}

describe('isNonTradingRow', () => {
  // 실측(2026-08-08, scripts/krx-halt-probe.ts): 정지 종목은 시·고·저가 0, 종가는 직전가, 거래량 0으로 온다
  it('신라젠 2021-06-15 정지 행을 거래불가로 본다', () => {
    expect(isNonTradingRow(row({ open: 0, high: 0, low: 0, close: 12_100, volume: 0 }))).toBe(true);
  });

  it('성안 저유동성 무거래 행도 같은 모양이라 거래불가로 본다', () => {
    expect(isNonTradingRow(row({ open: 0, high: 0, low: 0, close: 787, volume: 0 }))).toBe(true);
  });

  it('오스템임플란트 2021-06-15 정상 거래 행은 아니다', () => {
    expect(
      isNonTradingRow(row({ open: 98_000, high: 99_500, low: 97_400, close: 99_400, volume: 113_801 })),
    ).toBe(false);
  });

  // 아래 셋은 "거래불가가 아닌 이상 행" 이다 — invalidCount 로 남아야 파싱 버그를 찾을 수 있다
  it('종가까지 0이면 거래불가가 아니다', () => {
    expect(isNonTradingRow(row({ open: 0, high: 0, low: 0, close: 0, volume: 0 }))).toBe(false);
  });

  it('시·고·저가 0인데 거래량이 있으면 거래불가가 아니다', () => {
    expect(isNonTradingRow(row({ open: 0, high: 0, low: 0, close: 900, volume: 500 }))).toBe(false);
  });

  it('null 이 섞인 행은 거래불가가 아니다', () => {
    expect(isNonTradingRow(row({ open: null, high: 0, low: 0, close: 900, volume: 0 }))).toBe(false);
  });

  it('high < low 같은 파싱 버그 행은 거래불가가 아니다', () => {
    expect(isNonTradingRow(row({ open: 1_000, high: 900, low: 1_100, close: 1_000, volume: 5 }))).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/non-trading-day.test.ts`
Expected: FAIL — `Failed to resolve import ".../non-trading-day.js"`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/server/modules/market-data/domain/non-trading-day.ts`:

```ts
import type { KrxDailyTradeRow } from './krx-universe-types.js';

/**
 * KRX 일별매매정보 행이 "그날 거래할 수 없었던" 행인지 본다.
 *
 * 실측(2026-08-08, scripts/krx-halt-probe.ts)에서 확인한 모양이다 —
 * 시·고·저가 "0", 종가는 직전 종가 유지, 거래량 0. `null` 로 오지 않는다.
 *
 * 거래정지와 무거래를 나누지 않는다. KRX 응답이 둘을 구분해 주지 않고,
 * 체결 관점에서 둘은 같은 사건이다 — 어느 쪽이든 그날 살 수도 팔 수도 없다.
 * 사유를 알려면 KIND 매매거래정지 공시가 따로 필요하다.
 *
 * 종가가 0 이하이거나 `null` 이 섞인 행은 여기서 걸러지지 않는다.
 * 그런 행은 원인이 다르므로 `invalidCount` 로 남아 파싱 버그를 드러내야 한다.
 */
export function isNonTradingRow(row: KrxDailyTradeRow): boolean {
  return (
    row.open === 0
    && row.high === 0
    && row.low === 0
    && row.volume === 0
    && row.close !== null
    && row.close > 0
  );
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/non-trading-day.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 검증 게이트**

Run: `pnpm lint && pnpm typecheck`
Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/market-data/domain/non-trading-day.ts tests/unit/non-trading-day.test.ts
git commit -m "feat(market-data): KRX 거래불가일 판정 함수를 추가한다"
```

---

## Task 2: 테이블 둘과 마이그레이션

**Files:**
- Modify: `src/server/shared/db/schema.ts` (`symbolMasterCoverage` 정의 아래, 약 537행)
- Create: `migrations/0012_*.sql` (생성물)

**Interfaces:**
- Produces: `krxNonTradingDays`, `krxNonTradingCoverage` drizzle 테이블. 컬럼은 아래 코드 그대로다.

- [ ] **Step 1: 스키마를 추가한다**

`src/server/shared/db/schema.ts` 의 `symbolMasterCoverage` 정의 바로 아래에 넣는다:

```ts
/**
 * 그날 거래할 수 없었던 종목 (거래정지·무거래). 봉이 아니라 사실 기록이다.
 *
 * `krx_daily_bars` 에 섞지 않는 이유: KRX 는 시·고·저를 주지 않는다. 봉으로 채우려면
 * 없는 가격을 지어내야 한다. 테이블을 나눠 두면 청산 코드가 `lastClose` 를 체결가로
 * 쓰는 실수를 타입 경계에서 막을 수 있다.
 */
export const krxNonTradingDays = sqliteTable(
  'krx_non_trading_days',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    date: text('date').notNull(),
    shortCode: text('short_code').notNull(),
    market: text('market').notNull(), // KOSPI | KOSDAQ
    /** TDD_CLSPRC 원값 — **평가용이지 체결 가능 가격이 아니다** */
    lastClose: integer('last_close').notNull(),
  },
  (table) => [
    uniqueIndex('idx_kntd_date_code').on(table.date, table.shortCode),
    index('idx_kntd_date').on(table.date),
  ],
);

/**
 * 거래불가일을 채운 날짜 구간. 행이 없는 날짜가 "거래불가 종목이 없었다" 인지
 * "아직 모른다" 인지는 이 기록으로만 갈린다. symbol_master_coverage 와 같은 구조다.
 */
export const krxNonTradingCoverage = sqliteTable('krx_non_trading_coverage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  syncedAtMs: integer('synced_at_ms').notNull(),
});
```

`index` 와 `uniqueIndex` 는 이 파일이 이미 import 하고 있다. 없으면 `drizzle-orm/sqlite-core` 에서 가져온다.

- [ ] **Step 2: 마이그레이션을 생성한다**

Run: `pnpm db:generate`
Expected: `migrations/0012_*.sql` 과 `migrations/meta/0012_snapshot.json` 생성. SQL 에 `CREATE TABLE \`krx_non_trading_days\`` 와 `CREATE TABLE \`krx_non_trading_coverage\`` 가 들어 있어야 한다.

- [ ] **Step 3: 검증 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: 기존 테스트 전부 통과 (새 테이블은 아직 아무도 안 쓴다)

- [ ] **Step 4: 커밋**

```bash
git add src/server/shared/db/schema.ts migrations/
git commit -m "feat(db): 거래불가일 테이블과 커버리지 테이블을 추가한다"
```

---

## Task 3: 수집이 거래불가일을 기록한다

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts:588-683` (`writeDailyBars`)
- Test: `tests/unit/symbol-master-non-trading.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `isNonTradingRow`, Task 2 의 `krxNonTradingDays`
- Produces: `ingestDate` 가 도는 날짜마다 `krx_non_trading_days` 행이 쌓인다. 반환 타입은 바꾸지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/symbol-master-daily-bars.test.ts` 의 `setup`/`teardown` 구조를 그대로 쓴다 — fake KRX 서버(`tests/helpers/krx-fixtures.ts`)를 띄우고 `SymbolMasterService` 를 직접 만든다.

`tests/unit/symbol-master-non-trading.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { krxDailyBars, krxNonTradingDays } from '../../src/server/shared/db/schema.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SYMBOL_MASTER_NON_TRADING_TEST_KEY';
const NOOP_SLEEP = async () => undefined;

interface Ctx {
  readonly t: TestApp;
  readonly fake: KrxFakeServer;
  readonly svc: SymbolMasterService;
}

async function setup(): Promise<Ctx> {
  const t = await createTestApp();
  const fake = await startKrxFakeServer();
  const source = createKrxHistoricalUniverseSource(
    { baseUrl: fake.baseUrl, apiKey: API_KEY, approvalExpiry: null },
    t.container.clock,
    t.container.logger,
    { sleep: NOOP_SLEEP },
  );
  const deps: SymbolMasterServiceDeps = {
    db: t.container.database.db,
    source,
    clock: t.container.clock,
    logger: t.container.logger,
  };
  return { t, fake, svc: new SymbolMasterService(deps) };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.fake.close();
  await ctx.t.close();
}

/**
 * 실측(2026-08-08, scripts/krx-halt-probe.ts)에서 받은 두 행을 그대로 쓴다 —
 * 신라젠(정지)과 오스템임플란트(정상). 한 응답에 섞여 있을 때 봉과 거래불가일로
 * 정확히 갈리는지가 이 테스트의 전부다.
 */
const HALTED_ROW = dailyFixture({
  ISU_CD: '215600',
  ISU_NM: '신라젠',
  MKTCAP: '866,567,212,500',
  TDD_OPNPRC: '0',
  TDD_HGPRC: '0',
  TDD_LWPRC: '0',
  TDD_CLSPRC: '12,100',
  ACC_TRDVOL: '0',
});
const NORMAL_ROW = dailyFixture({
  ISU_CD: '048260',
  ISU_NM: '오스템임플란트',
  MKTCAP: '1,420,000,269,800',
  TDD_OPNPRC: '98,000',
  TDD_HGPRC: '99,500',
  TDD_LWPRC: '97,400',
  TDD_CLSPRC: '99,400',
  ACC_TRDVOL: '113,801',
});

describe('SymbolMasterService.ingestDate — 거래불가일', () => {
  it('정지 행은 krx_non_trading_days 로, 정상 행은 krx_daily_bars 로 간다', async () => {
    const ctx = await setup();
    const date = '2021-06-15';
    ctx.fake.setResponse('stk_bydd_trd', '20210615', { body: krxEnvelope([]) });
    ctx.fake.setResponse('stk_isu_base_info', '20210615', { body: krxEnvelope([]) });
    ctx.fake.setResponse('ksq_bydd_trd', '20210615', {
      body: krxEnvelope([HALTED_ROW, NORMAL_ROW]),
    });
    ctx.fake.setResponse('ksq_isu_base_info', '20210615', {
      body: krxEnvelope([
        baseInfoFixture({ ISU_CD: 'KR7215600008', ISU_SRT_CD: '215600', ISU_NM: '신라젠', MKT_TP_NM: 'KOSDAQ' }),
        baseInfoFixture({ ISU_CD: 'KR7048260006', ISU_SRT_CD: '048260', ISU_NM: '오스템임플란트', MKT_TP_NM: 'KOSDAQ' }),
      ]),
    });

    await ctx.svc.ingestDate(date);

    const bars = ctx.t.container.database.db.select().from(krxDailyBars).all();
    expect(bars.map((row) => row.shortCode)).toEqual(['048260']);

    const nonTrading = ctx.t.container.database.db.select().from(krxNonTradingDays).all();
    expect(nonTrading).toHaveLength(1);
    expect(nonTrading[0]?.shortCode).toBe('215600');
    expect(nonTrading[0]?.date).toBe(date);
    expect(nonTrading[0]?.market).toBe('KOSDAQ');
    expect(nonTrading[0]?.lastClose).toBe(12_100);

    await teardown(ctx);
  });

  it('같은 날짜를 다시 넣어도 UNIQUE 위반으로 죽지 않는다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20210615', { body: krxEnvelope([]) });
    ctx.fake.setResponse('stk_isu_base_info', '20210615', { body: krxEnvelope([]) });
    ctx.fake.setResponse('ksq_bydd_trd', '20210615', { body: krxEnvelope([HALTED_ROW]) });
    ctx.fake.setResponse('ksq_isu_base_info', '20210615', {
      body: krxEnvelope([
        baseInfoFixture({ ISU_CD: 'KR7215600008', ISU_SRT_CD: '215600', ISU_NM: '신라젠', MKT_TP_NM: 'KOSDAQ' }),
      ]),
    });

    await ctx.svc.ingestDate('2021-06-15');
    // 두 번째 호출은 isCovered 로 막히지만, 백필(Task 5)이 같은 행을 다시 넣을 수 있다
    ctx.t.container.database.db
      .insert(krxNonTradingDays)
      .values({ date: '2021-06-15', shortCode: '215600', market: 'KOSDAQ', lastClose: 12_100 })
      .onConflictDoNothing()
      .run();

    expect(ctx.t.container.database.db.select().from(krxNonTradingDays).all()).toHaveLength(1);
    await teardown(ctx);
  });
});
```

`baseInfoFixture` 의 `SECUGRP_NM`·`KIND_STKCERT_TP_NM` 기본값이 `krx-filter-policy` 의 allowlist 를 통과하므로 두 종목 모두 `COMMON_STOCK` 으로 분류된다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/symbol-master-non-trading.test.ts`
Expected: FAIL — `krx_non_trading_days` 가 0행이고 `bars` 에 `215600` 이 없다(`isValidCandle` 이 이미 버리므로 봉 단언은 통과하고 거래불가 단언에서 실패한다)

- [ ] **Step 3: `writeDailyBars` 에 분기를 넣는다**

`symbol-master-service.ts` 상단 import 에 추가:

```ts
import { isNonTradingRow } from '../domain/non-trading-day.js';
```

`krxNonTradingDays` 를 `../../../shared/db/schema.js` import 목록에 추가한다.

`writeDailyBars` 의 jsdoc(588-603행)에서 잘못된 문장을 고친다. **"가격 4개나 거래량 중 하나라도 null 인 행(거래정지 등)"** 로 시작하는 두 문장을 아래로 바꾼다:

```
   * KRX 는 거래정지·무거래 행을 `null` 이 아니라 시·고·저 "0", 종가는 직전가,
   * 거래량 0 으로 준다 (실측 2026-08-08). 그 행은 `krx_non_trading_days` 에 따로
   * 기록하고 봉으로는 넣지 않는다 — 시·고·저를 우리가 지어내지 않기 위해서다.
   *
   * 그래도 `null` 검사는 남긴다. 저장할 컬럼이 NOT NULL 이라 방어선이 필요하고,
   * KRX 가 응답 모양을 바꾸면 여기서 건수로 드러난다.
   *
   * 위 둘 중 어디에도 안 걸리는데 `isValidCandle` 이 거부하는 행(high < low 등)은
   * 진짜 파싱 버그다. `invalidCount` 로 따로 센다.
```

루프 본문을 바꾼다. `null` 검사 뒤, `isValidCandle` 앞에 거래불가 분기를 넣는다:

```ts
    let skipped = 0;
    let invalidCount = 0;
    const rows: (typeof krxDailyBars.$inferInsert)[] = [];
    const nonTradingRows: (typeof krxNonTradingDays.$inferInsert)[] = [];
    for (const [market, trades] of byMarket) {
      for (const trade of trades) {
        if (
          trade.open === null
          || trade.high === null
          || trade.low === null
          || trade.close === null
          || trade.volume === null
        ) {
          skipped += 1;
          continue;
        }
        if (isNonTradingRow(trade)) {
          nonTradingRows.push({
            shortCode: trade.shortCode,
            date,
            market,
            lastClose: trade.close,
          });
          continue;
        }
        const candle: Candle = {
```

로그와 삽입을 더한다. 기존 `invalidCount` 경고 아래에 넣는다:

```ts
    if (nonTradingRows.length > 0) {
      this.deps.logger.info(
        {
          module: 'market-data',
          event: 'symbol-master.non-trading-days',
          date,
          count: nonTradingRows.length,
        },
        '거래정지·무거래로 봉이 없는 종목을 기록한다',
      );
    }
```

`warn` 이 아니라 `info` 다. 거래불가일은 오류가 아니라 정상 시장 상태이고, KOSDAQ 은 하루 5~6%가 여기 해당해 `warn` 으로 두면 로그가 매일 시끄러워진다.

봉 삽입 루프 아래에 같은 500개 배치로 넣는다:

```ts
    for (let i = 0; i < nonTradingRows.length; i += 500) {
      tx.insert(krxNonTradingDays)
        .values(nonTradingRows.slice(i, i + 500))
        .onConflictDoNothing()
        .run();
    }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/symbol-master-non-trading.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 검증 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: 전부 통과. `tests/unit/symbol-master-daily-bars.test.ts` 가 `invalidCount` 경고 건수를 단언한다면 거래불가 행이 그 통에서 빠지므로 값이 달라진다 — 실패하면 새 값으로 갱신하고 왜 바뀌었는지 주석을 남긴다.

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/market-data/application/symbol-master-service.ts tests/
git commit -m "feat(market-data): 수집이 거래불가일을 봉과 갈라 기록한다"
```

---

## Task 4: 조회 메서드

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts` (`isCovered` 근처, 약 685행)
- Test: `tests/unit/symbol-master-non-trading.test.ts` (Task 3 파일에 추가)

**Interfaces:**
- Produces:
  - `nonTradingDaysBetween(from: string, to: string): readonly { date: string; shortCode: string; lastClose: number }[]`
  - `isNonTradingRangeCovered(from: string, to: string): boolean`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Task 3 파일에 `describe` 를 더한다. import 에 `krxNonTradingCoverage` 를 추가한다.

```ts
describe('거래불가일 조회', () => {
  it('구간 안의 행만 날짜·코드 오름차순으로 돌려준다', async () => {
    const ctx = await setup();
    ctx.t.container.database.db.insert(krxNonTradingDays).values([
      { date: '2021-06-14', shortCode: '215600', market: 'KOSDAQ', lastClose: 12_100 },
      { date: '2021-06-16', shortCode: '950160', market: 'KOSDAQ', lastClose: 8_010 },
      { date: '2021-06-15', shortCode: '215600', market: 'KOSDAQ', lastClose: 12_100 },
    ]).run();

    const rows = ctx.svc.nonTradingDaysBetween('2021-06-15', '2021-06-16');

    expect(rows).toEqual([
      { date: '2021-06-15', shortCode: '215600', lastClose: 12_100 },
      { date: '2021-06-16', shortCode: '950160', lastClose: 8_010 },
    ]);
    await teardown(ctx);
  });

  it('구간 전체를 덮는 커버 행이 있어야 covered 다', async () => {
    const ctx = await setup();
    expect(ctx.svc.isNonTradingRangeCovered('2021-06-01', '2021-06-30')).toBe(false);

    ctx.t.container.database.db.insert(krxNonTradingCoverage).values({
      startDate: '2021-01-01', endDate: '2021-12-31', syncedAtMs: 0,
    }).run();

    expect(ctx.svc.isNonTradingRangeCovered('2021-06-01', '2021-06-30')).toBe(true);
    // 시작이 커버 밖이면 덮은 것이 아니다
    expect(ctx.svc.isNonTradingRangeCovered('2020-06-01', '2021-06-30')).toBe(false);
    await teardown(ctx);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/symbol-master-non-trading.test.ts`
Expected: FAIL — `ctx.svc.nonTradingDaysBetween is not a function`

- [ ] **Step 3: 메서드를 더한다**

`symbol-master-service.ts` 의 `isCovered` 옆에 넣는다:

```ts
  /**
   * 구간 안의 거래불가일 전체. 날짜 오름차순, 같은 날짜 안에서는 코드 오름차순이다 —
   * 호출부가 이 순서를 그대로 해시에 넣을 수 있어야 재현성이 흔들리지 않는다.
   */
  nonTradingDaysBetween(
    from: string,
    to: string,
  ): readonly { date: string; shortCode: string; lastClose: number }[] {
    return this.deps.db
      .select({
        date: krxNonTradingDays.date,
        shortCode: krxNonTradingDays.shortCode,
        lastClose: krxNonTradingDays.lastClose,
      })
      .from(krxNonTradingDays)
      .where(and(gte(krxNonTradingDays.date, from), lte(krxNonTradingDays.date, to)))
      .orderBy(asc(krxNonTradingDays.date), asc(krxNonTradingDays.shortCode))
      .all();
  }

  /**
   * 구간 전체를 덮는 커버 행이 하나라도 있는지. 구간을 이어 붙여 판정하지는 않는다 —
   * 백필은 한 번에 한 구간을 처리하므로 조각난 커버가 생기지 않는다.
   *
   * 행이 없는 날짜가 "거래불가 종목이 없었다" 인지 "아직 모른다" 인지를 이 메서드로만
   * 가른다. 이 구분이 없으면 결과 경고가 백필 전에도 "반영한다" 고 거짓말한다.
   */
  isNonTradingRangeCovered(from: string, to: string): boolean {
    const row = this.deps.db
      .select({ id: krxNonTradingCoverage.id })
      .from(krxNonTradingCoverage)
      .where(
        and(
          lte(krxNonTradingCoverage.startDate, from),
          gte(krxNonTradingCoverage.endDate, to),
        ),
      )
      .get();
    return row !== undefined;
  }
```

`asc` 가 import 돼 있지 않으면 `drizzle-orm` 에서 가져온다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/symbol-master-non-trading.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 검증 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test`

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/market-data/application/symbol-master-service.ts tests/
git commit -m "feat(market-data): 거래불가일 조회·커버리지 판정을 추가한다"
```

---

## Task 5: 백필 CLI

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts` (새 메서드)
- Modify: `src/server/cli.ts:282-300`
- Test: `tests/unit/symbol-master-non-trading.test.ts` (백필 describe 추가)

**Interfaces:**
- Consumes: Task 1 `isNonTradingRow`, Task 2 테이블
- Produces: `backfillNonTradingDays(from: string, to: string): Promise<{ dates: number; rows: number }>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Task 3 파일에 `describe` 를 더한다. `symbolMasterCoverage`·`symbolMasterEvents` import 를 추가한다.

```ts
describe('거래불가일 백필', () => {
  it('봉·이벤트·coverage 를 건드리지 않고 거래불가일만 채운다', async () => {
    const ctx = await setup();
    for (const basDd of ['20210615', '20210616']) {
      ctx.fake.setResponse('stk_bydd_trd', basDd, { body: krxEnvelope([]) });
      ctx.fake.setResponse('ksq_bydd_trd', basDd, { body: krxEnvelope([HALTED_ROW, NORMAL_ROW]) });
    }

    const result = await ctx.svc.backfillNonTradingDays('2021-06-15', '2021-06-16');

    expect(result.rows).toBe(2);
    const rows = ctx.t.container.database.db.select().from(krxNonTradingDays).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.shortCode === '215600')).toBe(true);

    // 백필은 봉·이벤트·마스터 coverage 를 쓰지 않는다 — 이벤트 재생성 위험이 없어야 한다
    expect(ctx.t.container.database.db.select().from(krxDailyBars).all()).toHaveLength(0);
    expect(ctx.t.container.database.db.select().from(symbolMasterEvents).all()).toHaveLength(0);
    expect(ctx.t.container.database.db.select().from(symbolMasterCoverage).all()).toHaveLength(0);

    expect(ctx.svc.isNonTradingRangeCovered('2021-06-15', '2021-06-16')).toBe(true);
    await teardown(ctx);
  });

  it('응답이 0행인 날(휴장)은 건너뛴다', async () => {
    const ctx = await setup();
    // 어떤 날짜에도 응답을 심지 않는다 — fake 서버가 빈 OutBlock_1 을 돌려준다
    const result = await ctx.svc.backfillNonTradingDays('2021-06-15', '2021-06-16');

    expect(result.dates).toBe(0);
    expect(result.rows).toBe(0);
    // 그래도 커버 구간은 남는다 — "봤는데 없었다" 와 "안 봤다" 를 갈라야 한다
    expect(ctx.svc.isNonTradingRangeCovered('2021-06-15', '2021-06-16')).toBe(true);
    await teardown(ctx);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/symbol-master-non-trading.test.ts`
Expected: FAIL — `ctx.svc.backfillNonTradingDays is not a function`

- [ ] **Step 3: 백필 메서드를 더한다**

```ts
  /**
   * 이미 수집한 구간의 거래불가일을 뒤늦게 채운다.
   *
   * `ingestDate` 를 다시 부르지 않는다. 그쪽은 이벤트·coverage·봉을 함께 쓰므로
   * 재실행하면 이벤트가 다시 생길 위험이 있다. 여기서는 일별매매정보만 부르고
   * `krx_non_trading_days` 만 쓴다 — 되돌릴 것이 그 테이블 하나뿐이다.
   *
   * 휴장일은 응답이 0행이라 저절로 건너뛰어진다. 날짜 달력을 따로 두지 않는다.
   */
  async backfillNonTradingDays(from: string, to: string): Promise<{ dates: number; rows: number }> {
    let dates = 0;
    let rows = 0;
    for (let date = from; date <= to; date = addCalendarDays(date, 1)) {
      const byMarket: readonly [KrxMarket, readonly KrxDailyTradeRow[]][] = [
        ['KOSPI', await this.deps.source.fetchDailyTrades('KOSPI', date)],
        ['KOSDAQ', await this.deps.source.fetchDailyTrades('KOSDAQ', date)],
      ];
      const values: (typeof krxNonTradingDays.$inferInsert)[] = [];
      for (const [market, trades] of byMarket) {
        for (const trade of trades) {
          if (trade.close === null || !isNonTradingRow(trade)) continue;
          values.push({ shortCode: trade.shortCode, date, market, lastClose: trade.close });
        }
      }
      if (byMarket.some(([, trades]) => trades.length > 0)) dates += 1;
      if (values.length === 0) continue;
      this.deps.db.transaction((tx) => {
        for (let i = 0; i < values.length; i += 500) {
          tx.insert(krxNonTradingDays).values(values.slice(i, i + 500)).onConflictDoNothing().run();
        }
      });
      rows += values.length;
    }
    this.deps.db
      .insert(krxNonTradingCoverage)
      .values({ startDate: from, endDate: to, syncedAtMs: this.deps.clock.now() })
      .run();
    return { dates, rows };
  }
```

`this.deps.clock` 이 없으면 서비스가 이미 쓰는 시각 소스를 그대로 쓴다 (`symbol-master-service.ts` 안에서 `syncedAtMs` 를 채우는 기존 코드를 따른다).

- [ ] **Step 4: CLI 케이스를 더한다**

`src/server/cli.ts` 의 `factsSync` 옆에 함수를 만든다:

```ts
async function krxBackfillNonTrading(argv: readonly string[]): Promise<void> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key?.startsWith('--') && value !== undefined) flags.set(key.slice(2), value);
  }
  const from = flags.get('from');
  const to = flags.get('to');
  if (!from || !to) {
    console.error('사용법: cli krx:backfill-non-trading --from YYYY-MM-DD --to YYYY-MM-DD');
    process.exitCode = 1;
    return;
  }

  const container = await createContainer();
  try {
    const result = await container.symbolMaster.backfillNonTradingDays(from, to);
    console.log(`거래일 ${result.dates}일에서 거래불가 ${result.rows}건을 기록했습니다.`);
  } finally {
    container.close();
  }
}
```

`createContainer` 호출 방식은 같은 파일의 `factsSync` 를 그대로 따른다.

`main()` 의 switch 에 넣는다:

```ts
    case 'krx:backfill-non-trading':
      await krxBackfillNonTrading(process.argv.slice(3));
      break;
```

사용법 출력에도 한 줄 더한다:

```ts
      console.log('  krx:backfill-non-trading  이미 수집한 구간의 거래불가일 채우기 (--from <날짜> --to <날짜>)');
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/symbol-master-non-trading.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: 검증 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test`

- [ ] **Step 7: 커밋**

```bash
git add src/server/modules/market-data/application/symbol-master-service.ts src/server/cli.ts tests/
git commit -m "feat(cli): 거래불가일 백필 명령을 추가한다"
```

---

## Task 6: 유니버스가 거래불가 종목을 뺀다

**Files:**
- Modify: `src/server/modules/backtest/application/universe-rule-resolver.ts:14-27, 70-121`
- Test: `tests/unit/backtest-engine-universe-schedule.test.ts` 또는 resolver 전용 테스트 파일

**Interfaces:**
- Consumes: Task 4 `nonTradingDaysBetween`
- Produces: `UniverseScheduleEntry.excludedNonTradingCount: number`, `ResolvedUniverse.excludedNonTradingTotal: number`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

resolver 를 직접 부르는 테스트를 쓴다. `symbolMaster` 는 필요한 메서드만 가진 스텁으로 만든다.

```ts
import { describe, expect, it } from 'vitest';
import { UniverseRuleResolver } from '../../src/server/modules/backtest/application/universe-rule-resolver.js';

describe('UniverseRuleResolver 거래불가 제외', () => {
  it('기준일에 거래불가인 종목은 시총이 커도 후보에서 빠진다', async () => {
    const master = {
      isCovered: () => true,
      effectiveTradingDateWithinCoverage: (date: string) => date,
      getUniverseAsOf: () => new Map([
        ['KR7215600008', { standardCode: 'KR7215600008', shortCode: '215600', name: '신라젠', market: 'KOSDAQ', sharesOutstanding: '1', instrumentType: 'COMMON_STOCK', listedDate: null }],
        ['KR7048260006', { standardCode: 'KR7048260006', shortCode: '048260', name: '오스템임플란트', market: 'KOSDAQ', sharesOutstanding: '1', instrumentType: 'COMMON_STOCK', listedDate: null }],
      ]),
      // 신라젠이 시총 1위다 — 제외가 없으면 topN=1 에서 신라젠이 뽑힌다.
      // 정지 중에도 MKTCAP 이 갱신된다는 실측 사실이 이 테스트가 존재하는 이유다.
      getMarketCapsAt: async () => new Map([
        ['KR7215600008', '2038571815900'],
        ['KR7048260006', '1244692212500'],
      ]),
      nonTradingDaysBetween: () => [
        { date: '2022-02-15', shortCode: '215600', lastClose: 12_100 },
      ],
    };
    const resolver = new UniverseRuleResolver({
      symbolMaster: master as never,
      logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
    });

    const resolved = await resolver.resolve(
      { markets: ['KOSDAQ'], topN: 1, sortKey: 'MKTCAP' },
      ['2022-02-15'],
    );

    expect(resolved.schedule[0]?.symbols).toEqual(['048260']);
    expect(resolved.schedule[0]?.excludedNonTradingCount).toBe(1);
    expect(resolved.excludedNonTradingTotal).toBe(1);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/universe-rule-resolver-non-trading.test.ts`
Expected: FAIL — `symbols` 가 `['215600']`

- [ ] **Step 3: resolver 를 고친다**

타입에 필드를 더한다:

```ts
export interface UniverseScheduleEntry {
  readonly rebalanceDate: string;
  readonly effectiveTradingDate: string;
  readonly symbols: readonly string[];
  /** 그날 거래불가라 후보에서 뺀 종목 수 — 조용히 빠지면 추적할 방법이 없다 */
  readonly excludedNonTradingCount: number;
}
```

```ts
export interface ResolvedUniverse {
  // ... 기존 필드 유지 ...
  /** 전 리밸런스 날짜에서 거래불가로 제외한 종목 수 합계 */
  readonly excludedNonTradingTotal: number;
}
```

`resolve` 본문에서 리밸런스 날짜 루프 앞에 거래불가 인덱스를 한 번 만든다. 날짜마다 질의하면 리밸런스가 잦은 실행에서 같은 질의를 반복한다:

```ts
    // 리밸런스 기준일들이 걸치는 최소·최대 날짜 한 번만 읽어 날짜별 집합으로 접는다
    const nonTradingByDate = new Map<string, Set<string>>();
    if (rebalanceDates.length > 0) {
      const sortedDates = [...rebalanceDates].sort();
      const first = sortedDates[0] as string;
      const last = sortedDates[sortedDates.length - 1] as string;
      // effectiveTradingDate 는 rebalanceDate 보다 앞설 수 있어 여유를 둔다
      for (const row of this.deps.symbolMaster.nonTradingDaysBetween(
        addCalendarDays(first, -31),
        last,
      )) {
        const set = nonTradingByDate.get(row.date) ?? new Set<string>();
        set.add(row.shortCode);
        nonTradingByDate.set(row.date, set);
      }
    }
```

`addCalendarDays` 는 `../../market-data/domain/kst-date.js` 에서 가져온다. `-31` 은 `historical-universe-service` 의 이전 거래일 탐색 상한과 같은 값이다.

`ranked` 를 만드는 루프를 고친다:

```ts
      const nonTrading = nonTradingByDate.get(effectiveTradingDate) ?? new Set<string>();
      let excludedNonTradingCount = 0;
      const marketCaps = await this.deps.symbolMaster.getMarketCapsAt(effectiveTradingDate);
      const ranked: { entry: SymbolMasterEntry; marketCap: bigint }[] = [];
      for (const entry of candidates) {
        // 그날 거래할 수 없으면 시총이 아무리 커도 살 수 없다 — 후보에 두면 그 자리가 헛돈다.
        // 기준일 종가 시점에 이미 확정된 사실이라 look-ahead 가 아니다.
        if (nonTrading.has(entry.shortCode)) {
          excludedNonTradingCount += 1;
          continue;
        }
        const marketCapKrw = marketCaps.get(entry.standardCode);
        if (marketCapKrw === undefined) continue;
        ranked.push({ entry, marketCap: BigInt(marketCapKrw) });
      }
```

`schedule.push` 와 반환값을 고친다:

```ts
      schedule.push({ rebalanceDate: date, effectiveTradingDate, symbols, excludedNonTradingCount });
```

```ts
    const excludedNonTradingTotal = schedule.reduce(
      (sum, entry) => sum + entry.excludedNonTradingCount,
      0,
    );
```

반환 객체에 `excludedNonTradingTotal` 을 더한다.

`scheduleHash` 는 `schedule` 을 통째로 직렬화하므로 새 필드가 해시에 들어간다. 의도한 동작이다 — 제외가 일어난 실행은 이전 실행과 다른 해시를 가져야 한다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/universe-rule-resolver-non-trading.test.ts`
Expected: PASS

- [ ] **Step 5: 검증 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: `scheduleHash` 를 고정값으로 비교하는 기존 테스트가 있으면 실패한다. 그 테스트는 새 해시로 갱신하고, 왜 바뀌었는지 주석으로 남긴다.

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/backtest/application/universe-rule-resolver.ts tests/
git commit -m "feat(backtest): 유니버스가 거래불가 종목을 후보에서 뺀다"
```

---

## Task 7: 엔진이 거래불가 종목의 매수를 막는다

**Files:**
- Modify: `src/server/modules/backtest/domain/engine.ts:32-56` (입력), `:199-217` (루프)
- Test: `tests/unit/engine-non-trading.test.ts`

**Interfaces:**
- Produces: `BacktestRunInput.nonTradingSymbolsByTsMs?: ReadonlyMap<number, ReadonlySet<string>>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/engine-non-trading.test.ts`. `tests/unit/engine-facts.test.ts` 의 `ZERO_COST`·`bar` 헬퍼 방식을 따른다.

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 4, 12);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function bar(symbol: string, index: number, close = 1_000): Candle {
  return {
    symbol, market: 'KR', timeframe: '1d', tsMs: START + index * DAY,
    open: close, high: close + 10, low: close - 10, close, volume: 100,
  };
}

/** 첫 봉에서 대상 종목을 한 번 매수하려 드는 전략 */
function buyOnceStrategy(target: string): TradingStrategy<unknown, { done: boolean }> {
  return {
    id: 'buy-once', version: '1', name: 'buy once', description: '',
    parameterSchema: z.object({}).passthrough(),
    initialize: () => ({ done: false }),
    onBars: (_context, state) => {
      if (state.done) return { orders: [] };
      state.done = true;
      return { orders: [{ symbol: target, side: 'BUY' as const, quantity: 1 }] };
    },
  };
}

describe('엔진 거래불가일', () => {
  it('거래불가 종목의 매수를 거부한다', () => {
    const candles = [bar('A', 0), bar('A', 1), bar('B', 0), bar('B', 1)];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      // 0번 봉 시점에 A 가 거래불가다 — 주문은 그 시점에 발행되고 검증에서 걸려야 한다
      nonTradingSymbolsByTsMs: new Map([[START, new Set(['A'])]]),
    });

    expect(result.fills).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.includes('A 매수 거부'))).toBe(true);
  });

  it('거래불가 종목이 없으면 그대로 매수한다', () => {
    const candles = [bar('A', 0), bar('A', 1)];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    expect(result.fills).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/engine-non-trading.test.ts`
Expected: FAIL — 첫 테스트에서 `fills` 가 1건

- [ ] **Step 3: 엔진에 입력과 필터를 넣는다**

`BacktestRunInput` 에 더한다:

```ts
  /**
   * 그 시점에 거래할 수 없었던 종목 (거래정지·무거래). 키는 봉 tsMs 다.
   * 이 종목들은 매수 후보에서 빠진다 — 봉이 없어 체결도 되지 않는다.
   * 보유분 청산(SELL)은 막지 않는다. 유니버스에서 빠진 종목도 항상 팔 수 있어야 한다.
   */
  readonly nonTradingSymbolsByTsMs?: ReadonlyMap<number, ReadonlySet<string>>;
```

루프의 멤버십 갱신 블록(`:209-217`) 바로 아래에 넣는다:

```ts
    // 거래불가 종목을 매수 후보에서 뺀다. 멤버십 일정이 없어도(=제한 없음) 이날
    // 거래불가인 종목이 있으면 전체 심볼에서 그만큼 뺀 집합을 만든다.
    const nonTradingNow = input.nonTradingSymbolsByTsMs?.get(tsMs);
    if (nonTradingNow !== undefined && nonTradingNow.size > 0) {
      const base = tradableSymbols ?? new Set(symbols);
      const filtered = new Set<string>();
      for (const symbol of base) {
        if (!nonTradingNow.has(symbol)) filtered.add(symbol);
      }
      tradableSymbols = filtered;
    }
```

`tradableSymbols` 는 이 루프 안에서 매 시점 다시 계산되므로(멤버십 블록이 먼저 재할당한다) 필터가 다음 시점으로 새지 않는다. 멤버십 일정이 없는 실행에서는 `sortedSchedule.length === 0` 이라 위 블록이 `tradableSymbols` 를 건드리지 않으므로, 거래불가가 없는 다음 시점에 `null` 로 되돌려야 한다. 멤버십 블록 앞에 한 줄 더한다:

```ts
    // 일정이 없는 실행에서 이전 시점의 거래불가 필터가 남지 않게 매 시점 초기화한다
    if (sortedSchedule.length === 0) tradableSymbols = null;
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/engine-non-trading.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 검증 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test`

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/backtest/domain/engine.ts tests/unit/engine-non-trading.test.ts
git commit -m "feat(engine): 거래불가 종목을 매수 후보에서 뺀다"
```

---

## Task 8: 상장폐지 강제 청산과 `onForcedExit`

**Files:**
- Modify: `src/server/modules/strategy/domain/strategy.ts:76` (훅 추가)
- Modify: `src/server/modules/backtest/domain/engine.ts` (입력, 청산, 결과 필드)
- Modify: `src/server/modules/backtest/domain/types.ts:70-80` (`OpenPositionSnapshot`)
- Test: `tests/unit/engine-non-trading.test.ts` (describe 추가)

**Interfaces:**
- Produces:
  - `BacktestRunInput.delistedTsMsBySymbol?: ReadonlyMap<string, number>`
  - `BacktestRunResult.delistingLiquidations: readonly { symbol: string; tsMs: number; netPnl: number }[]`
  - `TradingStrategy.onForcedExit?(symbol: string, state: TState): void`
  - `OpenPositionSnapshot.lastPriceTsMs: number`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
describe('상장폐지 청산', () => {
  it('마지막 거래 가능 봉 종가로 청산하고 사유를 남긴다', () => {
    // A 는 2번 봉이 마지막이고 그 뒤 폐지된다. B 는 끝까지 산다.
    const candles = [
      bar('A', 0, 1_000), bar('A', 1, 900), bar('A', 2, 500),
      bar('B', 0), bar('B', 1), bar('B', 2), bar('B', 3),
    ];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', START + 3 * DAY]]),
    });

    const trade = result.trades.find((candidate) => candidate.symbol === 'A');
    expect(trade).toBeDefined();
    expect(trade?.exitReason).toBe('DELISTED');
    // 2번 봉 종가 500 으로 나간다 — 시가가 아니다
    expect(trade?.exitPrice).toBe(500);
    expect(trade?.exitTsMs).toBe(START + 2 * DAY);
    expect(result.delistingLiquidations).toHaveLength(1);
    // 청산했으니 미청산으로 남지 않는다
    expect(result.openPositions.some((position) => position.symbol === 'A')).toBe(false);
  });

  it('폐지 정보가 없으면 미청산으로 남는다', () => {
    const candles = [bar('A', 0, 1_000), bar('A', 1, 900), bar('A', 2, 500), bar('B', 3)];
    const result = runBacktest(buyOnceStrategy('A'), {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    expect(result.trades).toHaveLength(0);
    const open = result.openPositions.find((position) => position.symbol === 'A');
    expect(open?.lastPriceTsMs).toBe(START + 2 * DAY);
  });

  it('청산 시점에 onForcedExit 를 부른다', () => {
    const seen: string[] = [];
    const strategy = buyOnceStrategy('A');
    const withHook: TradingStrategy<unknown, { done: boolean }> = {
      ...strategy,
      onForcedExit: (symbol) => { seen.push(symbol); },
    };
    runBacktest(withHook, {
      candles: [bar('A', 0), bar('A', 1), bar('B', 2)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      delistedTsMsBySymbol: new Map([['A', START + 2 * DAY]]),
    });
    expect(seen).toEqual(['A']);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/engine-non-trading.test.ts`
Expected: FAIL — `trades` 가 비어 있다

- [ ] **Step 3: 전략 훅을 더한다**

`src/server/modules/strategy/domain/strategy.ts` 의 `onCorporateAction` 아래에 넣는다:

```ts
  /**
   * 엔진이 보유 포지션을 강제로 청산한 직후 부르는 선택 훅이다.
   * 지금은 상장폐지 청산 하나뿐이다.
   *
   * 전략이 낸 매도가 아니므로 전략은 자기가 아직 보유 중이라고 믿는다.
   * 봉 사이에 들고 다니는 스톱 레벨·보유 플래그를 여기서 지우지 않으면
   * 없는 포지션에 매도 주문을 계속 낸다.
   *
   * 구현하지 않는 전략에는 영향이 없다.
   */
  onForcedExit?(symbol: string, state: TState): void;
```

- [ ] **Step 4: 스냅샷에 마지막 가격 시각을 더한다**

`src/server/modules/backtest/domain/types.ts` 의 `OpenPositionSnapshot` 에 넣는다:

```ts
  /** `lastPrice` 를 읽은 봉의 시각 — 기간 종료 시각과 벌어져 있으면 stale 이다 */
  readonly lastPriceTsMs: number;
```

- [ ] **Step 5: 엔진에 청산을 넣는다**

입력에 더한다:

```ts
  /**
   * 상장폐지 효력 시각 (심볼 → tsMs). 기간 안에 폐지된 종목만 담는다.
   *
   * 이 맵은 엔진만 본다. `StrategyBarContext` 에 노출하지 않는다 —
   * 전략이 "이 종목이 곧 폐지된다" 를 미리 알 경로를 만들지 않기 위해서다.
   */
  readonly delistedTsMsBySymbol?: ReadonlyMap<string, number>;
```

결과 타입에 더한다:

```ts
  /** 상장폐지로 강제 청산한 내역 — 전략이 낸 매도와 구분해 결과 화면에 밝힌다 */
  readonly delistingLiquidations: readonly { symbol: string; tsMs: number; netPnl: number }[];
```

제너레이터 앞부분(`timeline` 계산 직후)에 종목별 마지막 봉 시각을 미리 만든다:

```ts
  // 폐지 청산은 "그 종목의 마지막 봉" 에서 일어난다. 봉은 전부 미리 들어와 있으므로
  // 루프 중에 찾을 필요 없이 여기서 한 번에 접는다.
  const lastBarTsMsBySymbol = new Map<string, number>();
  for (const candle of sorted) lastBarTsMsBySymbol.set(candle.symbol, candle.tsMs);
```

집계 배열을 선언부에 더한다:

```ts
  const delistingLiquidations: { symbol: string; tsMs: number; netPnl: number }[] = [];
```

**청산 자리는 "봉 이력·마지막 종가 갱신"(`:305-309`) 직후, "4. 평가금액 갱신" 직전이다.** 그 자리여야 그 시점 자산곡선이 청산 대금을 이미 반영하고, 전략이 없어진 포지션을 보지 않는다.

```ts
    // 상장폐지 청산 — 그 종목의 마지막 봉에서 종가로 전량 나간다.
    //
    // 평가금액 갱신보다 먼저다. 이 시점 자산곡선이 청산 대금을 이미 반영해야
    // 폐지 손실이 곡선에 남는다.
    //
    // 체결가는 이 봉의 종가다. `krx_non_trading_days.lastClose` 는 쓰지 않는다 —
    // 정지 중 가격은 팔 수 있는 가격이 아니다. 정지 상태로 폐지된 종목은
    // 정지 직전 실거래가로 나간다.
    //
    // 정리매매 종가를 따로 추정하지 않는다. KRX 일봉에 정리매매 기간 봉이 들어 있어
    // 마지막 봉이 곧 정리매매 최종가다. 시장이 매긴 회수가치를 그대로 쓴다.
    if (input.delistedTsMsBySymbol !== undefined) {
      for (const [symbol, bar] of bars) {
        if (!input.delistedTsMsBySymbol.has(symbol)) continue;
        if (lastBarTsMsBySymbol.get(symbol) !== tsMs) continue;

        // 체결될 봉이 다시 오지 않는다 — 남겨두면 기간 종료 폐기 경고만 늘린다
        pendingOrders = pendingOrders.filter((order) => order.symbol !== symbol);

        const position = positions.get(symbol);
        if (position === undefined || position.quantity <= 0) continue;

        const before = trades.length;
        const fill = executeOrder(
          { symbol, side: 'SELL', quantity: position.quantity, reason: 'DELISTED' },
          bar,
          tsMs,
          bar.close,
        );
        if (fill) fills.push(fill);
        const trade = trades[before];
        if (trade !== undefined) {
          delistingLiquidations.push({ symbol, tsMs, netPnl: trade.netPnl });
        }
        strategy.onForcedExit?.(symbol, state);
      }
    }
```

`executeOrder` 에 기준가 인자를 더한다. 기본값은 지금과 같은 시가다:

```ts
  function executeOrder(
    order: OrderIntent,
    bar: Candle,
    tsMs: number,
    basePrice: number = bar.open,
  ): Fill | null {
```

본문의 `simulateFill(order, bar.open, ...)` 세 곳을 전부 `basePrice` 로 바꾼다. 현금 부족 계산의 `fill.price` 는 그대로 둔다 — 이미 체결가 기준이다.

`openPositions` 매핑(`:411-425`)에 시각을 더한다:

```ts
      const lastPrice = lastCloseBySymbol.get(position.symbol) ?? position.avgEntryPrice;
      const lastPriceTsMs = lastBarTsMsBySymbol.get(position.symbol) ?? position.entryTsMs;
      return {
        symbol: position.symbol,
        quantity: position.quantity,
        avgEntryPrice: position.avgEntryPrice,
        entryTsMs: position.entryTsMs,
        lastPrice,
        lastPriceTsMs,
        unrealizedPnl: position.quantity * (lastPrice - position.avgEntryPrice),
        returnPct: ((lastPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100,
      };
```

반환 객체에 `delistingLiquidations` 를 더한다.

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/engine-non-trading.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: 검증 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: `OpenPositionSnapshot` 을 만드는 다른 코드가 있으면 `lastPriceTsMs` 누락으로 타입 오류가 난다. 전부 채운다.

- [ ] **Step 8: 커밋**

```bash
git add src/server/modules/backtest/domain/ src/server/modules/strategy/domain/strategy.ts tests/
git commit -m "feat(engine): 상장폐지 종목을 마지막 거래 가능 봉 종가로 청산한다"
```

---

## Task 9: 실행 경고를 다시 쓴다

**Files:**
- Modify: `src/server/modules/backtest/domain/engine.ts:83` (`ENGINE_VERSION`), `:385-399` (경고)
- Modify: `tests/unit/engine-facts.test.ts:157,186,213`, `tests/unit/warning-groups.test.ts:21,26`
- Test: `tests/unit/engine-non-trading.test.ts` (describe 추가)

**Interfaces:**
- Consumes: Task 8 `delistingLiquidations`
- Produces: `BacktestRunInput.nonTradingCoveredPeriod?: { from: string; to: string } | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
describe('실행 경고', () => {
  it('보정하는 항목과 보정하지 않는 항목을 갈라 적는다', () => {
    const result = runBacktest(buyOnceStrategy('A'), {
      candles: [bar('A', 0), bar('A', 1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    const text = result.warnings.join('\n');
    // "생존 편향" 이라는 단일 라벨은 더 이상 쓰지 않는다 — 부분 보정이라 예/아니오로 말할 수 없다
    expect(text).not.toContain('생존 편향');
    expect(text).toContain('배당');
    expect(text).toContain('유상증자 권리락');
  });

  it('거래불가 정보가 백필되지 않았으면 그 사실을 적는다', () => {
    const result = runBacktest(buyOnceStrategy('A'), {
      candles: [bar('A', 0), bar('A', 1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      nonTradingCoveredPeriod: null,
    });
    expect(result.warnings.join('\n')).toContain('거래불가일 정보가 없습니다');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/engine-non-trading.test.ts`
Expected: FAIL — `생존 편향` 이 그대로 있다

- [ ] **Step 3: 입력을 더한다**

```ts
  /**
   * 거래불가일이 실제로 채워진 구간. `null` 이면 이 실행 구간에 거래불가 정보가 없다.
   * 행이 없는 것과 아직 모르는 것을 구분하지 않으면 경고가 "반영한다" 고 거짓말한다.
   */
  readonly nonTradingCoveredPeriod?: { readonly from: string; readonly to: string } | null;
```

- [ ] **Step 4: 경고를 다시 쓴다**

`engine.ts:385-399` 의 `warnings.push(...)` 블록을 통째로 바꾼다:

```ts
  // 분할 보정 여부는 "팩트가 있는가" 가 아니라 "**자본변동** 팩트가 있는가" 다 —
  // 재무만 수집된 데이터셋(SPLIT_RATIO 0건)에서 팩트 건수로 판단하면 일어나지 않은
  // 보정을 일어났다고 말한다.
  const hasCorporateActionFacts = (input.facts ?? []).some(
    (fact) => fact.field === CORPORATE_ACTION_FIELD,
  );

  // "생존 편향" 이라는 단일 라벨은 쓰지 않는다. 시점별 유니버스 선정과 상장폐지 청산은
  // 하고, 배당·권리락·과거 지수 구성원은 안 한다 — 예/아니오로 답할 수 없는 상태다.
  // 화면(universe-provenance.ts)이 같은 이유로 "생존자 편향 제거" 표현을 금지한다.
  warnings.push(
    '이 백테스트가 보정하는 것: 시점별 유니버스 선정, 상장폐지 청산, 거래불가일(거래정지·무거래) 매수 제외'
      + (hasCorporateActionFacts
        ? ', 액면분할(보유 수량·평균단가·대기 주문·전략 가격 상태). 이미 체결된 거래의 체결가는 조정하지 않습니다.'
        : '. 액면분할은 이 실행에서 보정되지 않았습니다 (분할 이력 미수집).'),
  );
  warnings.push(
    '이 백테스트가 보정하지 않는 것: 배당, 유상증자 권리락, 공휴일 캘린더, 과거 지수 구성원 복원. '
      + '손절·익절은 종가로만 판정합니다.',
  );

  if (delistingLiquidations.length > 0) {
    const netPnl = delistingLiquidations.reduce((sum, item) => sum + item.netPnl, 0);
    const symbols = delistingLiquidations.map((item) => item.symbol).sort();
    const shown = symbols.slice(0, 10).join(', ');
    warnings.push(
      `상장폐지로 강제 청산한 종목 ${symbols.length}건: ${shown}`
        + (symbols.length > 10 ? ` 외 ${symbols.length - 10}종목` : '')
        + `. 손익 합계 ${Math.round(netPnl).toLocaleString()}원. `
        + '체결가는 그 종목의 마지막 거래 가능 봉 종가이며, 정리매매가 있었다면 그 가격이 반영됩니다.',
    );
  }

  if (input.nonTradingCoveredPeriod === null) {
    warnings.push(
      '이 실행 구간에는 거래불가일 정보가 없습니다 — 거래정지 종목이 유니버스와 매수 후보에 그대로 들어갔을 수 있습니다. '
        + '`cli krx:backfill-non-trading` 으로 채운 뒤 다시 실행하세요.',
    );
  } else if (input.nonTradingCoveredPeriod !== undefined) {
    warnings.push(
      `거래불가일 정보는 ${input.nonTradingCoveredPeriod.from} ~ ${input.nonTradingCoveredPeriod.to} 구간만 반영됐습니다.`,
    );
  }
```

`ENGINE_VERSION` 을 올린다:

```ts
/** 재현성 메타데이터에 기록되는 엔진 버전 (스펙 §9.5) — 체결·지표 로직 변경 시 올린다 */
export const ENGINE_VERSION = '1.5.0';
```

- [ ] **Step 5: 기존 테스트를 갱신한다**

`tests/unit/engine-facts.test.ts:157,186,213` 이 `'생존 편향'` 을 찾는다. 새 문구에 맞춰 각 단언을 고친다 — 액면분할 보정 여부를 확인하는 테스트이므로 `'액면분할'` 을 찾게 바꾼다.

`tests/unit/warning-groups.test.ts:21,26` 이 옛 문장을 fixture 로 들고 있다. 새 두 문장으로 바꾸고 `groups[0]?.label` 단언도 새 문구에 맞춘다. 경고 묶기 로직(`warning-groups`)이 라벨을 문장 앞부분에서 뽑는다면 새 문장이 어떤 라벨을 내는지 확인해 단언을 맞춘다.

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/engine-non-trading.test.ts tests/unit/engine-facts.test.ts tests/unit/warning-groups.test.ts`
Expected: PASS

- [ ] **Step 7: 검증 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test`

- [ ] **Step 8: 커밋**

```bash
git add src/server/modules/backtest/domain/engine.ts tests/
git commit -m "feat(engine): 실행 경고가 실제 보정 상태를 항목별로 말한다"
```

---

## Task 10: 워커 배선

**Files:**
- Modify: `src/workers/backtest-child.ts:100-108` (일정 조립부 근처), `:281-294` (엔진 호출)
- Test: `tests/integration/backtest-universe-rule-run.test.ts` (describe 추가)

**Interfaces:**
- Consumes: Task 4 조회 메서드, Task 7·8·9 엔진 입력
- Produces: 없음 (배선)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/integration/backtest-universe-rule-run.test.ts` 에 더한다. 이 파일의 `buildDailyCandles`·`seedSymbolMasterUniverse`·`seedDailyBars`·`registerSymbols` 를 그대로 쓴다.

두 종목을 마스터에 두고 `000660` 의 봉만 기간 중간에서 끊은 뒤, 그 다음 거래일에 `DELISTED` 이벤트를 심는다.

```ts
import { symbolMasterEvents } from '../../src/server/shared/db/schema.js';

it('상장폐지 종목이 마지막 거래 가능 봉 종가로 청산된다', async () => {
  const app = await createTestApp();
  try {
    await createTestAdmin(app);

    const alive = buildDailyCandles('005930');
    // 000660 은 기간의 절반까지만 거래된다 — 그 뒤 폐지된다
    const doomedAll = buildDailyCandles('000660');
    const doomed = doomedAll.slice(0, Math.floor(doomedAll.length / 2));
    const lastDoomed = doomed[doomed.length - 1] as Candle;

    registerSymbols(app, ['005930', '000660']);
    seedDailyBars(app, [...alive, ...doomed]);
    seedSymbolMasterUniverse(app.container, MASTER_DATES, [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '900' },
      { standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스', market: 'KOSPI', marketCapKrw: '800' },
    ]);

    // 마지막 봉 다음 날을 폐지 효력일로 둔다 — 워커가 이 이벤트를 읽어 엔진에 넘긴다
    const delistedDate = new Date(lastDoomed.tsMs + DAY).toISOString().slice(0, 10);
    app.container.database.db.insert(symbolMasterEvents).values({
      effectiveDate: delistedDate,
      standardCode: 'KR7000660001',
      eventType: 'DELISTED',
      oldValue: JSON.stringify({
        standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스',
        market: 'KOSPI', sharesOutstanding: '1000000', instrumentType: 'COMMON_STOCK', listedDate: null,
      }),
      newValue: null,
      observedSpanStart: delistedDate,
      createdAtMs: 0,
    }).run();

    const result = await runBacktestJob(app, buildRequest(2));

    const delistingTrade = result.trades.find((trade) => trade.symbol === '000660');
    expect(delistingTrade).toBeDefined();
    expect(delistingTrade?.exitReason).toBe('DELISTED');
    // 마지막 봉의 **종가** 로 나간다. 시가로 나가면 이 단언이 깨진다.
    expect(delistingTrade?.exitPrice).toBe(lastDoomed.close);
    expect(delistingTrade?.exitTsMs).toBe(lastDoomed.tsMs);
    // 청산했으므로 미청산으로 남지 않는다
    expect(result.openPositions.some((position) => position.symbol === '000660')).toBe(false);
  } finally {
    await app.close();
  }
});
```

`runBacktestJob` 은 이 파일이 이미 쓰는 "잡을 넣고 워커를 돌려 결과를 읽는" 흐름의 이름이다. 파일에 그런 헬퍼가 없으면 기존 테스트가 하는 제출·대기·결과 조회 순서를 그대로 인라인으로 쓴다.

`buildRequest(2)` 로 두 종목이 모두 유니버스에 들어가야 `000660` 이 매수된다. 전략이 `000660` 을 실제로 사는지 확인한 뒤 단언한다 — 사지 않으면 청산할 포지션이 없어 테스트가 무의미해진다. 전략이 상위 1종목만 사면 `marketCapKrw` 를 조정해 `000660` 이 뽑히게 한다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/integration/backtest-universe-rule-run.test.ts`
Expected: FAIL — `exitReason === 'DELISTED'` 인 거래가 없다 (`delistingTrade` 가 `undefined`)

- [ ] **Step 3: 워커가 입력을 조립한다**

`universeSchedule` 조립부 아래에 넣는다. `period` 는 `request.period`, `fromTsMs`/`toTsMs` 는 아래에서 계산되므로 캔들 로드 뒤에 두는 편이 읽기 쉽다:

```ts
    // 거래불가일 — 봉 tsMs 로 접어 엔진에 넘긴다. Candle.tsMs 규약은 거래일의 UTC 자정이다
    // (krx-daily-candle-repository.ts). 여기서 같은 규칙을 쓰지 않으면 하루 어긋난다.
    const unionSymbolSet = new Set(unionSymbols);
    const nonTradingSymbolsByTsMs = new Map<number, Set<string>>();
    for (const row of symbolMaster.nonTradingDaysBetween(request.period.from, request.period.to)) {
      if (!unionSymbolSet.has(row.shortCode)) continue;
      const ts = Date.parse(`${row.date}T00:00:00Z`);
      const set = nonTradingSymbolsByTsMs.get(ts) ?? new Set<string>();
      set.add(row.shortCode);
      nonTradingSymbolsByTsMs.set(ts, set);
    }
    const nonTradingCoveredPeriod = symbolMaster.isNonTradingRangeCovered(
      request.period.from,
      request.period.to,
    )
      ? { from: request.period.from, to: request.period.to }
      : null;

    // 상장폐지 — 기간 안에 효력이 발생한 것만. 기간이 끝난 뒤 폐지된 종목은
    // 그 시점에는 아직 폐지가 아니므로 청산하지 않는다.
    const delistedTsMsBySymbol = new Map<string, number>();
    for (const event of symbolMaster.delistedEventsBetween(request.period.from, request.period.to)) {
      if (!unionSymbolSet.has(event.shortCode)) continue;
      delistedTsMsBySymbol.set(event.shortCode, Date.parse(`${event.effectiveDate}T00:00:00Z`));
    }
```

`symbolMaster` 인스턴스를 워커가 아직 갖고 있지 않으면 이 파일이 이미 `db` 를 열어 두었으므로 `new SymbolMasterService({ db, ... })` 로 만든다. `container.ts` 의 조립 인자를 그대로 따른다.

`delistedEventsBetween(from, to): readonly { shortCode: string; effectiveDate: string }[]` 는 이 태스크에서 `symbol-master-service.ts` 에 더한다. `symbol_master_events` 를 `eventType = 'DELISTED'` 로 걸러 읽고, `oldValue` JSON 의 `shortCode` 를 꺼낸다 — `standardCode` 만으로는 봉 심볼(단축코드)과 이어지지 않는다.

엔진 호출에 입력을 더한다:

```ts
      facts,
      universeSchedule,
      nonTradingSymbolsByTsMs,
      nonTradingCoveredPeriod,
      delistedTsMsBySymbol,
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm exec vitest run tests/integration/backtest-universe-rule-run.test.ts`
Expected: PASS

- [ ] **Step 5: 검증 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test`

- [ ] **Step 6: 커밋**

```bash
git add src/workers/backtest-child.ts src/server/modules/market-data/application/symbol-master-service.ts tests/
git commit -m "feat(backtest): 워커가 폐지·거래불가 정보를 엔진에 넘긴다"
```

---

## Task 11: 결과 화면 표시

**Files:**
- Modify: `src/server/modules/backtest/application/results-service.ts` (저장·조회에 `delistingLiquidations` 통과)
- Modify: `src/web/features/backtests/api.ts` (응답 타입)
- Modify: `src/web/features/backtests/backtest-detail-page.tsx` (미청산 카드에 stale 표시)
- Test: `tests/e2e/mvp-flow.spec.ts` (단언 추가)

**Interfaces:**
- Consumes: Task 8 `delistingLiquidations`, `OpenPositionSnapshot.lastPriceTsMs`

- [ ] **Step 1: 미청산 카드에 마지막 확인일을 더한다**

`backtest-detail-page.tsx` 의 미청산 포지션 표에 열을 하나 더한다. 값은 `lastPriceTsMs` 를 `YYYY-MM-DD` 로 자른 것이고, 기간 종료일과 벌어져 있으면 경과일을 함께 적는다.

```tsx
<TableHead>마지막 확인일</TableHead>
```

```tsx
<TableCell>
  {new Date(position.lastPriceTsMs).toISOString().slice(0, 10)}
  {staleDays(position.lastPriceTsMs, periodEndTsMs) > 0
    ? ` (${staleDays(position.lastPriceTsMs, periodEndTsMs)}일 경과)`
    : ''}
</TableCell>
```

`staleDays` 는 같은 파일에 두는 순수 함수다:

```tsx
/** 마지막으로 가격을 확인한 날부터 기간 종료일까지의 일수 — 0이면 끝까지 거래된 종목이다 */
function staleDays(lastPriceTsMs: number, periodEndTsMs: number): number {
  return Math.max(0, Math.round((periodEndTsMs - lastPriceTsMs) / 86_400_000));
}
```

- [ ] **Step 2: 경고가 이미 청산·제외를 말하는지 확인한다**

Task 9 의 경고가 청산 건수와 손익을, Task 6 의 `excludedNonTradingTotal` 이 제외 건수를 담는다. 제외 건수는 워커가 실행 경고에 한 줄로 더한다 (`datasetWarnings.push`):

```ts
    if (resolved.excludedNonTradingTotal > 0) {
      datasetWarnings.push(
        `리밸런스 기준일에 거래정지·무거래여서 유니버스 후보에서 제외된 종목 ${resolved.excludedNonTradingTotal}건 `
          + '(중복 포함). 그날 실제로 매수할 수 없는 종목입니다.',
      );
    }
```

`resolved` 를 워커가 들고 있지 않으면 `stored-request.ts` / `job-queue` 경로에서 이미 넘겨받는 값을 따라간다.

- [ ] **Step 3: e2e 단언을 더한다**

`tests/e2e/mvp-flow.spec.ts` 의 결과 화면 검증에 한 줄 더한다. 미청산 포지션 표가 있는 실행에서만 의미가 있으므로, 기존에 미청산을 확인하는 단언 옆에 붙인다.

```ts
await expect(page.getByRole('columnheader', { name: '마지막 확인일' })).toBeVisible();
```

- [ ] **Step 4: 검증 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Run: `pnpm test:e2e`
Expected: 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add src/web src/server tests/
git commit -m "feat(web): 결과 화면이 폐지 청산·유니버스 제외·stale 미청산을 밝힌다"
```

---

## Task 12: 문서 갱신

**Files:**
- Modify: `docs/IMPLEMENTATION_STATUS.md:41`
- Modify: `docs/DECISIONS.md` (새 D 항목)
- Modify: `docs/reviews/BACKTEST_BIAS_REVIEW.md` (B-001·B-002 상태)

- [ ] **Step 1: `IMPLEMENTATION_STATUS.md` 를 고친다**

41행의 "배당·생존 편향 미보정 — 결과 화면 경고에 표시 (§9.4)" 를 아래로 바꾼다:

```
- **상장폐지 청산과 거래불가일을 반영한다 (D-044)** — 폐지 종목은 마지막 거래 가능 봉 종가로 전량 청산되고 거래 내역에 사유 `DELISTED` 가 남는다(수수료·매도세·슬리피지는 정상 매도와 같다). 거래정지·무거래 종목은 유니버스 후보와 매수에서 빠진다. KRX 는 둘을 구분해 주지 않아 하나로 다룬다 — 사유가 필요하면 KIND 수집이 따로 있어야 한다. 거래불가일은 `krx_non_trading_days` 에 쌓이고 과거분은 `pnpm cli krx:backfill-non-trading --from <날짜> --to <날짜>` 로 채운다. 백필 전 구간은 결과 경고가 "거래불가일 정보가 없습니다" 로 밝힌다. **배당·유상증자 권리락은 여전히 미보정이다.** "생존 편향" 이라는 단일 라벨은 더 이상 쓰지 않는다 — 부분 보정이라 예/아니오로 답할 수 없다
```

- [ ] **Step 2: `DECISIONS.md` 에 항목을 더한다**

기존 항목 형식을 따라 D-044 를 쓴다. 담을 것:
- KRX 실응답 실측 결과(시·고·저 `"0"`, `null` 아님)와 그래서 `isValidCandle` 이 거래불가일을 파싱 버그로 오분류하고 있었다는 것
- 거래정지와 무거래를 나누지 않은 이유(응답이 같고 체결 관점에서 같은 사건)
- 봉 테이블에 flat 봉을 채우지 않고 테이블을 나눈 이유(없는 가격을 만들지 않는다, 청산가 오용 방지)
- 청산가를 마지막 거래 가능 봉 종가로 정한 이유(정리매매가 이미 봉에 있다, `-100%` 와 CRSP 사유별 추정치를 쓰지 않은 이유)
- 백필을 `ingestDate` 재실행이 아니라 전용 경로로 뺀 이유(이벤트 재생성 위험)
- 유니버스 제외가 `scheduleHash` 를 바꾸므로 엔진 버전을 1.5.0 으로 올렸다는 것

- [ ] **Step 3: `BACKTEST_BIAS_REVIEW.md` 를 갱신한다**

B-001("거래 데이터가 끊긴 보유 종목을 마지막 가격으로 계속 평가한다")의 **현재 대응** 항목에 폐지 종목은 이제 청산된다는 것과, 원인 불명 단절은 여전히 stale 로 남되 마지막 확인일이 표시된다는 것을 적는다. 상태는 "부분 해결" 로 바꾸고 남은 부분(원인 불명 단절, 정지 사유 구분)을 명시한다.

B-002 의 **현재 대응** 에서 옛 경고 문구 인용을 새 문구로 바꾼다.

- [ ] **Step 4: 커밋과 푸시**

```bash
git add docs/
git commit -m "docs: 상장폐지 청산과 거래불가일 반영을 기록한다"
git push
```

문서는 커밋만 하지 않고 푸시까지 한다 — 확인 PC 가 다르다.

---

## Self-Review

**스펙 커버리지**

| 스펙 절 | 태스크 |
|---|---|
| §1.1 테이블 | Task 2 |
| §1.2 판정 조건 | Task 1 |
| §1.3 수집 경로·주석 정정 | Task 3 |
| §1.4 백필·커버리지 | Task 4, 5 |
| §2 유니버스 제외·`scheduleHash` | Task 6 |
| §3.1 후보 제외 | Task 7 |
| §3.2 체결·경고 | Task 7, 9 |
| §3.3 평가·경과일 | Task 8 (`lastPriceTsMs`), Task 11 |
| §3.4 강제 청산 | Task 8 |
| §3.5 `onForcedExit` | Task 8 |
| §3.6 look-ahead 방어 | Task 8 (입력 주석 + 컨텍스트 미노출) |
| §4 경고 재작성 | Task 9, 11 |
| §5 마이그레이션 | Task 2 |
| §6 테스트 | Task 1·3·4·5·6·7·8·9·10·11 |

**남은 위험**

- Task 3 이 `tests/unit/symbol-master-daily-bars.test.ts` 의 기존 단언을 흔들 수 있다. 거래불가 행이 `invalidCount` 통에서 빠지므로 그 값을 단언하는 테스트가 있으면 실패한다.
- Task 10 의 `delistedEventsBetween` 이 `symbol_master_events.oldValue` JSON 에서 `shortCode` 를 꺼낸다. `diffUniverse` 가 `DELISTED` 이벤트의 `oldValue` 에 `SymbolMasterEntry` 전체를 넣으므로(`symbol-master.ts:64-65`) 값은 있다. 파싱 실패에 대비해 건너뛰고 로그를 남긴다.
- Task 9 가 `warning-groups` 의 라벨 추출 방식에 걸린다. 새 문장이 어떤 라벨을 내는지 확인하고 단언을 맞춰야 한다.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-08-delisting-and-non-trading-days.md`.**
