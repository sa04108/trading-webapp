# 데이터셋 종목 그룹화 — 서버 단계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데이터셋을 종목 그룹으로 바꾼다 — `datasets.timeframe` 을 `defaultTimeframe` 으로 대체하고, 일봉/분봉을 슬라이스로 분리하며, 같은 종목 구성의 기존 1h·1d 데이터셋을 병합한다.

**Architecture:** 스펙 `docs/superpowers/specs/2026-07-30-dataset-symbol-group-design.md` 의 1단계(서버). Parquet 저장소는 이미 timeframe 파티션이라 무변경 — 메타데이터 계층(스키마·서비스·라우트)과 병합 마이그레이션만 바꾼다. 웹 호환을 위해 GET /datasets 응답에 기존 `timeframe` 필드를 **전환기 별칭**으로 유지한다 (2단계에서 제거).

**Tech Stack:** Fastify + Drizzle(SQLite) + DuckDB/Parquet, zod, vitest.

## Global Constraints

- 슬라이스 타입: `type DatasetSlice = '1d' | '1m'`. 분봉 슬라이스는 1m 수집 + 1h 집계 보관.
- `defaultTimeframe`: `'1d' | '1m'`. 기존 값 매핑: `'1h' → '1m'`, `'1d' → '1d'`, `'1m' → '1m'`.
- 종목 구성 유일키: `symbolsKey` = 정렬·중복 제거한 심볼을 `,` 로 이은 문자열. **애플리케이션 레벨 검사** (DB unique 아님 — 마이그레이션이 병합 못 하는 동종 중복 레거시를 허용해야 한다).
- 레거시 소비 폴백: `request.timeframe` 없는 저장된 요청은 `defaultTimeframe === '1m' ? '1h' : '1d'` 로 소비한다 (기존 "미지정 = 데이터셋 timeframe" 과 동일 결과).
- 전환기 별칭: `DatasetSummary.timeframe` = `defaultTimeframe === '1m' ? '1h' : '1d'` — 웹 2단계 전까지 유지.
- 에러 문구 한국어. 테스트 describe/it 한국어. 순수 헬퍼·테스트는 `@/` 별칭 금지, 상대 경로 + `.js`.
- 검증: `pnpm test && pnpm typecheck && pnpm lint`. 커밋: `type(scope): 한국어 서술형`.
- 참조 맵: datasets 스키마 `src/server/shared/db/schema.ts:61-70`, coverage `:87-103`, sync state `:139-154`. DatasetService `src/server/modules/market-data/application/dataset-service.ts`, BrokerSyncService `.../broker-sync-service.ts`, 라우트 `.../presentation/dataset-routes.ts`, Parquet 저장소 `.../infrastructure/parquet-candle-repository.ts`.

---

### Task 1: 슬라이스 도메인 헬퍼

**Files:**
- Create: `src/server/modules/market-data/domain/dataset-slice.ts`
- Test: `tests/unit/dataset-slice.test.ts`
- Modify: `src/server/modules/market-data/domain/candle.ts:21-27` (`availableTimeframes` 제거는 Task 5 에서 호출부 교체 후)

**Interfaces:**
- Consumes: `Timeframe` (`./candle.js`)
- Produces (이후 모든 태스크가 사용):
  - `type DatasetSlice = '1d' | '1m'`
  - `sliceTimeframes(slice: DatasetSlice): Timeframe[]` — `'1d' → ['1d']`, `'1m' → ['1m','1h']`
  - `collectTimeframeForSlice(slice: DatasetSlice): '1d' | '1m'` — 항등 (수집 봉 = 슬라이스 키)
  - `coverageTimeframeForSlice(slice: DatasetSlice): Timeframe` — `'1m' → '1h'` (시간봉 기준 커버리지가 기대 봉 수 계산 가능), `'1d' → '1d'`
  - `sliceForTimeframe(timeframe: Timeframe): DatasetSlice` — `'1d' → '1d'`, `'1m'|'1h' → '1m'`
  - `legacyConsumeDefault(defaultTimeframe: DatasetSlice): Timeframe` — `'1m' → '1h'`, `'1d' → '1d'`
  - `symbolsKey(symbols: readonly string[]): string` — 정렬·중복 제거 후 `,` join
  - `defaultTimeframeFromLegacy(timeframe: string): DatasetSlice` — `'1h' → '1m'`, 그 외 `'1d'|'1m'` 그대로

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/dataset-slice.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  collectTimeframeForSlice,
  coverageTimeframeForSlice,
  defaultTimeframeFromLegacy,
  legacyConsumeDefault,
  sliceForTimeframe,
  sliceTimeframes,
  symbolsKey,
} from '../../src/server/modules/market-data/domain/dataset-slice.js';

