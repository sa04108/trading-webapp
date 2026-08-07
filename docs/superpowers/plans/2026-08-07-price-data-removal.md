# 가격 데이터 기능 제거와 일봉 저장소 SQLite 전환 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 가격 데이터 화면과 증권사 캔들 수집 경로를 제거하고, 백테스트가 소비하는 유일한 봉을 `krx_daily_bars`(SQLite) 일봉으로 확정한다.

**Architecture:** 봉 저장소를 `CompositeCandleRepository`(KRX 우선 + parquet 위임)에서 `KrxDailyCandleRepository`(SQLite 단독)로 교체한다. 1m·1h 가 사라지므로 슬라이스 축(`DatasetSlice`)과 `Timeframe` 의 다중 값이 함께 사라지고, 백테스트 검증은 `symbol_coverage` 캐시 대신 `krx_daily_bars` 를 직접 집계한다. 증권사 어댑터는 소비자가 없어져 제거한다.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM(better-sqlite3), React + TanStack Query, Vitest, Playwright

## Global Constraints

- 이 계획은 **스키마를 바꾸지 않는다.** 죽는 테이블(`symbol_slices`, `symbol_coverage`, `data_sync_jobs`)과 컬럼 정리, 마이그레이션 스쿼시는 Plan 2 가 담당한다. 여기서는 쓰지 않게만 만든다.
- `@duckdb/node-api` 의존성은 **남긴다.** facts 저장소가 아직 쓴다 — Plan 2 에서 제거한다.
- 한국어 주석·문서는 `CLAUDE.md` 규칙을 따른다 (문어체 평서형, 번역투 금지, 주석은 "왜"를 쓴다).
- 검증 명령: `pnpm typecheck`, `pnpm test`, `pnpm lint`. 각 태스크 끝에서 최소한 관련 테스트와 `pnpm typecheck` 가 통과해야 한다.
- 커밋 메시지는 기존 관례를 따른다 — `<type>(<scope>): <한국어 요약>` (예: `refactor(market-data): 일봉 저장소를 SQLite 단독으로 바꾼다`).
- 삭제한 모듈을 참조하는 테스트는 **삭제**하고, 살아남은 동작을 검증하는 테스트는 **남긴다.** 판단이 애매하면 남기고 고친다.

---

## File Structure

### 신설

| 경로 | 책임 |
|---|---|
| `src/server/modules/market-data/infrastructure/krx-daily-candle-repository.ts` | `krx_daily_bars` 를 읽어 `Candle` 을 내는 유일한 봉 저장소. 날짜 범위를 SQL 로 내린다. |
| `tests/unit/krx-daily-candle-repository.test.ts` | 위 저장소의 경계 변환·범위 질의 검증 |

### 삭제 (서버)

| 경로 | 이유 |
|---|---|
| `src/server/modules/market-data/infrastructure/parquet-candle-repository.ts` | parquet 봉 저장 폐기 |
| `src/server/modules/market-data/infrastructure/composite-candle-repository.ts` | 이중 출처 봉합 계층이 불필요 |
| `src/server/modules/market-data/application/broker-sync-service.ts` | 증권사 봉 수집 폐기 |
| `src/server/modules/market-data/application/csv-parser.ts` | CSV 가져오기 폐기 |
| `src/server/modules/market-data/domain/aggregate.ts` | 1h 집계 폐기 |
| `src/server/modules/market-data/domain/minute-backfill.ts` | 1m 백필 계획 폐기 |
| `src/server/modules/market-data/domain/coverage.ts` | 시간봉 기대 봉 수 계산 폐기 |
| `src/server/modules/market-data/domain/dataset-slice.ts` | 슬라이스 축 소멸 |
| `src/server/modules/broker/**` (3개 파일) | `MarketDataSource` 소비자 소멸 |

### 삭제 (웹)

| 경로 | 이유 |
|---|---|
| `src/web/features/datasets/symbols-panel.tsx` | 가격 데이터 화면 본체 |
| `src/web/features/datasets/symbol-list.tsx` | 위 화면 전용 |
| `src/web/features/datasets/symbol-check-list.tsx` | 위 화면 전용 |
| `src/web/features/datasets/symbol-select-scope.tsx` | 위 화면 전용 |
| `src/web/features/datasets/sync-dialog.tsx` | 동기화 UI |
| `src/web/features/datasets/candle-inspect-drawer.tsx` | 봉 점검 UI |
| `src/web/features/datasets/symbol-facts-badge.tsx` | 위 화면 전용 |

### 유지 (웹, 다른 기능이 참조한다 — 삭제하면 위저드가 깨진다)

- `src/web/features/datasets/symbol-types.ts` — `new-backtest-wizard.tsx`, `universe-rule-step.tsx` 가 쓴다
- `src/web/features/datasets/symbol-sort.ts` — `src/web/lib/use-symbol-metrics.ts` 가 쓴다
- `src/web/features/datasets/symbol-search.ts`, `symbol-codes.ts` — 위저드 유니버스 선택이 쓴다
- `src/web/features/datasets/dataset-slices.ts` — `wizardTimeframes` 를 위저드가 쓴다. **파일은 남기되 내용을 1d 전용으로 줄인다** (Task 8)

### 수정

| 경로 | 변경 |
|---|---|
| `src/server/modules/market-data/application/ports.ts` | `MarketDataSource`, `FetchCandleRequest/Result`, `MarketDataSourceNotConfiguredError`, `UnsupportedTimeframeError` 제거. `CandleRepository` 를 읽기 전용으로 축소 |
| `src/server/modules/market-data/application/symbol-service.ts` | 봉 수집·CSV·점검·슬라이스 메서드 제거 |
| `src/server/modules/market-data/presentation/symbol-routes.ts` | 봉 관련 라우트 5개 제거 |
| `src/server/modules/market-data/domain/candle.ts` | `Timeframe` 을 `'1d'` 로 좁힌다 |
| `src/server/modules/backtest/presentation/backtest-routes.ts` | 슬라이스 축 제거, 커버리지를 저장소에서 직접 구한다 |
| `src/server/modules/backtest/domain/bar-estimate.ts` | 1h→1m 배율 제거 |
| `src/server/bootstrap/container.ts` | 봉 저장소 교체, 증권사·BrokerSync 조립 제거 |
| `src/workers/backtest-child.ts` | 봉 저장소 교체 |
| `src/shared/schemas/backtest-request.ts` | `timeframe` 을 `'1d'` 로 좁힌다 |
| `src/web/app/router.tsx` | `/datasets/prices` 라우트 제거 |
| `src/web/features/datasets/data-page.tsx` | 가격 데이터 구획 링크 제거 |

---

### Task 1: KrxDailyCandleRepository 신설

`krx_daily_bars` 를 읽는 유일한 봉 저장소를 만든다. 기존 `CompositeCandleRepository.krxRows` 의 결함 두 가지를 함께 고친다 — 종목 전체 행을 올린 뒤 JS 에서 거르던 것을 SQL 범위 질의로 내리고, 불필요한 재정렬을 없앤다.

경계 변환이 이 태스크의 핵심이다. `krx_daily_bars.date` 는 `'YYYY-MM-DD'` 텍스트고 질의 경계는 `tsMs` 숫자다. 날짜 `D` 의 봉은 `midnight(D)` 에 놓이므로:

- 하한: `midnight(D) >= fromTsMs` 를 만족하는 가장 이른 `D` — `fromTsMs` 가 자정이면 그 날, 아니면 **다음 날**
- 상한: `midnight(D) <= toTsMs` 를 만족하는 가장 늦은 `D` — `toTsMs` 가 속한 날

`'YYYY-MM-DD'` 는 사전순이 곧 시간순이라 이 두 값을 구하면 TEXT 비교로 정확히 거를 수 있다.

**Files:**
- Create: `src/server/modules/market-data/infrastructure/krx-daily-candle-repository.ts`
- Test: `tests/unit/krx-daily-candle-repository.test.ts`

**Interfaces:**
- Consumes: `krxDailyBars` (`src/server/shared/db/schema.ts`), `AppDatabase` (`src/server/shared/db/database.ts`), `Candle`/`Market`/`Timeframe` (`src/server/modules/market-data/domain/candle.ts`)
- Produces:
  - `export class KrxDailyCandleRepository implements CandleRepository`
  - `constructor(db: AppDatabase)`
  - `getCandles(query: CandleQuery): AsyncIterable<Candle>`
  - `getTimestamps(market: Market, timeframe: Timeframe, symbol: string): Promise<number[]>`
  - `export function ceilToDate(tsMs: number): string`
  - `export function floorToDate(tsMs: number): string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/krx-daily-candle-repository.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { krxDailyBars } from '../../src/server/shared/db/schema.js';
import type { AppDatabase } from '../../src/server/shared/db/database.js';
import {
  KrxDailyCandleRepository,
  ceilToDate,
  floorToDate,
} from '../../src/server/modules/market-data/infrastructure/krx-daily-candle-repository.js';

const DAY = 86_400_000;
const midnight = (date: string): number => Date.parse(`${date}T00:00:00Z`);

describe('날짜 경계 변환', () => {
  it('하한이 정확히 자정이면 그 날을 포함한다', () => {
    expect(ceilToDate(midnight('2026-08-07'))).toBe('2026-08-07');
  });

  it('하한이 자정이 아니면 다음 날로 올린다', () => {
    expect(ceilToDate(midnight('2026-08-07') + 1)).toBe('2026-08-08');
    expect(ceilToDate(Date.parse('2026-08-07T05:00:00Z'))).toBe('2026-08-08');
  });

  it('상한은 그 시각이 속한 날로 내린다', () => {
    expect(floorToDate(Date.parse('2026-08-07T23:59:59.999Z'))).toBe('2026-08-07');
    expect(floorToDate(midnight('2026-08-07'))).toBe('2026-08-07');
  });
});

describe('KrxDailyCandleRepository', () => {
  let db: AppDatabase;
  let repository: KrxDailyCandleRepository;

  beforeEach(async () => {
    const t = await createTestApp();
    db = t.container.database.db;
    db.insert(krxDailyBars)
      .values([
        { shortCode: '005930', date: '2026-08-05', market: 'KOSPI', open: 100, high: 110, low: 90, close: 105, volume: 1000 },
        { shortCode: '005930', date: '2026-08-06', market: 'KOSPI', open: 105, high: 115, low: 95, close: 110, volume: 2000 },
        { shortCode: '005930', date: '2026-08-07', market: 'KOSPI', open: 110, high: 120, low: 100, close: 115, volume: 3000 },
        { shortCode: '000660', date: '2026-08-06', market: 'KOSPI', open: 200, high: 210, low: 190, close: 205, volume: 500 },
      ])
      .run();
    repository = new KrxDailyCandleRepository(db);
  });

  const collect = async (query: Parameters<KrxDailyCandleRepository['getCandles']>[0]) => {
    const out = [];
    for await (const candle of repository.getCandles(query)) out.push(candle);
    return out;
  };

  it('요청 범위 안의 봉만 낸다', async () => {
    const candles = await collect({
      market: 'KR',
      timeframe: '1d',
      symbols: ['005930'],
      fromTsMs: midnight('2026-08-06'),
      toTsMs: Date.parse('2026-08-06T23:59:59.999Z'),
    });
    expect(candles).toHaveLength(1);
    expect(candles[0]?.tsMs).toBe(midnight('2026-08-06'));
    expect(candles[0]?.close).toBe(110);
  });

  it('경계가 자정이 아니면 그 날을 제외한다', async () => {
    const candles = await collect({
      market: 'KR',
      timeframe: '1d',
      symbols: ['005930'],
      fromTsMs: midnight('2026-08-05') + 1,
      toTsMs: midnight('2026-08-07') + DAY,
    });
    expect(candles.map((candle) => candle.tsMs)).toEqual([
      midnight('2026-08-06'),
      midnight('2026-08-07'),
    ]);
  });

  it('경계를 주지 않으면 종목의 모든 봉을 낸다', async () => {
    const candles = await collect({ market: 'KR', timeframe: '1d', symbols: ['005930'] });
    expect(candles).toHaveLength(3);
  });

  it('여러 종목을 요청하면 종목별로 날짜 오름차순으로 낸다', async () => {
    const candles = await collect({
      market: 'KR',
      timeframe: '1d',
      symbols: ['005930', '000660'],
    });
    expect(candles).toHaveLength(4);
    const bySymbol = candles.filter((candle) => candle.symbol === '005930');
    expect(bySymbol.map((candle) => candle.tsMs)).toEqual([
      midnight('2026-08-05'),
      midnight('2026-08-06'),
      midnight('2026-08-07'),
    ]);
  });

  it('KR 이 아닌 시장은 빈 결과를 낸다', async () => {
    const candles = await collect({ market: 'US', timeframe: '1d', symbols: ['005930'] });
    expect(candles).toHaveLength(0);
  });

  it('getTimestamps 는 저장된 봉의 시각을 오름차순으로 준다', async () => {
    const timestamps = await repository.getTimestamps('KR', '1d', '005930');
    expect(timestamps).toEqual([
      midnight('2026-08-05'),
      midnight('2026-08-06'),
      midnight('2026-08-07'),
    ]);
  });
});
```