describe('sliceTimeframes', () => {
  it('일봉 슬라이스는 1d 만, 분봉 슬라이스는 1m 과 1h 집계를 담는다', () => {
    expect(sliceTimeframes('1d')).toEqual(['1d']);
    expect(sliceTimeframes('1m')).toEqual(['1m', '1h']);
  });
});

describe('collectTimeframeForSlice / coverageTimeframeForSlice', () => {
  it('수집 봉은 슬라이스 키와 같고, 커버리지 기준은 분봉 슬라이스만 1h 다', () => {
    expect(collectTimeframeForSlice('1d')).toBe('1d');
    expect(collectTimeframeForSlice('1m')).toBe('1m');
    expect(coverageTimeframeForSlice('1d')).toBe('1d');
    expect(coverageTimeframeForSlice('1m')).toBe('1h');
  });
});

describe('sliceForTimeframe', () => {
  it('1m 과 1h 는 분봉 슬라이스, 1d 는 일봉 슬라이스다', () => {
    expect(sliceForTimeframe('1m')).toBe('1m');
    expect(sliceForTimeframe('1h')).toBe('1m');
    expect(sliceForTimeframe('1d')).toBe('1d');
  });
});

describe('legacyConsumeDefault', () => {
  it('timeframe 없는 저장된 요청의 소비 봉 — 분봉 데이터셋은 1h(기존 동작), 일봉은 1d', () => {
    expect(legacyConsumeDefault('1m')).toBe('1h');
    expect(legacyConsumeDefault('1d')).toBe('1d');
  });
});

describe('symbolsKey', () => {
  it('순서·중복과 무관하게 같은 구성은 같은 키다', () => {
    expect(symbolsKey(['000660', '005930', '005930'])).toBe('000660,005930');
    expect(symbolsKey(['005930', '000660'])).toBe('000660,005930');
  });
});