- [ ] **Step 2: 테스트 DB 패턴을 확인한다**

이 저장소의 단위 테스트는 별도 DB 헬퍼를 두지 않고 `createTestApp()` 이 만든 컨테이너의 DB 를 그대로 쓴다. `tests/unit/krx-daily-bars-schema.test.ts` 가 같은 패턴이니 그것을 본보기로 삼는다:

Run: `head -12 tests/unit/krx-daily-bars-schema.test.ts`

`createTestApp()` 은 async 라 `beforeEach` 도 async 여야 한다. 새 헬퍼 파일을 만들지 않는다.

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run tests/unit/krx-daily-candle-repository.test.ts`
Expected: FAIL — `Failed to resolve import ".../krx-daily-candle-repository.js"`

- [ ] **Step 4: 저장소를 구현한다**

`src/server/modules/market-data/infrastructure/krx-daily-candle-repository.ts`:

```ts
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { krxDailyBars } from '../../../shared/db/schema.js';
import type { Candle, Market, Timeframe } from '../domain/candle.js';
import type { CandleQuery, CandleRepository } from '../application/ports.js';

const MS_PER_DAY = 86_400_000;

/**
 * 봉의 tsMs 규약은 "그 거래일의 UTC 자정"이다. `periodToTsRange` 가 만드는 조회
 * 범위와 같은 기준이라야 그 날의 봉이 범위 안에 들어온다 (설계 2026-08-06-krx-daily-bars).
 */
function dateToTsMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function tsMsToDate(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

/**
 * `midnight(D) >= tsMs` 를 만족하는 가장 이른 날짜 D.
 *
 * 경계를 SQL 로 내리려면 tsMs 를 날짜로 바꿔야 하는데, 하한은 그냥 자르면 안 된다 —
 * 08-07T05:00 을 08-07 로 자르면 범위 밖인 08-07 자정 봉이 딸려 들어온다. 자정이
 * 아닌 하한은 다음 날로 올려야 정확하다.
 */
export function ceilToDate(tsMs: number): string {
  const remainder = ((tsMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return tsMsToDate(remainder === 0 ? tsMs : tsMs + (MS_PER_DAY - remainder));
}

/** `midnight(D) <= tsMs` 를 만족하는 가장 늦은 날짜 D — 상한은 자르기만 하면 된다 */
export function floorToDate(tsMs: number): string {
  return tsMsToDate(tsMs);
}

/**
 * KRX 일봉(`krx_daily_bars`)을 읽는 유일한 봉 저장소.
 *
 * 쓰기는 `SymbolMasterService.ingestDate` 가 종목 마스터 이벤트·coverage 와 같은
 * 트랜잭션 안에서 직접 한다. 저장소가 쓰기를 갖지 않는 이유가 그것이다 — 봉만 따로
 * 쓰는 경로가 생기면 그 원자성이 깨진다.
 */
export class KrxDailyCandleRepository implements CandleRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * `krx_daily_bars` 는 국내 종목만 담는다. `Market` 은 세션 축(KR/US)이고 테이블의
   * market 컬럼은 KOSPI/KOSDAQ 이라 값 체계가 달라 직접 비교할 수 없다 — KR 인지만
   * 본다.
   */
  private supports(market: Market, timeframe: Timeframe): boolean {
    return market === 'KR' && timeframe === '1d';
  }

  private rows(symbol: string, fromTsMs?: number, toTsMs?: number) {
    const conditions = [eq(krxDailyBars.shortCode, symbol)];
    if (fromTsMs !== undefined) conditions.push(gte(krxDailyBars.date, ceilToDate(fromTsMs)));
    if (toTsMs !== undefined) conditions.push(lte(krxDailyBars.date, floorToDate(toTsMs)));

    return this.db
      .select()
      .from(krxDailyBars)
      .where(and(...conditions))
      .orderBy(asc(krxDailyBars.date))
      .all();
  }

  async *getCandles(query: CandleQuery): AsyncIterable<Candle> {
    if (!this.supports(query.market, query.timeframe)) return;

    for (const symbol of query.symbols) {
      for (const row of this.rows(symbol, query.fromTsMs, query.toTsMs)) {
        yield {
          symbol,
          market: query.market,
          timeframe: query.timeframe,
          tsMs: dateToTsMs(row.date),
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        };
      }
    }
  }

  async getTimestamps(market: Market, timeframe: Timeframe, symbol: string): Promise<number[]> {
    if (!this.supports(market, timeframe)) return [];
    return this.rows(symbol).map((row) => dateToTsMs(row.date));
  }
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/unit/krx-daily-candle-repository.test.ts`
Expected: PASS (7 tests)

`CandleRepository` 인터페이스가 아직 `saveCandles`/`deleteSymbol` 을 요구해 타입 오류가 나면 Task 2 에서 인터페이스를 줄이므로, 이 단계에서는 `implements CandleRepository` 를 잠시 떼고 통과시킨 뒤 Task 2 에서 다시 붙인다.

- [ ] **Step 6: 커밋**

```bash
git add tests/unit/krx-daily-candle-repository.test.ts src/server/modules/market-data/infrastructure/krx-daily-candle-repository.ts tests/helpers/
git commit -m "feat(market-data): KRX 일봉을 SQLite 에서 직접 읽는 저장소를 더한다"
```

---

### Task 2: 봉 저장소 교체와 parquet 캔들 제거

조립부와 워커가 새 저장소를 쓰게 하고, `CandleRepository` 포트에서 쓰기 메서드를 없앤다. 쓰기 경로가 `SymbolMasterService.ingestDate` 하나로 좁혀지므로 포트가 쓰기를 노출할 이유가 없다.

**Files:**
- Modify: `src/server/modules/market-data/application/ports.ts`
- Modify: `src/server/bootstrap/container.ts:175-195, 340-373`
- Modify: `src/workers/backtest-child.ts:31-36, 55-70, 180-200, 430-440`
- Delete: `src/server/modules/market-data/infrastructure/parquet-candle-repository.ts`
- Delete: `src/server/modules/market-data/infrastructure/composite-candle-repository.ts`
- Delete: `tests/unit/composite-candle-repository.test.ts`

**Interfaces:**
- Consumes: `KrxDailyCandleRepository` (Task 1)
- Produces: 축소된 `CandleRepository` — `getCandles` 와 `getTimestamps` 만 갖는다

- [ ] **Step 1: 포트에서 쓰기 메서드를 없앤다**

`src/server/modules/market-data/application/ports.ts` 의 `CandleRepository` 를 아래로 교체한다:

```ts
export interface CandleRepository {
  getCandles(query: CandleQuery): AsyncIterable<Candle>;
  /** 저장된 봉의 시작 시각 목록 (coverage 계산용) */
  getTimestamps(market: Market, timeframe: Timeframe, symbol: string): Promise<number[]>;
}
```

- [ ] **Step 2: parquet·composite 저장소와 그 테스트를 지운다**

```bash
git rm src/server/modules/market-data/infrastructure/parquet-candle-repository.ts \
       src/server/modules/market-data/infrastructure/composite-candle-repository.ts \
       tests/unit/composite-candle-repository.test.ts
```

- [ ] **Step 3: container 조립을 바꾼다**

`src/server/bootstrap/container.ts` 에서 아래 import 를 지운다:

```ts
import { ParquetCandleRepository } from '../modules/market-data/infrastructure/parquet-candle-repository.js';
import { CompositeCandleRepository } from '../modules/market-data/infrastructure/composite-candle-repository.js';
```

대신 추가한다:

```ts
import { KrxDailyCandleRepository } from '../modules/market-data/infrastructure/krx-daily-candle-repository.js';
```

175~185행 근처의 저장소 조립을 아래로 교체한다 (`duckdb` 인스턴스 생성은 facts 가 아직 쓰므로 남긴다):

```ts
  const duckdb = new DuckDbService({
    threads: config.duckdbThreads,
    memoryLimit: config.duckdbMemoryLimit,
  });
  // 봉은 KRX 일봉 하나뿐이다 — 쓰기는 SymbolMasterService.ingestDate 가 종목 마스터
  // 이벤트와 같은 트랜잭션에서 직접 한다.
  const candleRepository = new KrxDailyCandleRepository(database.db);
```

- [ ] **Step 4: 워커 조립을 바꾼다**

`src/workers/backtest-child.ts` 에서 `ParquetCandleRepository`·`CompositeCandleRepository` import 를 지우고 `KrxDailyCandleRepository` 를 넣는다. 189행의 조립을 교체한다:

```ts
    const repository = new KrxDailyCandleRepository(db);
```

`DuckDbService` 는 `ParquetFactRepository` 가 아직 쓰므로 남긴다.

- [ ] **Step 5: 타입 검사로 남은 참조를 찾는다**

Run: `pnpm typecheck`
Expected: `saveCandles`/`deleteSymbol` 을 부르는 곳(`broker-sync-service.ts`, `symbol-service.ts`)에서 오류가 난다. 그 파일들은 Task 5·6 에서 지우므로, 지금은 오류 목록을 메모만 하고 넘어간다.

Run: `pnpm vitest run tests/unit/krx-daily-candle-repository.test.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "refactor(market-data): 봉 저장소를 KRX 일봉 단독으로 바꾼다"
```

---

### Task 3: 증권사 어댑터와 BrokerSyncService 제거

`MarketDataSource` 의 소비자가 사라진다. 매매 시스템은 나중에 자기 형태의 포트를 새로 갖는다 — 지금 형태를 남겨 두면 쓰이지 않는 채 낡는다.

**Files:**
- Delete: `src/server/modules/broker/infrastructure/toss/toss-market-data-source.ts`
- Delete: `src/server/modules/broker/infrastructure/kiwoom/kiwoom-market-data-source.ts`
- Delete: `src/server/modules/market-data/application/broker-sync-service.ts`
- Delete: `src/server/modules/market-data/application/csv-parser.ts`
- Delete: `src/server/modules/market-data/domain/aggregate.ts`
- Delete: `src/server/modules/market-data/domain/minute-backfill.ts`
- Delete: `src/server/modules/market-data/domain/coverage.ts`
- Delete: `tests/unit/broker-sync-service.test.ts`, `tests/unit/toss-market-data-source.test.ts`, `tests/unit/csv-parser.test.ts`, `tests/unit/aggregate.test.ts`, `tests/unit/minute-backfill.test.ts`, `tests/unit/coverage.test.ts`, `tests/unit/candle-sync-estimate.test.ts`
- Modify: `src/server/modules/market-data/application/ports.ts`
- Modify: `src/server/bootstrap/container.ts`

**Interfaces:**
- Produces: `ports.ts` 에서 `MarketDataSource`, `FetchCandleRequest`, `FetchCandleResult`, `MarketDataSourceNotConfiguredError`, `UnsupportedTimeframeError` 가 사라진다. `StockInfoSource`·`StockQuoteSource`·`MarketRankingSource`·`KrxHistoricalUniverseSource` 는 남는다.

- [ ] **Step 1: `broker/infrastructure/errors.ts` 의 사용처를 확인한다**

Run: `grep -rn "broker/infrastructure/errors" src --include=*.ts`

`toss-market-data-source.ts` 외에도 쓰는 곳이 있으면 파일을 남기고, 없으면 `src/server/modules/broker` 디렉터리 전체를 지운다.

- [ ] **Step 2: 모듈과 테스트를 지운다**

```bash
git rm -r src/server/modules/broker
git rm src/server/modules/market-data/application/broker-sync-service.ts \
       src/server/modules/market-data/application/csv-parser.ts \
       src/server/modules/market-data/domain/aggregate.ts \
       src/server/modules/market-data/domain/minute-backfill.ts \
       src/server/modules/market-data/domain/coverage.ts
git rm tests/unit/broker-sync-service.test.ts tests/unit/toss-market-data-source.test.ts \
       tests/unit/csv-parser.test.ts tests/unit/aggregate.test.ts \
       tests/unit/minute-backfill.test.ts tests/unit/coverage.test.ts \
       tests/unit/candle-sync-estimate.test.ts
```

Step 1 에서 `errors.ts` 를 남기기로 했다면 `git rm -r src/server/modules/broker` 대신 두 어댑터 파일만 지운다.

- [ ] **Step 3: 포트에서 죽은 계약을 지운다**

`src/server/modules/market-data/application/ports.ts` 에서 아래 블록을 통째로 지운다:

```ts
export interface FetchCandleRequest { ... }
export interface FetchCandleResult { ... }
export interface MarketDataSource { ... }
export class MarketDataSourceNotConfiguredError extends Error { ... }
export class UnsupportedTimeframeError extends Error { ... }
```

- [ ] **Step 4: container 에서 증권사 조립을 지운다**

`src/server/bootstrap/container.ts` 에서:
- `import { BrokerSyncService } ...`, `import { createTossMarketDataSource } ...` 제거
- `AppContainer` 인터페이스의 `readonly brokerSyncService: BrokerSyncService;` 제거
- 232~250행의 `marketDataSource`·`brokerSyncService` 생성 블록 제거
- 반환 객체의 `brokerSyncService` 항목 제거

- [ ] **Step 5: 남은 참조를 찾아 지운다**

Run: `grep -rn "brokerSyncService\|BrokerSyncService\|MarketDataSource\|aggregateToHourly\|csv-parser\|minute-backfill" src tests --include=*.ts --include=*.tsx`

나온 참조를 전부 지운다. `symbol-service.ts`·`symbol-routes.ts` 의 참조는 Task 5 에서 그 코드 자체가 사라지므로, 여기서는 컴파일이 되도록 최소한만 손댄다.

Run: `pnpm typecheck`
Expected: `symbol-service.ts`, `symbol-routes.ts`, `backtest-routes.ts` 에만 오류가 남는다

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "refactor(market-data): 증권사 봉 수집 경로를 걷어낸다"
```

---

### Task 4: Timeframe 을 1d 로 좁힌다

`Timeframe` 이 `'1m' | '1h' | '1d'` 인 한 죽은 분기가 코드 전체에 남는다. 타입을 먼저 좁히면 컴파일러가 남은 곳을 전부 짚어 준다.

**Files:**
- Modify: `src/server/modules/market-data/domain/candle.ts`
- Modify: `src/shared/schemas/backtest-request.ts`
- Modify: `src/server/modules/backtest/domain/bar-estimate.ts`
- Delete: `src/server/modules/market-data/domain/dataset-slice.ts`
- Delete: `tests/unit/dataset-slice.test.ts`

웹 쪽 `tests/unit/job-timeframe.test.ts`·`tests/unit/dataset-slices.test.ts` 는 Task 8 에서 다룬다 — 대상 코드가 `src/web` 에 있다.

**Interfaces:**
- Produces: `export type Timeframe = '1d';` — `DatasetSlice` 와 `sliceForTimeframe`/`sliceTimeframes`/`coverageTimeframeForSlice`/`collectTimeframeForSlice` 가 사라진다

- [ ] **Step 1: 도메인 타입을 좁힌다**

`src/server/modules/market-data/domain/candle.ts`:

```ts
/** 봉 주기. KRX 일별매매가 유일한 봉 출처라 일봉뿐이다. */
export type Timeframe = '1d';
```

- [ ] **Step 2: 슬라이스 축을 지운다**

```bash
git rm src/server/modules/market-data/domain/dataset-slice.ts tests/unit/dataset-slice.test.ts
```

- [ ] **Step 3: 요청 스키마를 좁힌다**

`src/shared/schemas/backtest-request.ts:32` 을 바꾼다:

```ts
  timeframe: z.literal('1d').optional(),
```

`.optional()` 은 유지한다 — 미지정 요청은 Task 6 에서 항상 `'1d'` 로 해소되고, 기존 저장 요청도 그대로 통과해야 한다. 27~31행의 설계 문서 참조 주석은 아래로 바꾼다:

```ts
  /** 소비 봉 주기. KRX 일봉이 유일한 출처라 일봉뿐이다 (설계 2026-08-07-price-data-removal). */
```

- [ ] **Step 4: 봉 수 추정에서 배율을 없앤다**

`src/server/modules/backtest/domain/bar-estimate.ts` 에서 1h→1m 배율(60) 분기를 제거한다. 커버리지 timeframe 과 소비 timeframe 이 모두 `'1d'` 라 배율이 항상 1 이다.

- [ ] **Step 5: 컴파일러가 짚는 곳을 따라간다**

Run: `pnpm typecheck`

`'1m'`·`'1h'` 리터럴을 쓰던 곳이 전부 오류로 뜬다. 서버 쪽을 이 태스크에서 정리하고, `src/web` 오류는 Task 8 로 미룬다.

Run: `pnpm vitest run tests/unit/bar-estimate.test.ts`
Expected: PASS (1h 배율을 검증하던 케이스가 있으면 삭제한다)

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "refactor(market-data): 봉 주기를 일봉 하나로 좁힌다"
```

---

### Task 5: SymbolService 축소와 봉 라우트 제거

봉 수집·CSV 가져오기·봉 점검·슬라이스 버전 관리가 전부 사라진다. 종목 등록·이름·메트릭만 남는다.

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-service.ts`
- Modify: `src/server/modules/market-data/presentation/symbol-routes.ts:211-390`
- Delete: `tests/integration/symbol-service-slices.test.ts`, `tests/unit/symbol-service-version-pin.test.ts`, `tests/unit/symbol-summary.test.ts`(슬라이스만 검증하면 삭제, 아니면 수정)

**Interfaces:**
- Produces: `SymbolService` 에서 아래가 사라진다 — `getCandleSyncEstimate`, `getMinutePlan`, `importCsv`, `rejectImport`, `getCandlesForInspection`, `getSyncJob`, `runningSyncJobId`, `markSynced`, `refreshCoverage`, `bumpVersion`, `getLatestVersion`, `versionSnapshotFor`, `getCoverage`
- `SymbolSummary.slices` 필드가 사라진다

- [ ] **Step 1: 라우트를 지운다**

`src/server/modules/market-data/presentation/symbol-routes.ts` 에서 아래 5개 핸들러를 제거한다:

- `GET /symbols/sync-estimate` (211행)
- `GET /symbols/:code/candles` (234행)
- `POST /symbols/import` (271행)
- `POST /symbols/sync` (336행)
- `GET /data-jobs/:jobId` (365행)
- `POST /data-jobs/:jobId/cancel` (373행)

남는 것: `GET /markets`, `GET /symbols/info`, `GET /symbols/metrics`, `GET /symbols`, `POST /symbols`, `POST /symbols/remove`

- [ ] **Step 2: SymbolService 에서 죽은 메서드를 지운다**

Step "Interfaces" 목록의 메서드를 전부 제거한다. `SymbolSummary` 에서 `slices` 필드를 빼고 `toSummary` 를 그에 맞게 줄인다.

`removeSymbols` 는 남긴다 — 단 `candleRepository.deleteSymbol` 호출을 제거한다. KRX 일봉은 시장 전체가 공유하는 자산이라 종목을 목록에서 빼는 일과 함께 지우면 안 된다 (기존 `CompositeCandleRepository.deleteSymbol` 주석의 근거를 그대로 따른다).

- [ ] **Step 3: 참조가 끊긴 곳을 고친다**

Run: `pnpm typecheck`

`backtest-routes.ts` 의 `getCoverage`·`versionSnapshotFor` 참조가 남는다 — Task 6 에서 처리하므로 여기서는 목록만 확인한다.

- [ ] **Step 4: 관련 테스트를 정리한다**

Run: `pnpm vitest run tests/integration/market-data.test.ts tests/integration/symbol-card.test.ts tests/integration/symbol-bulk-add.test.ts`

봉 수집·CSV·점검을 검증하던 케이스를 삭제하고, 종목 등록·조회를 검증하는 케이스는 살린다.

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "refactor(market-data): 봉 수집·가져오기 라우트와 서비스 메서드를 걷어낸다"
```

---

### Task 6: 백테스트 검증에서 슬라이스 축 제거

`checkPeriodCoverage`·`resolveConsumedUniverse` 가 `symbol_coverage` 캐시를 슬라이스로 걸러 쓴다. 슬라이스가 사라졌고 캐시도 Plan 2 에서 지우므로, 커버리지를 `krx_daily_bars` 에서 직접 구한다.

캐시를 없애도 되는 근거: 캐시가 필요했던 건 parquet 조회가 비쌌기 때문이다. `krx_daily_bars` 는 `(short_code, date)` PK 가 있어 종목당 `MIN`/`MAX`/`COUNT` 가 인덱스 스캔 하나다.

**Files:**
- Create: `src/server/modules/market-data/application/candle-coverage-service.ts`
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts:190-280, 520-600`
- Test: `tests/unit/candle-coverage-service.test.ts`

**Interfaces:**
- Produces:
  - `export interface CandleCoverageRow { readonly code: string; readonly firstTsMs: number | null; readonly lastTsMs: number | null; readonly barCount: number; }`
  - `export class CandleCoverageService { constructor(db: AppDatabase); getCoverage(codes: readonly string[]): CandleCoverageRow[] }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/unit/candle-coverage-service.test.ts`:

```ts
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { krxDailyBars } from '../../src/server/shared/db/schema.js';
import { CandleCoverageService } from '../../src/server/modules/market-data/application/candle-coverage-service.js';

const midnight = (date: string): number => Date.parse(`${date}T00:00:00Z`);

describe('CandleCoverageService', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let service: CandleCoverageService;

  // createTestApp 은 임시 디렉터리와 sqlite 핸들을 잡는다 — 닫지 않으면 테스트마다 샌다
  afterEach(async () => {
    await app.close();
  });

  beforeEach(async () => {
    app = await createTestApp();
    const db = app.container.database.db;
    db.insert(krxDailyBars)
      .values([
        { shortCode: '005930', date: '2026-08-05', market: 'KOSPI', open: 100, high: 110, low: 90, close: 105, volume: 1000 },
        { shortCode: '005930', date: '2026-08-07', market: 'KOSPI', open: 110, high: 120, low: 100, close: 115, volume: 3000 },
      ])
      .run();
    service = new CandleCoverageService(db);
  });

  it('보유 구간과 봉 수를 준다', () => {
    expect(service.getCoverage(['005930'])).toEqual([
      {
        code: '005930',
        firstTsMs: midnight('2026-08-05'),
        lastTsMs: midnight('2026-08-07'),
        barCount: 2,
      },
    ]);
  });

  it('봉이 없는 종목은 barCount 0 으로 준다 — 목록에서 빠지지 않는다', () => {
    expect(service.getCoverage(['000660'])).toEqual([
      { code: '000660', firstTsMs: null, lastTsMs: null, barCount: 0 },
    ]);
  });

  it('빈 코드 목록에는 빈 배열을 준다', () => {
    expect(service.getCoverage([])).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm vitest run tests/unit/candle-coverage-service.test.ts`
Expected: FAIL — 모듈을 찾을 수 없다

- [ ] **Step 3: 구현한다**

`src/server/modules/market-data/application/candle-coverage-service.ts`:

```ts
import { count, inArray, max, min } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { krxDailyBars } from '../../../shared/db/schema.js';

export interface CandleCoverageRow {
  readonly code: string;
  readonly firstTsMs: number | null;
  readonly lastTsMs: number | null;
  readonly barCount: number;
}

const dateToTsMs = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/**
 * 종목별 일봉 보유 구간. 캐시 테이블을 두지 않는 이유: `(short_code, date)` PK 가
 * 있어 집계가 인덱스 스캔 하나로 끝난다. 캐시가 필요했던 건 parquet 조회가 비쌌기
 * 때문이고, 그 비용이 사라지면 캐시는 어긋날 수 있는 사본일 뿐이다.
 */
export class CandleCoverageService {
  constructor(private readonly db: AppDatabase) {}

  getCoverage(codes: readonly string[]): CandleCoverageRow[] {
    if (codes.length === 0) return [];

    const rows = this.db
      .select({
        code: krxDailyBars.shortCode,
        firstDate: min(krxDailyBars.date),
        lastDate: max(krxDailyBars.date),
        barCount: count(),
      })
      .from(krxDailyBars)
      .where(inArray(krxDailyBars.shortCode, [...codes]))
      .groupBy(krxDailyBars.shortCode)
      .all();

    const byCode = new Map(rows.map((row) => [row.code, row]));

    // 봉이 없는 종목도 결과에 넣는다 — 호출부가 "없음" 과 "안 물어봄" 을 구분해야 한다
    return codes.map((code) => {
      const row = byCode.get(code);
      if (row === undefined || row.firstDate === null || row.lastDate === null) {
        return { code, firstTsMs: null, lastTsMs: null, barCount: 0 };
      }
      return {
        code,
        firstTsMs: dateToTsMs(row.firstDate),
        lastTsMs: dateToTsMs(row.lastDate),
        barCount: row.barCount,
      };
    });
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm vitest run tests/unit/candle-coverage-service.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: backtest-routes 를 고친다**

먼저 `BacktestRouteDeps`(51~64행)에 의존성을 더한다:

```ts
  readonly candleCoverage: CandleCoverageService;
```

핸들러 본문에서는 `deps` 구조분해에 맞춰 쓴다 — 기존 코드가 `symbolService` 를 어떻게 꺼내 쓰는지 확인하고(`grep -n "symbolService" src/server/modules/backtest/presentation/backtest-routes.ts | head -3`) 같은 방식으로 `candleCoverage` 를 꺼낸다. 아래 코드의 `candleCoverage` 는 그렇게 꺼낸 값이다.

`checkPeriodCoverage` 를 아래로 교체한다 (슬라이스 인자가 사라진다):

```ts
  const checkPeriodCoverage = (
    codes: readonly string[],
    period: { from: string; to: string },
  ): string | null => {
    const { fromTsMs, toTsMs } = periodToTsRange(period);
    const bySymbol = new Map(
      candleCoverage.getCoverage(codes).map((row) => [row.code, row]),
    );

    const ranges: string[] = [];
    for (const symbol of codes) {
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

`resolveConsumedUniverse` 에서 timeframe 해소 분기를 없앤다 — 선택지가 하나뿐이라 물어볼 것이 없다:

```ts
    const consumed = '1d' as const;
    const hasData = candleCoverage
      .getCoverage(codes)
      .some((row) => row.barCount > 0);
    if (!hasData) {
      errors.push('선택한 종목에 수집된 일봉이 없습니다 — 종목 마스터 수집을 먼저 실행하세요.');
      return null;
    }
```

`allowedTimeframes` 검사와 `sliceTimeframes`/`sliceForTimeframe` 호출을 전부 제거한다.

`refreshKrxDailyCoverage`(589행 근처)를 삭제한다 — 캐시가 없으니 갱신할 대상이 없다.

- [ ] **Step 6: container 에 서비스를 조립한다**

`src/server/bootstrap/container.ts` 에 추가한다:

```ts
  const candleCoverageService = new CandleCoverageService(database.db);
```

`AppContainer` 에 `readonly candleCoverageService: CandleCoverageService;` 를 더하고 반환 객체에 넣는다. 라우트 등록에서는 `BacktestRouteDeps` 의 필드명에 맞춘다:

```ts
  candleCoverage: candleCoverageService,
```

- [ ] **Step 7: 검증한다**

Run: `pnpm typecheck && pnpm vitest run tests/integration/backtest-universe-preview.test.ts tests/integration/backtest-universe-rule-run.test.ts`
Expected: PASS. 실패하면 슬라이스 인자를 넘기던 테스트 픽스처를 새 시그니처에 맞춘다.

- [ ] **Step 8: 커밋**

```bash
git add -A
git commit -m "refactor(backtests): 커버리지를 KRX 일봉에서 직접 구한다"
```

---

### Task 7: 1m 전용 테스트·픽스처 정리

1m 데이터셋을 전제한 통합 테스트가 남아 있으면 전부 빨간불이 된다. 삭제할 것과 일봉으로 고칠 것을 가른다.

**Files:**
- Delete: `tests/integration/backtest-minute-dataset.test.ts`
- Modify: `tests/unit/strategy-data-requirement.test.ts`
- Modify: `tests/integration/backtest-universe-rule-run.test.ts`, `tests/integration/market-data.test.ts`

웹 전용 테스트(`job-timeframe.test.ts`, `dataset-slices.test.ts`)는 Task 8 에서 다룬다.

- [ ] **Step 1: 1m 전용 통합 테스트를 지운다**

```bash
git rm tests/integration/backtest-minute-dataset.test.ts
```

- [ ] **Step 2: 남은 1m/1h 참조를 찾는다**

Run: `grep -rn "'1m'\|'1h'\|\"1m\"\|\"1h\"" tests --include=*.ts --include=*.tsx`

각 파일에서 판단한다 — 1m/1h 동작만 검증하는 케이스는 삭제하고, 일봉으로 바꿔도 뜻이 유지되는 케이스는 `'1d'` 로 고친다.

- [ ] **Step 3: 전체 테스트를 돌린다**

Run: `pnpm test`
Expected: 서버·공유 테스트는 전부 통과. `src/web` 관련 실패는 Task 8 에서 처리한다.

- [ ] **Step 4: 커밋**

```bash
git add -A
git commit -m "test: 분봉 전제 테스트를 걷어낸다"
```

---

### Task 8: 웹 가격 데이터 화면 제거

`/datasets/prices` 를 없앤다. `data-page.tsx` 는 종목 마스터만 담는 구획으로 줄어든다.

**Files:**
- Delete: `src/web/features/datasets/symbols-panel.tsx`, `symbol-list.tsx`, `symbol-check-list.tsx`, `symbol-select-scope.tsx`, `sync-dialog.tsx`, `candle-inspect-drawer.tsx`, `symbol-facts-badge.tsx`
- Modify: `src/web/app/router.tsx:31-40`
- Modify: `src/web/features/datasets/data-page.tsx`
- Modify: `src/web/features/datasets/dataset-slices.ts`
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx:22`
- Delete: `tests/unit/dataset-slices.test.ts`
- Modify: `tests/unit/job-timeframe.test.ts`, `tests/unit/prefill.test.ts`, `tests/unit/wizard-steps.test.ts`

**Interfaces:**
- Produces: `dataset-slices.ts` 는 `export const wizardTimeframes = ['1d'] as const;` 만 남긴다

- [ ] **Step 1: 삭제 대상이 다른 곳에서 쓰이지 않는지 확인한다**

Run: `grep -rn "symbols-panel\|symbol-list\|symbol-check-list\|symbol-select-scope\|sync-dialog\|candle-inspect-drawer\|symbol-facts-badge" src/web tests --include=*.ts --include=*.tsx`

`router.tsx` 외의 참조가 나오면 그 파일도 이 태스크 범위에 넣는다.

- [ ] **Step 2: 화면 파일을 지운다**

```bash
git rm src/web/features/datasets/symbols-panel.tsx \
       src/web/features/datasets/symbol-list.tsx \
       src/web/features/datasets/symbol-check-list.tsx \
       src/web/features/datasets/symbol-select-scope.tsx \
       src/web/features/datasets/sync-dialog.tsx \
       src/web/features/datasets/candle-inspect-drawer.tsx \
       src/web/features/datasets/symbol-facts-badge.tsx
```

- [ ] **Step 3: 라우트를 고친다**

`src/web/app/router.tsx` 에서 `import { SymbolsPanel } ...` 를 지우고 `{ path: 'prices', element: <SymbolsPanel /> }` 를 제거한다. `DatasetsIndexRedirect` 가 `prices` 로 보내고 있으면 `master` 로 바꾼다.

Run: `grep -n "prices\|master" src/web/features/datasets/data-page.tsx`

`data-page.tsx` 의 탭·링크에서 가격 데이터 항목을 제거한다.

- [ ] **Step 4: 위저드 timeframe 선택지를 줄인다**

`src/web/features/datasets/dataset-slices.ts` 를 아래로 교체한다:

```ts
/** 위저드가 고를 수 있는 봉 주기. KRX 일봉이 유일한 출처라 하나뿐이다. */
export const wizardTimeframes = ['1d'] as const;
```

`new-backtest-wizard.tsx` 에서 선택지가 하나면 선택 UI 를 감추거나 고정 표시로 바꾼다 — 고를 것이 없는 선택지를 보여 주면 사용자가 뭔가 놓쳤다고 오해한다.

- [ ] **Step 5: 웹 테스트를 정리한다**

```bash
git rm tests/unit/dataset-slices.test.ts
```

Run: `pnpm vitest run tests/unit/job-timeframe.test.ts tests/unit/prefill.test.ts tests/unit/wizard-steps.test.ts`

1m·1h 를 고른 상태를 검증하던 케이스를 삭제하고, 나머지는 `'1d'` 로 고친다. `job-timeframe.ts` 가 timeframe 별 표시를 분기한다면 분기 자체를 없애고 테스트도 그에 맞춘다.

- [ ] **Step 6: 검증한다**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: 전부 통과

Run: `pnpm build`
Expected: 성공

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "feat(web): 가격 데이터 화면을 걷어낸다"
```

---

### Task 9: e2e 정리와 최종 검증

**Files:**
- Modify: `tests/e2e/mvp-flow.spec.ts`, `tests/e2e/step-urls.spec.ts`
- Modify: `docs/DECISIONS.md`

- [ ] **Step 1: e2e 에서 가격 데이터 흐름을 걷어낸다**

Run: `grep -n "prices\|동기화\|가져오기\|가격 데이터" tests/e2e/*.ts`

가격 데이터 화면을 거치는 단계를 제거한다. 백테스트 흐름이 종목 마스터에서 시작하도록 고친다.

- [ ] **Step 2: e2e 를 돌린다**

Run: `pnpm test:e2e`
Expected: PASS

- [ ] **Step 3: 결정 기록을 남긴다**

`docs/DECISIONS.md` 끝에 추가한다:

```markdown
## D-032: 가격 데이터 기능 제거 — 봉은 KRX 일봉 하나로 좁힌다

- **변경 내용:** 가격 데이터 화면·CSV 가져오기·증권사 봉 수집을 제거하고, 백테스트가
  소비하는 봉을 `krx_daily_bars`(SQLite) 일봉으로 확정했다. `Timeframe` 은 `'1d'` 만
  남고 슬라이스 축(`DatasetSlice`)이 사라졌다.
- **이유:** 1m·1h 는 증권사만 주는데 증권사는 상장폐지 종목의 과거 봉을 주지 않는다.
  생존편향을 없앤 백테스트를 1m·1h 로는 만들 수 없으므로, 그 timeframe 을 남기면
  "일봉은 편향 없고 분봉은 편향 있는" 상태가 조용히 남는다.
- **가격 조회 기능을 뺀 이유:** 사람이 가격을 확인하는 일은 증권사 화면이 더 잘한다.
  이 애플리케이션에서 가격은 백테스트 전략의 입력이지 열람 대상이 아니다.
- **증권사 포트도 함께 제거:** `MarketDataSource` 의 소비자가 사라졌다. 매매 시스템은
  나중에 자기 형태의 포트를 새로 갖는다 — 지금 형태를 남기면 쓰이지 않는 채 낡는다.
- **영향:** `symbol_slices`·`symbol_coverage`·`data_sync_jobs` 가 쓰이지 않게 됐다.
  실제 스키마 정리와 parquet·DuckDB 제거는 후속 계획에서 한다.
```

- [ ] **Step 4: 전체 검증**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: 전부 통과

Run: `grep -rn "parquet-candle\|composite-candle\|BrokerSync\|MarketDataSource\|DatasetSlice\|aggregateToHourly" src tests --include=*.ts --include=*.tsx`
Expected: 결과 없음

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "docs(decisions): 가격 데이터 기능 제거 결정을 남긴다"
```

---

## Plan 2 로 넘기는 것

이 계획이 끝나면 아래가 남는다. 후속 계획이 다룬다.

1. `ParquetFactRepository` → SQLite 저장소 교체
2. `DuckDbService` 제거, `@duckdb/node-api` 의존성 제거, `config.duckdbThreads`/`duckdbMemoryLimit` 제거
3. 스키마 정리 — `symbol_slices`·`symbol_coverage`·`data_sync_jobs` 삭제, `symbol_versions.slice` 등 죽은 컬럼 제거
4. 마이그레이션 0000~0007 스쿼시 (D-015 의 "모든 기존 DB 를 버릴 수 있을 때만 가능" 조건을 만족한다)
5. `backup.sh` 에서 parquet 관련 잔재 정리