describe('defaultTimeframeFromLegacy', () => {
  it('기존 1h 종류는 분봉 기본, 1d/1m 은 그대로다', () => {
    expect(defaultTimeframeFromLegacy('1h')).toBe('1m');
    expect(defaultTimeframeFromLegacy('1d')).toBe('1d');
    expect(defaultTimeframeFromLegacy('1m')).toBe('1m');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/unit/dataset-slice.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/server/modules/market-data/domain/dataset-slice.ts`:

```ts
import type { Timeframe } from './candle.js';

/**
 * 데이터셋 봉 슬라이스 (설계 2026-07-30-dataset-symbol-group-design.md §1).
 * 데이터셋 = 종목 그룹이고, 봉 데이터는 일봉('1d')과 분봉('1m') 두 슬라이스로
 * 나뉜다. 분봉 슬라이스는 1m 수집 + 1h 집계를 함께 보관한다 (기존 1h 종류의 실체).
 */
export type DatasetSlice = '1d' | '1m';

export const ALL_SLICES: readonly DatasetSlice[] = ['1d', '1m'];

/** 슬라이스가 보관하는 timeframe 목록 — 백테스트·검증 차트의 선택지 원천 */
export function sliceTimeframes(slice: DatasetSlice): Timeframe[] {
  return slice === '1m' ? ['1m', '1h'] : ['1d'];
}

/** 증권사에서 수집하는 봉 — 수집은 1m 또는 1d 뿐이다 */
export function collectTimeframeForSlice(slice: DatasetSlice): '1d' | '1m' {
  return slice;
}

/**
 * 커버리지 계산 기준 봉. 분봉 슬라이스는 1h 기준 — 시간봉 커버리지만 세션에서
 * 기대 봉 수를 계산할 수 있다 (domain/coverage.ts 의 computeHourlyCoverage).
 */
export function coverageTimeframeForSlice(slice: DatasetSlice): Timeframe {
  return slice === '1m' ? '1h' : '1d';
}

/** 소비 봉이 속한 슬라이스 — 백테스트 검증이 어느 슬라이스 커버리지를 볼지 결정 */
export function sliceForTimeframe(timeframe: Timeframe): DatasetSlice {
  return timeframe === '1d' ? '1d' : '1m';
}

/**
 * timeframe 없는 저장된 백테스트 요청의 소비 봉. 이 필드가 없던 시절 엔진은
 * 데이터셋 timeframe(분봉 데이터셋 = '1h')을 썼다 — 같은 결과를 유지한다.
 */
export function legacyConsumeDefault(defaultTimeframe: DatasetSlice): Timeframe {
  return defaultTimeframe === '1m' ? '1h' : '1d';
}

/** 종목 구성 유일키 — 정렬·중복 제거. 구성이 같으면 순서와 무관하게 같은 키다 */
export function symbolsKey(symbols: readonly string[]): string {
  return [...new Set(symbols)].sort().join(',');
}

/** 기존 datasets.timeframe 값을 defaultTimeframe 으로 매핑 (마이그레이션·전환기) */
export function defaultTimeframeFromLegacy(timeframe: string): DatasetSlice {
  return timeframe === '1d' ? '1d' : '1m';
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/unit/dataset-slice.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/domain/dataset-slice.ts tests/unit/dataset-slice.test.ts
git commit -m "feat(market-data): 데이터셋 봉 슬라이스 도메인을 정의한다"
```

---

### Task 2: 스키마 변경 + DDL/데이터 백필 마이그레이션

**Files:**
- Modify: `src/server/shared/db/schema.ts:61-70` (datasets), `:87-103` (dataCoverage), `:139-154` (brokerSyncState)
- Create: `migrations/0004_*.sql` (drizzle-kit generate 후 데이터 백필 SQL 을 손으로 추가)
- Test: `tests/integration/dataset-slice-schema.test.ts`

**Interfaces:**
- Produces: `datasets.defaultTimeframe`(text), `datasets.symbolsKey`(text), `dataCoverage.slice`(text), `brokerSyncState.slice`(text), 인덱스 `(datasetId, symbol, slice)`. 기존 `datasets.timeframe` 컬럼은 **유지한 채 사용 중단** — SQLite 컬럼 드롭은 테이블 재생성이라 위험 대비 이득이 없다. 코드가 더 이상 읽지 않는 것으로 충분하다.

- [ ] **Step 1: 스키마 수정**

`schema.ts` datasets 테이블에 추가 (기존 `timeframe` 줄 아래):

```ts
  /** @deprecated 슬라이스 모델 전환으로 사용 중단 — defaultTimeframe 을 쓴다 */
  timeframe: text('timeframe').notNull(),
  /** 기본 봉 ('1d'|'1m') — 생성 드로어의 수집 봉 선택. 카드 스위치 기본값 */
  defaultTimeframe: text('default_timeframe').notNull().default('1d'),
  /** 종목 구성 유일키 (정렬·중복 제거, ',' join) — 애플리케이션 레벨 중복 검사용 */
  symbolsKey: text('symbols_key').notNull().default(''),
```

`dataCoverage` 에 추가 + 인덱스 교체:

```ts
    /** 봉 슬라이스 ('1d'|'1m') — 슬라이스별 커버리지 */
    slice: text('slice').notNull().default('1d'),
```

인덱스: `index('idx_data_coverage_dataset_symbol').on(table.datasetId, table.symbol)` → `index('idx_data_coverage_dataset_symbol_slice').on(table.datasetId, table.symbol, table.slice)` (기존 인덱스 정의 교체 — drizzle 가 DROP/CREATE 를 생성한다).

`brokerSyncState` 에 추가 + 유니크 인덱스 교체:

```ts
    /** 봉 슬라이스 ('1d'|'1m') — 슬라이스별 수집 워터마크 */
    slice: text('slice').notNull().default('1d'),
```

유니크 인덱스: `(datasetId, symbol)` → `(datasetId, symbol, slice)`.

- [ ] **Step 2: 마이그레이션 생성 + 데이터 백필 SQL 추가**

Run: `pnpm db:generate`

생성된 `migrations/0004_*.sql` 끝에 데이터 백필을 손으로 추가한다 (이 리포 첫 데이터 마이그레이션 — DDL 뒤에 UPDATE 를 두는 것으로 충분하다):

```sql
--> statement-breakpoint
UPDATE `datasets` SET `default_timeframe` = CASE `timeframe` WHEN '1d' THEN '1d' ELSE '1m' END;
--> statement-breakpoint
UPDATE `data_coverage` SET `slice` = (
  SELECT CASE d.`timeframe` WHEN '1d' THEN '1d' ELSE '1m' END FROM `datasets` d WHERE d.`id` = `data_coverage`.`dataset_id`
);
--> statement-breakpoint
UPDATE `broker_sync_state` SET `slice` = (
  SELECT CASE d.`timeframe` WHEN '1d' THEN '1d' ELSE '1m' END FROM `datasets` d WHERE d.`id` = `broker_sync_state`.`dataset_id`
);
```

`symbols_key` 백필은 SQL 로 못 한다 (JSON 정렬) — Task 7 의 부트 마이그레이션이 채운다. 그 전까지 빈 문자열은 "미계산" 을 뜻한다.

- [ ] **Step 3: 실패하는 테스트 작성**

`tests/integration/dataset-slice-schema.test.ts` — 기존 통합 테스트의 DB 셋업 관례를 따른다 (`tests/integration/backtest-facts.test.ts` 상단의 임시 DATABASE_PATH + openDatabase 패턴을 그대로 복사):

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../../src/server/shared/db/database.js';
import { brokerSyncState, dataCoverage, datasets } from '../../src/server/shared/db/schema.js';

let dir: string;
let db: AppDatabase;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'slice-schema-'));
  db = openDatabase(join(dir, 'test.sqlite'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('슬라이스 스키마', () => {
  it('datasets 에 defaultTimeframe·symbolsKey, coverage·sync_state 에 slice 가 있다', () => {
    db.insert(datasets)
      .values({
        id: 'ds_t', name: 't', market: 'KR', timeframe: '1h',
        defaultTimeframe: '1m', symbolsKey: '005930',
        symbolsJson: '["005930"]', createdAtMs: 1, updatedAtMs: 1,
      })
      .run();
    db.insert(dataCoverage)
      .values({ datasetId: 'ds_t', symbol: '005930', slice: '1m', barCount: 0, computedAtMs: 1 })
      .run();
    db.insert(brokerSyncState).values({ datasetId: 'ds_t', symbol: '005930', slice: '1m' }).run();

    expect(db.select().from(datasets).all()[0]?.defaultTimeframe).toBe('1m');
    expect(db.select().from(dataCoverage).all()[0]?.slice).toBe('1m');
    expect(db.select().from(brokerSyncState).all()[0]?.slice).toBe('1m');
  });

  it('sync_state 는 같은 (dataset, symbol) 에 슬라이스가 다르면 공존한다', () => {
    db.insert(brokerSyncState).values({ datasetId: 'ds_t', symbol: '005930', slice: '1d' }).run();
    expect(db.select().from(brokerSyncState).all()).toHaveLength(2);
  });
});
```

(openDatabase 시그니처가 다르면 기존 통합 테스트의 실제 호출 형태를 그대로 따른다 — 계약은 "마이그레이션 적용된 임시 DB".)

- [ ] **Step 4: 실패 확인 → 스키마 반영 확인**

Run: `pnpm exec vitest run tests/integration/dataset-slice-schema.test.ts`
Expected: 스키마 수정 전 FAIL(컬럼 없음) → Step 1·2 후 PASS.

- [ ] **Step 5: 전체 검증 후 커밋**

Run: `pnpm test && pnpm typecheck`

```bash
git add src/server/shared/db/schema.ts migrations tests/integration/dataset-slice-schema.test.ts
git commit -m "feat(db): 데이터셋 슬라이스 컬럼과 백필 마이그레이션을 추가한다"
```

---

### Task 3: DatasetService — 슬라이스 인지 + 종목 구성 유일성

**Files:**
- Modify: `src/server/modules/market-data/application/dataset-service.ts`
- Test: `tests/integration/dataset-service-slices.test.ts` (기존 dataset-service 테스트가 있으면 그 파일에 추가)

**Interfaces:**
- Consumes: Task 1 헬퍼, Task 2 스키마.
- Produces (라우트·웹·동기화가 사용):
  - `DatasetSummary` 에 추가: `defaultTimeframe: DatasetSlice`, `slices: Array<{ slice: DatasetSlice; hasData: boolean }>`. 기존 `timeframe` 필드는 `legacyConsumeDefault(defaultTimeframe)` 값으로 유지 (전환기 별칭 — 주석 명시).
  - `createBrokerDataset(name, market, collect: '1m'|'1d', symbols)` — `defaultTimeframe = collect`, `symbolsKey` 저장, **구성 중복이면 `DuplicateSymbolGroupError` throw** (메시지: `같은 종목 구성의 데이터셋이 이미 있습니다: ${기존 이름}`).
  - `updateSymbols` — 변경 후 구성이 다른 데이터셋과 겹치면 같은 에러. `symbolsKey` 갱신.
  - `importCsv(request)` — `request.timeframe: '1m' | '1d'` 로 변경 (1h 제거). `ensureDataset` 은 `defaultTimeframe = request.timeframe`, 하드코딩 `timeframe: '1h'` 제거(레거시 컬럼엔 호환 값 기록). 1m 이면 지금처럼 1h 집계 병행.
  - `refreshCoverage(datasetId, market, slice: DatasetSlice)` — 시그니처의 timeframe 을 slice 로 교체. 내부는 `coverageTimeframeForSlice(slice)` 기준으로 계산하고 **해당 슬라이스 행만** delete+insert.
  - `getCandlesForInspection` — 허용 timeframe = `sliceTimeframes` 합집합 중 실제 캔들 있는 것. 커버리지 음영은 `coverageTimeframeForSlice(sliceForTimeframe(timeframe)) === timeframe` 일 때.
  - `hasData(slice)` 판정: 해당 슬라이스 coverage 행의 `barCount > 0` 존재 여부.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/integration/dataset-service-slices.test.ts` — 기존 통합 테스트의 컨테이너/서비스 셋업 관례를 재사용해 다음 행동을 단언:

```ts
describe('종목 구성 유일성', () => {
  it('같은 구성(순서 무관)의 데이터셋 생성을 거부한다', async () => {
    await service.createBrokerDataset('a', 'KR', '1d', ['005930', '000660']);
    await expect(
      service.createBrokerDataset('b', 'KR', '1m', ['000660', '005930']),
    ).rejects.toThrow('같은 종목 구성의 데이터셋이 이미 있습니다: a');
  });

  it('종목 편집으로 다른 데이터셋과 구성이 같아지면 거부한다', async () => {
    await service.createBrokerDataset('c', 'KR', '1d', ['005930']);
    const d = await service.createBrokerDataset('d', 'KR', '1d', ['005930', '035420']);
    await expect(
      service.updateSymbols(d.id, { remove: ['035420'] }),
    ).rejects.toThrow('같은 종목 구성의 데이터셋이 이미 있습니다: c');
  });
});

describe('슬라이스 요약', () => {
  it('생성 직후 두 슬라이스 모두 hasData=false, defaultTimeframe 은 수집 봉이다', async () => {
    const ds = await service.createBrokerDataset('e', 'KR', '1m', ['005930']);
    expect(ds.defaultTimeframe).toBe('1m');
    expect(ds.slices).toEqual([
      { slice: '1d', hasData: false },
      { slice: '1m', hasData: false },
    ]);
    // 전환기 별칭: 분봉 기본 데이터셋은 기존 웹이 '1h' 로 읽는다
    expect(ds.timeframe).toBe('1h');
  });
});

describe('CSV 가져오기 슬라이스', () => {
  it('1d CSV 는 일봉 슬라이스를 채우고 coverage 도 1d 슬라이스에 기록된다', async () => {
    // 기존 importCsv 테스트 픽스처의 CSV 문자열 관례 재사용, timeframe: '1d'
    // 단언: coverage 행 slice === '1d', summary.slices 의 1d.hasData === true
  });
});
```

(마지막 케이스는 기존 CSV 픽스처를 그대로 옮겨 완성한다 — 구현자는 `tests/integration/backtest-daily-dataset.test.ts` 의 CSV 상수를 복사해 쓸 것. 단언은 주석의 두 줄이 전부다.)

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/integration/dataset-service-slices.test.ts`
Expected: FAIL — DuplicateSymbolGroupError 없음, slices 필드 없음.

- [ ] **Step 3: 구현**

`dataset-service.ts` 핵심 변경 (참조 라인은 현재 기준):

1. import 에 Task 1 헬퍼 추가. `export class DuplicateSymbolGroupError extends Error` 정의 (기존 커스텀 에러 관례를 따름).
2. `DatasetSummary` (`:28-39`): `timeframe` 주석을 전환기 별칭으로 바꾸고 `defaultTimeframe`·`slices` 추가.
3. `toSummary` (`:110`): coverage 를 슬라이스별로 집계해 `slices` 구성. `timeframe: legacyConsumeDefault(row.defaultTimeframe)`.
   - N+1 방지: `listDatasets` 는 coverage 를 datasetId IN (...) 한 번에 읽어 Map 으로 넘긴다.
4. `createBrokerDataset` (`:182-199`): `collect` 를 그대로 `defaultTimeframe` 에 저장 (기존 `'1m'→'1h'` 매핑 제거). `symbolsKey(symbols)` 계산·저장. insert 전에 `findBySymbolsKey` — 있으면 throw. 레거시 `timeframe` 컬럼엔 `legacyConsumeDefault(collect)` 기록 (스키마 notNull 유지용).
5. `updateSymbols` (`:396` 부근): 새 구성의 key 계산 → 자신 제외 중복 검사 → `symbolsKey` 갱신.
6. `importCsv` (`:221-310`): `ImportRequest.timeframe: '1m' | '1d'`. `'1d'` 면 집계 없이 저장. `refreshCoverage(dataset.id, market, sliceForTimeframe(request.timeframe))`.
7. `ensureDataset` (`:330-363`): 새 데이터셋 `defaultTimeframe = request.timeframe === '1d' ? '1d' : '1m'`, `symbolsKey` 계산, 하드코딩 `'1h'` 제거. 기존 데이터셋에 심볼 추가 시에도 중복 구성 검사 + key 갱신.
8. `refreshCoverage(datasetId, market, slice)` (`:543-576`): `coverageTimeframeForSlice(slice)` 로 timestamps 조회, delete 조건에 `eq(dataCoverage.slice, slice)` 추가, insert 에 `slice` 포함.
9. `getCandlesForInspection` (`:475-498`): `availableTimeframes(dataset.timeframe)` → 요청 timeframe 의 슬라이스에 캔들이 있는지로 검증 (`getTimestamps` 존재 확인 또는 coverage hasData). 커버리지 음영 조건을 위 Interfaces 정의대로.

- [ ] **Step 4: 통과 확인 + 기존 테스트 보수**

Run: `pnpm exec vitest run tests/integration/dataset-service-slices.test.ts` → PASS
Run: `pnpm test` — 깨지는 기존 테스트(`broker-sync-service.test.ts`, `backtest-*-dataset.test.ts`, `candle-sync-estimate.test.ts` 의 dataset 픽스처)를 새 컬럼(`defaultTimeframe`·`symbolsKey`)에 맞게 고친다. 의미 변화 없는 픽스처 보수만 — 단언 약화 금지.

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data tests
git commit -m "feat(market-data): 데이터셋 서비스가 슬라이스와 종목 구성 유일성을 안다"
```

---

### Task 4: BrokerSyncService — 슬라이스별 동기화

**Files:**
- Modify: `src/server/modules/market-data/application/broker-sync-service.ts`
- Test: `tests/unit/broker-sync-service.test.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: Task 1·3.
- Produces: `startSync(datasetId, options: { slice?: DatasetSlice; includeFacts?: boolean })` — `slice` 기본값 = `dataset.defaultTimeframe`. `collectTimeframe(dataset.timeframe)` 메서드 제거, `collectTimeframeForSlice(slice)` 사용. `SyncUnsupportedDatasetError` 는 더 이상 timeframe 으로 던지지 않는다 (모든 데이터셋이 두 슬라이스 동기화 가능).
  - 워터마크: `getState`/`widenWatermark`/`markBackfillDone` 전부 `(datasetId, symbol, slice)` 스코프.
  - `reaggregateHourly` 는 `slice === '1m'` 일 때만.
  - 완료 후 `refreshCoverage(dataset.id, dataset.market, slice)`.
  - 버전 시드는 기존 `broker:${collect}:...` 형태 유지 (collect 가 이미 슬라이스를 담는다).
  - 동시 실행 가드: 데이터셋 단위 유지 (슬라이스 달라도 동시 불가 — 단순함 우선, 주석으로 명시).

- [ ] **Step 1: 실패하는 테스트 작성**

기존 `tests/unit/broker-sync-service.test.ts` 의 페이크 소스·서비스 셋업을 재사용해 추가:

```ts
describe('슬라이스별 동기화', () => {
  it('slice 를 주면 그 봉을 수집한다 — 일봉 기본 데이터셋에서 분봉 동기화', async () => {
    // defaultTimeframe '1d' 데이터셋 생성 픽스처
    const { done } = service.startSync(datasetId, { slice: '1m' });
    await done;
    // 페이크 소스가 받은 fetch 요청의 timeframe 이 '1m' 인지 단언
    // 저장 후 brokerSyncState 에 slice='1m' 행이 생기고 '1d' 행은 없는지 단언
  });

  it('slice 생략 시 defaultTimeframe 을 따른다', async () => {
    const { done } = service.startSync(datasetId, {});
    await done;
    // fetch timeframe === '1d' 단언
  });

  it('같은 (dataset, symbol) 의 1d·1m 워터마크가 서로를 침범하지 않는다', async () => {
    // 1d 동기화 후 1m 동기화 — 각 slice 행의 syncedLastTsMs 가 독립인지 단언
  });
});
```

(픽스처 세부는 기존 파일 관례를 그대로 — 페이크 `MarketDataSource.fetchCandles` 가 요청을 기록한다. 단언 대상은 주석 그대로.)

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/unit/broker-sync-service.test.ts`
Expected: 새 테스트 FAIL (startSync 옵션에 slice 없음).

- [ ] **Step 3: 구현**

`broker-sync-service.ts`:
- `startSync(datasetId, options: { slice?: DatasetSlice; includeFacts?: boolean } = {})` (`:146-`): `const slice = options.slice ?? dataset.defaultTimeframe;` `const collect = collectTimeframeForSlice(slice);` — `collectTimeframe` 메서드(`:222-226`)와 `SyncUnsupportedDatasetError` 의 timeframe 분기 삭제.
- `getState`/`widenWatermark`/`markBackfillDone` (`:532-574`): where 절과 insert 에 `slice` 추가. `run()` 내부에서 slice 를 인자로 전달.
- `reaggregateHourly` 호출부: `if (slice === '1m')` 가드.
- `:279` `refreshCoverage(dataset.id, dataset.market, slice)`.

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/unit/broker-sync-service.test.ts` → 전부 PASS
Run: `pnpm test && pnpm typecheck`

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/broker-sync-service.ts tests/unit/broker-sync-service.test.ts
git commit -m "feat(market-data): 동기화가 슬라이스 단위로 수집한다"
```

---

### Task 5: 라우트 계약 — collect·slice·CSV 1d

**Files:**
- Modify: `src/server/modules/market-data/presentation/dataset-routes.ts` (`createDatasetSchema:26-32`, `importFieldsSchema:19-24`, sync 라우트)
- Modify: `src/server/modules/market-data/domain/candle.ts:21-27` — `availableTimeframes` 삭제 (호출부가 전부 교체된 뒤)
- Test: 기존 라우트 통합 테스트 파일에 추가 (`tests/integration/` 의 datasets 라우트를 다루는 파일, 없으면 `dataset-service-slices.test.ts` 에 inject 케이스 추가)

**Interfaces:**
- `POST /datasets` body: `collect: z.enum(['1m','1d'])` (변화 없음 — 의미만 defaultTimeframe 로). 중복 구성이면 409 + 서비스 에러 메시지.
- `POST /datasets/sync` body 에 `slice: z.enum(['1m','1d']).optional()` 추가 → `startSync(datasetId, { slice, includeFacts })`.
- `POST /datasets/import` fields: `timeframe: z.enum(['1m','1d'])` (1h 제거).
- GET 응답은 Task 3 의 `DatasetSummary` 가 그대로 직렬화 (defaultTimeframe·slices·전환기 timeframe).

- [ ] **Step 1: 실패하는 테스트 작성** — inject 로: ① `POST /datasets` 중복 구성 409, ② `POST /datasets/sync` 에 `slice:'1m'` 전달 시 분봉 수집(페이크 소스 요청 기록으로 단언), ③ `POST /datasets/import` 에 `timeframe:'1h'` 가 400, `'1d'` 가 성공. 기존 라우트 테스트의 앱 셋업 관례 재사용.

- [ ] **Step 2: 실패 확인** — 해당 테스트 파일만 vitest run, FAIL 확인.

- [ ] **Step 3: 구현** — 스키마 zod 수정, sync 핸들러에 slice 전달, POST /datasets 핸들러에서 `DuplicateSymbolGroupError` → 409. `availableTimeframes` 의 남은 호출부가 없음을 grep 으로 확인 후 함수와 주석(candle.ts:21-27) 삭제.

- [ ] **Step 4: 통과 확인** — `pnpm test && pnpm typecheck && pnpm lint`

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data tests
git commit -m "feat(market-data): 데이터셋 라우트가 슬라이스 계약을 쓴다"
```

---

### Task 6: 백테스트 제출 검증·워커 — 슬라이스 커버리지

**Files:**
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts:104-196`
- Modify: `src/workers/backtest-child.ts:97-142`
- Test: `tests/integration/backtest-daily-dataset.test.ts`·`backtest-minute-dataset.test.ts` (기존 케이스가 새 모델에서 그대로 통과해야 한다 — 픽스처만 보수)

**Interfaces:**
- 제출 검증: `consumed = body.timeframe ?? legacyConsumeDefault(dataset.defaultTimeframe)`. 허용 검사 = `sliceTimeframes(sliceForTimeframe(consumed))` 에 consumed 포함 + 해당 슬라이스 hasData. 커버리지·bar 추정은 `sliceForTimeframe(consumed)` 슬라이스의 coverage 행으로, multiplier = `consumed === '1m' ? 60 : 1`.
- 워커: `timeframe = request.timeframe ?? legacyConsumeDefault(dataset.defaultTimeframe)` — 캔들 파티션 선택은 기존 그대로.

- [ ] **Step 1: 기존 통합 테스트 실행으로 현재 상태 파악** — Task 3~5 후 깨져 있는 케이스 목록 확보.
- [ ] **Step 2: 구현** — 위 Interfaces 대로. coverage 조회에 slice 필터 추가 (`checkPeriodCoverage`·`estimateBars` 입력).
- [ ] **Step 3: 통과 확인** — `pnpm exec vitest run tests/integration/backtest-daily-dataset.test.ts tests/integration/backtest-minute-dataset.test.ts` 전부 PASS, 이어서 `pnpm test`.
- [ ] **Step 4: 커밋**

```bash
git add src/server/modules/backtest src/workers tests
git commit -m "feat(backtest): 제출 검증과 워커가 슬라이스 커버리지를 본다"
```

---

### Task 7: 부트 병합 마이그레이션

**Files:**
- Create: `src/server/modules/market-data/application/dataset-merge-migration.ts`
- Modify: 서버 부트스트랩 (`src/server/bootstrap/main.ts` — openDatabase 직후, 서비스 기동 전 호출)
- Test: `tests/integration/dataset-merge-migration.test.ts`

**Interfaces:**
- `runDatasetMergeMigration(deps: { db: AppDatabase; candleRepository: CandleRepository; dataDir: string; clock: Clock; logger: Logger }): Promise<void>`
- 동작 (모두 멱등 — `symbolsKey === ''` 인 행이 남아 있을 때만 일한다):
  1. 모든 데이터셋의 `symbolsKey` 를 `symbolsJson` 에서 계산해 채운다.
  2. 같은 `(market, symbolsKey)` 에 **일봉 슬라이스만 가진 것(구 1d)** 과 **분봉 슬라이스만 가진 것(구 1h/1m)** 이 정확히 하나씩이면 병합:
     - 생존자 = `createdAtMs` 가 빠른 쪽. 피병합자의 Parquet 디렉터리 `dataset=<loser>/market=*/timeframe=*` 를 `dataset=<survivor>/` 아래로 이동 (timeframe 파티션이 슬라이스별로 서로소라 충돌 없음 — 충돌 발견 시 그 쌍은 건너뛰고 경고 로그).
     - `data_coverage`·`broker_sync_state` 의 loser 행 `datasetId` 를 survivor 로 UPDATE.
     - `backtest_jobs` 등 `datasetId` 참조 테이블에서 loser → survivor UPDATE (참조 테이블은 schema.ts 에서 `datasetId` 컬럼 grep 으로 전수 확인).
     - survivor 버전 = `max(두 최신 버전) + 1` 로 bump (시드 `merge:${loserId}`), `defaultTimeframe` = 생존자(먼저 만든 쪽) 것 유지.
     - loser 행 삭제 (FK cascade 주의 — 참조를 먼저 옮겼으므로 datasets 행만 지워진다).
  3. 같은 종류 중복(병합 불가)은 경고 로그만 남기고 둘 다 유지.

- [ ] **Step 1: 실패하는 테스트 작성** — 임시 디렉터리에 구모델 데이터셋 2개(같은 구성, 1h 종류 + 1d 종류)와 가짜 Parquet 파일, coverage·sync_state·backtest_jobs 참조 행을 심고 실행 → 단언: 데이터셋 1개, Parquet 디렉터리 병합, 참조 재매핑, 버전 = max+1, 두 번 실행해도 결과 동일(멱등). 같은 종류 중복 케이스는 병합되지 않고 유지.
- [ ] **Step 2: 실패 확인** — 모듈 없음 FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces 대로. 파일 이동은 `fs.renameSync`, 디렉터리 생성은 `mkdirSync(recursive)`. 트랜잭션: DB 변경은 하나의 트랜잭션, 파일 이동은 그 **앞**에 (파일 이동 실패 시 DB 는 건드리지 않은 상태로 중단 — 재실행 가능).
- [ ] **Step 4: 부트스트랩 연결** — main.ts 에서 서비스 기동 전 await. e2e-server.ts 도 같은 경로를 타는지 확인 (openDatabase 공유 시 자동).
- [ ] **Step 5: 통과 확인** — 해당 테스트 + `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 6: 커밋**

```bash
git add src/server tests/integration/dataset-merge-migration.test.ts
git commit -m "feat(market-data): 같은 종목 구성의 데이터셋을 부트에서 병합한다"
```

---

### Task 8: 픽스처·E2E 정합 + 최종 검증

**Files:**
- Modify: `scripts/e2e-server.ts:77` (importCsv timeframe `'1h'` → `'1m'` — 1m CSV 픽스처가 필요하면 기존 CSV 를 1m 봉으로 교체, 아니면 기존 1h CSV 를 1m 으로 재생성)
- Modify: 남은 테스트 픽스처 전부

- [ ] **Step 1: e2e 픽스처 갱신** — e2e-server 가 새 모델로 기동되고 mvp-flow 가 통과하도록. CSV 픽스처가 1h 봉이면 1m 봉 CSV 로 바꾸거나, 픽스처 생성 코드가 1m 을 만들도록 수정.
- [ ] **Step 2: 전체 검증**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm test:e2e`
Expected: 전부 PASS.

- [ ] **Step 3: 커밋**

```bash
git add scripts tests
git commit -m "test(e2e): 데이터셋 슬라이스 모델에 픽스처를 맞춘다"
```
