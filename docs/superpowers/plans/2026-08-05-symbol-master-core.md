# 종목 마스터 코어 (서버) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 체크포인트+delta 구조의 point-in-time 종목 마스터를 서버에 구축한다 — 스키마, diff/재구성 도메인, KRX ingest, 백필, 스케줄러, API.

**Architecture:** 순수 도메인(diff·apply)과 DB 서비스(`SymbolMasterService`)를 분리한다. 수집 경로 3개(백필·일일·온디맨드)가 `ingestDate` 하나를 공유한다. 분기 경계 첫 거래일에 체크포인트를 저장하며 재구성 결과를 KRX 실측과 대조해 검증한다.

**Tech Stack:** Fastify, Drizzle ORM (better-sqlite3), zod, vitest. 기존 `KrxHistoricalUniverseSource`·`krx-fixtures` fake 서버 재사용.

**연관 문서:** `docs/superpowers/specs/2026-08-05-symbol-master-design.md` (스펙). 후속 계획: `2026-08-05-symbol-master-ui.md`, `2026-08-05-symbol-master-backtest.md`.

## Global Constraints

- 한국어 주석·문서는 CLAUDE.md 규칙(문어체 평서형, 번역투 금지, 왜를 쓴다)을 따른다.
- 테스트: `pnpm test` (vitest). 단위 `tests/unit/`, 통합 `tests/integration/`.
- 린트·타입: `pnpm lint`, `pnpm typecheck` — 커밋 전 통과 필수.
- 마이그레이션: `pnpm drizzle-kit generate` (drizzle.config.ts, dialect sqlite). 마이그레이션 파일은 `migrations/`.
- 날짜는 ISO `YYYY-MM-DD` 문자열, 타임스탬프는 `*_at_ms` integer — 기존 스키마 관례.
- 상장주식수·시가총액은 10진 정수 문자열(bigint 보존) — `parseNullableInt64` 선례.
- 커밋 메시지는 기존 관례(`feat(scope): …한다`)를 따른다.
- 이 계획에서는 기존 datasets/universeSnapshots 테이블·서비스를 건드리지 않는다 — 제거는 backtest 계획에서 한다.

---

### Task 1: 스키마 + 마이그레이션

**Files:**
- Modify: `src/server/shared/db/schema.ts` (파일 끝에 추가)
- Create: `migrations/0004_symbol_master.sql` (drizzle-kit 생성)
- Test: `tests/unit/symbol-master-schema.test.ts`

**Interfaces:**
- Produces: 테이블 5개 — `symbolMasterCheckpoints`, `symbolMasterCheckpointSymbols`, `symbolMasterEvents`, `symbolMasterCoverage`, `symbolMasterMarketCaps`. 이후 모든 태스크가 참조한다.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/unit/symbol-master-schema.test.ts
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import {
  symbolMasterCheckpoints,
  symbolMasterCheckpointSymbols,
  symbolMasterCoverage,
  symbolMasterEvents,
  symbolMasterMarketCaps,
} from '../../src/server/shared/db/schema.js';

describe('symbol master 스키마', () => {
  it('테이블 5개에 삽입·조회가 왕복한다', async () => {
    const t = await createTestApp();
    const db = t.container.db;
    db.insert(symbolMasterCheckpoints).values({
      id: 'cp1', checkpointDate: '2023-01-02', source: 'KRX', createdAtMs: 1,
    }).run();
    db.insert(symbolMasterCheckpointSymbols).values({
      checkpointId: 'cp1', standardCode: 'KR7005930003', shortCode: '005930',
      name: '삼성전자', market: 'KOSPI', sharesOutstanding: '5969782550',
      instrumentType: 'COMMON_STOCK', listedDate: '1975-06-11',
    }).run();
    db.insert(symbolMasterEvents).values({
      effectiveDate: '2023-01-03', standardCode: 'KR7005930003',
      eventType: 'SHARES_CHANGED', oldValue: '"5969782550"', newValue: '"5919637922"',
      observedSpanStart: '2023-01-02', createdAtMs: 2,
    }).run();
    db.insert(symbolMasterCoverage).values({
      startDate: '2023-01-02', endDate: '2023-01-03', syncedAtMs: 3,
    }).run();
    db.insert(symbolMasterMarketCaps).values({
      date: '2023-01-03', standardCode: 'KR7005930003', marketCapKrw: '350000000000000',
    }).run();

    expect(db.select().from(symbolMasterCheckpointSymbols).all()).toHaveLength(1);
    expect(db.select().from(symbolMasterEvents).all()).toHaveLength(1);
    await t.close();
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `pnpm vitest run tests/unit/symbol-master-schema.test.ts`
Expected: FAIL — `symbolMasterCheckpoints` export 없음.

- [ ] **Step 3: 스키마 추가**

`src/server/shared/db/schema.ts` 끝에:

```typescript
// ── 종목 마스터 (설계 2026-08-05-symbol-master) ──────────────────────

/**
 * 분기 경계 첫 거래일의 전체 스냅샷. 재구성 시작점이자 검증 앵커다.
 * mismatchJson 이 null 이 아니면 이벤트 재구성과 KRX 실측이 어긋났던 기록이다.
 */
export const symbolMasterCheckpoints = sqliteTable('symbol_master_checkpoints', {
  id: text('id').primaryKey(),
  checkpointDate: text('checkpoint_date').notNull().unique(),
  source: text('source').notNull(), // KRX
  verifiedAtMs: integer('verified_at_ms'),
  mismatchJson: text('mismatch_json'),
  createdAtMs: integer('created_at_ms').notNull(),
});

/** symbols 에 FK 를 걸지 않는다 — 마스터는 미등록·폐지 종목도 담는다 */
export const symbolMasterCheckpointSymbols = sqliteTable(
  'symbol_master_checkpoint_symbols',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    checkpointId: text('checkpoint_id')
      .notNull()
      .references(() => symbolMasterCheckpoints.id, { onDelete: 'cascade' }),
    standardCode: text('standard_code').notNull(),
    shortCode: text('short_code').notNull(),
    name: text('name').notNull(),
    market: text('market').notNull(), // KOSPI | KOSDAQ
    /** 10진 정수 문자열 — bigint 를 그대로 보존한다 */
    sharesOutstanding: text('shares_outstanding').notNull(),
    /** COMMON_STOCK 또는 KrxExclusionReason — 필터 정책은 읽기 시점에 적용한다 */
    instrumentType: text('instrument_type').notNull(),
    listedDate: text('listed_date'),
  },
  (table) => [
    uniqueIndex('idx_smcs_checkpoint_code').on(table.checkpointId, table.standardCode),
  ],
);

/**
 * 변경 이벤트(delta). old/newValue 는 절대값 JSON 이라 중복 적용해도 결과가 같다.
 * observedSpanStart: diff 기준일 — 갭을 건너뛴 수집이면 이벤트 날짜가 근사값이다.
 */
export const symbolMasterEvents = sqliteTable(
  'symbol_master_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    effectiveDate: text('effective_date').notNull(),
    standardCode: text('standard_code').notNull(),
    // LISTED | DELISTED | MARKET_MOVED | SHARES_CHANGED | NAME_CHANGED | TYPE_CHANGED
    eventType: text('event_type').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    observedSpanStart: text('observed_span_start').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    index('idx_sme_effective').on(table.effectiveDate),
    index('idx_sme_code_effective').on(table.standardCode, table.effectiveDate),
  ],
);

/** 수집 완료 구간. 휴장일도 구간에 포함한다 — 이벤트만 없다 */
export const symbolMasterCoverage = sqliteTable('symbol_master_coverage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  syncedAtMs: integer('synced_at_ms').notNull(),
});

/** 시총 랭킹 레이지 캐시 — 백테스트가 요청한 날짜만 쌓인다 (스펙 §데이터 모델) */
export const symbolMasterMarketCaps = sqliteTable(
  'symbol_master_market_caps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    date: text('date').notNull(),
    standardCode: text('standard_code').notNull(),
    marketCapKrw: text('market_cap_krw').notNull(),
  },
  (table) => [uniqueIndex('idx_smmc_date_code').on(table.date, table.standardCode)],
);
```

- [ ] **Step 4: 마이그레이션 생성**

Run: `pnpm drizzle-kit generate --name symbol_master`
Expected: `migrations/0004_*.sql` 생성, 테이블 5개 CREATE.

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/symbol-master-schema.test.ts`
Expected: PASS (createTestApp 이 마이그레이션을 적용한다).

- [ ] **Step 6: 커밋**

```bash
git add src/server/shared/db/schema.ts migrations tests/unit/symbol-master-schema.test.ts
git commit -m "feat(symbol-master): 종목 마스터 테이블 5개를 추가한다"
```

---

### Task 2: 도메인 — 유니버스 상태와 diff

**Files:**
- Create: `src/server/modules/market-data/domain/symbol-master.ts`
- Test: `tests/unit/symbol-master-diff.test.ts`

**Interfaces:**
- Consumes: `KrxMarket` (krx-universe-types), `KrxExclusionReason` (krx-filter-policy)
- Produces:

```typescript
export type SymbolMasterInstrumentType = 'COMMON_STOCK' | KrxExclusionReason;

export interface SymbolMasterEntry {
  readonly standardCode: string;
  readonly shortCode: string;
  readonly name: string;
  readonly market: KrxMarket;
  readonly sharesOutstanding: string;
  readonly instrumentType: SymbolMasterInstrumentType;
  readonly listedDate: string | null;
}

export type UniverseState = ReadonlyMap<string, SymbolMasterEntry>; // key = standardCode

export type SymbolMasterEventType =
  | 'LISTED' | 'DELISTED' | 'MARKET_MOVED'
  | 'SHARES_CHANGED' | 'NAME_CHANGED' | 'TYPE_CHANGED';

export interface SymbolMasterEventDraft {
  readonly effectiveDate: string;
  readonly standardCode: string;
  readonly eventType: SymbolMasterEventType;
  readonly oldValue: string | null; // JSON 문자열
  readonly newValue: string | null;
  readonly observedSpanStart: string;
}

export function diffUniverse(
  prev: UniverseState,
  next: UniverseState,
  meta: { effectiveDate: string; observedSpanStart: string },
): SymbolMasterEventDraft[];
```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/unit/symbol-master-diff.test.ts
import { describe, expect, it } from 'vitest';
import {
  diffUniverse,
  type SymbolMasterEntry,
  type UniverseState,
} from '../../src/server/modules/market-data/domain/symbol-master.js';

function entry(overrides: Partial<SymbolMasterEntry> = {}): SymbolMasterEntry {
  return {
    standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자',
    market: 'KOSPI', sharesOutstanding: '100', instrumentType: 'COMMON_STOCK',
    listedDate: '1975-06-11', ...overrides,
  };
}
function state(...entries: SymbolMasterEntry[]): UniverseState {
  return new Map(entries.map((e) => [e.standardCode, e]));
}
const META = { effectiveDate: '2023-01-03', observedSpanStart: '2023-01-02' };

describe('diffUniverse', () => {
  it('변화가 없으면 이벤트가 없다', () => {
    expect(diffUniverse(state(entry()), state(entry()), META)).toEqual([]);
  });

  it('신규 종목은 LISTED, newValue 에 entry 전체를 담는다', () => {
    const e = entry();
    const events = diffUniverse(state(), state(e), META);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'LISTED', standardCode: e.standardCode,
      oldValue: null, effectiveDate: '2023-01-03', observedSpanStart: '2023-01-02',
    });
    expect(JSON.parse(events[0]!.newValue!)).toEqual(e);
  });

  it('사라진 종목은 DELISTED, oldValue 에 entry 전체를 담는다', () => {
    const e = entry();
    const events = diffUniverse(state(e), state(), META);
    expect(events[0]).toMatchObject({ eventType: 'DELISTED', newValue: null });
    expect(JSON.parse(events[0]!.oldValue!)).toEqual(e);
  });

  it('필드 변경은 필드별 이벤트를 만든다', () => {
    const prev = entry();
    const next = entry({ sharesOutstanding: '90', market: 'KOSDAQ' });
    const events = diffUniverse(state(prev), state(next), META);
    const types = events.map((ev) => ev.eventType).sort();
    expect(types).toEqual(['MARKET_MOVED', 'SHARES_CHANGED']);
    const shares = events.find((ev) => ev.eventType === 'SHARES_CHANGED')!;
    expect(JSON.parse(shares.oldValue!)).toBe('100');
    expect(JSON.parse(shares.newValue!)).toBe('90');
  });

  it('이름·유형 변경도 감지한다', () => {
    const next = entry({ name: '삼성전자우', instrumentType: 'PREFERRED_STOCK' });
    const types = diffUniverse(state(entry()), state(next), META)
      .map((ev) => ev.eventType).sort();
    expect(types).toEqual(['NAME_CHANGED', 'TYPE_CHANGED']);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `pnpm vitest run tests/unit/symbol-master-diff.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

```typescript
// src/server/modules/market-data/domain/symbol-master.ts
import type { KrxExclusionReason } from './krx-filter-policy.js';
import type { KrxMarket } from './krx-universe-types.js';

// (Interfaces 블록의 타입 선언 전부 여기 정의)

/** 필드 이벤트 매핑 — 순회 순서가 곧 이벤트 생성 순서다 */
const FIELD_EVENTS = [
  ['market', 'MARKET_MOVED'],
  ['sharesOutstanding', 'SHARES_CHANGED'],
  ['name', 'NAME_CHANGED'],
  ['instrumentType', 'TYPE_CHANGED'],
] as const satisfies ReadonlyArray<readonly [keyof SymbolMasterEntry, SymbolMasterEventType]>;

export function diffUniverse(
  prev: UniverseState,
  next: UniverseState,
  meta: { effectiveDate: string; observedSpanStart: string },
): SymbolMasterEventDraft[] {
  const events: SymbolMasterEventDraft[] = [];
  const base = { effectiveDate: meta.effectiveDate, observedSpanStart: meta.observedSpanStart };

  for (const [code, nextEntry] of next) {
    const prevEntry = prev.get(code);
    if (!prevEntry) {
      events.push({ ...base, standardCode: code, eventType: 'LISTED',
        oldValue: null, newValue: JSON.stringify(nextEntry) });
      continue;
    }
    for (const [field, eventType] of FIELD_EVENTS) {
      if (prevEntry[field] !== nextEntry[field]) {
        events.push({ ...base, standardCode: code, eventType,
          oldValue: JSON.stringify(prevEntry[field]),
          newValue: JSON.stringify(nextEntry[field]) });
      }
    }
  }
  for (const [code, prevEntry] of prev) {
    if (!next.has(code)) {
      events.push({ ...base, standardCode: code, eventType: 'DELISTED',
        oldValue: JSON.stringify(prevEntry), newValue: null });
    }
  }
  return events;
}
```

주의: `listedDate` 변경은 이벤트로 만들지 않는다 — KRX 원문 보정으로 값이 흔들릴 수 있고 구성원부 의미가 없다.

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/unit/symbol-master-diff.test.ts` → PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/domain/symbol-master.ts tests/unit/symbol-master-diff.test.ts
git commit -m "feat(symbol-master): 유니버스 diff 도메인을 추가한다"
```

---

### Task 3: 도메인 — 이벤트 적용(순·역방향)

**Files:**
- Modify: `src/server/modules/market-data/domain/symbol-master.ts`
- Test: `tests/unit/symbol-master-apply.test.ts`

**Interfaces:**
- Produces:

```typescript
export function applyEventsForward(
  state: UniverseState, events: readonly SymbolMasterEventDraft[],
): UniverseState;
export function applyEventsBackward(
  state: UniverseState, events: readonly SymbolMasterEventDraft[],
): UniverseState;
```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/unit/symbol-master-apply.test.ts
import { describe, expect, it } from 'vitest';
import {
  applyEventsBackward, applyEventsForward, diffUniverse,
  type SymbolMasterEntry, type UniverseState,
} from '../../src/server/modules/market-data/domain/symbol-master.js';

// entry()/state() 헬퍼는 diff 테스트와 동일하게 정의한다
function entry(overrides: Partial<SymbolMasterEntry> = {}): SymbolMasterEntry {
  return {
    standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자',
    market: 'KOSPI', sharesOutstanding: '100', instrumentType: 'COMMON_STOCK',
    listedDate: '1975-06-11', ...overrides,
  };
}
function state(...entries: SymbolMasterEntry[]): UniverseState {
  return new Map(entries.map((e) => [e.standardCode, e]));
}
const META = { effectiveDate: '2023-01-03', observedSpanStart: '2023-01-02' };

describe('이벤트 적용', () => {
  const a = state(
    entry(),
    entry({ standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스' }),
  );
  const b = state(
    entry({ sharesOutstanding: '90', name: '삼성전자(변경)' }),
    entry({ standardCode: 'KR7999999999', shortCode: '999999', name: '신규상장' }),
  );

  it('apply(diff(a,b), a) == b — 순방향 왕복', () => {
    const events = diffUniverse(a, b, META);
    expect(applyEventsForward(a, events)).toEqual(b);
  });

  it('applyBackward(diff(a,b), b) == a — 역방향 왕복', () => {
    const events = diffUniverse(a, b, META);
    expect(applyEventsBackward(b, events)).toEqual(a);
  });

  it('같은 이벤트를 두 번 적용해도 결과가 같다 — 절대값 멱등성', () => {
    const events = diffUniverse(a, b, META);
    const once = applyEventsForward(a, events);
    expect(applyEventsForward(once, events)).toEqual(once);
  });
});
```

- [ ] **Step 2: 실행해 실패 확인** — Expected: FAIL, `applyEventsForward` 없음.

- [ ] **Step 3: 구현**

```typescript
const FIELD_BY_EVENT = {
  MARKET_MOVED: 'market',
  SHARES_CHANGED: 'sharesOutstanding',
  NAME_CHANGED: 'name',
  TYPE_CHANGED: 'instrumentType',
} as const;

export function applyEventsForward(
  state: UniverseState, events: readonly SymbolMasterEventDraft[],
): UniverseState {
  const next = new Map(state);
  for (const ev of events) {
    if (ev.eventType === 'LISTED') {
      next.set(ev.standardCode, JSON.parse(ev.newValue!) as SymbolMasterEntry);
    } else if (ev.eventType === 'DELISTED') {
      next.delete(ev.standardCode);
    } else {
      const current = next.get(ev.standardCode);
      if (!current) continue; // 갭 수집이 만든 중복 이벤트 — 절대값이라 건너뛰어도 안전하다
      const field = FIELD_BY_EVENT[ev.eventType];
      next.set(ev.standardCode, { ...current, [field]: JSON.parse(ev.newValue!) });
    }
  }
  return next;
}

export function applyEventsBackward(
  state: UniverseState, events: readonly SymbolMasterEventDraft[],
): UniverseState {
  const next = new Map(state);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.eventType === 'LISTED') {
      next.delete(ev.standardCode);
    } else if (ev.eventType === 'DELISTED') {
      next.set(ev.standardCode, JSON.parse(ev.oldValue!) as SymbolMasterEntry);
    } else {
      const current = next.get(ev.standardCode);
      if (!current) continue;
      const field = FIELD_BY_EVENT[ev.eventType];
      next.set(ev.standardCode, { ...current, [field]: JSON.parse(ev.oldValue!) });
    }
  }
  return next;
}
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/unit/symbol-master-apply.test.ts` → PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/domain/symbol-master.ts tests/unit/symbol-master-apply.test.ts
git commit -m "feat(symbol-master): 이벤트 순·역방향 적용을 추가한다"
```

---

### Task 4: KRX 계약 확장 — 상장주식수

**Files:**
- Modify: `src/server/modules/market-data/domain/krx-universe-types.ts` (`KrxIssueBaseInfoRow`)
- Modify: `src/server/modules/market-data/infrastructure/krx/krx-contract.ts` (`baseInfoRowSchema`, `parseBaseInfoRows`)
- Modify: `tests/helpers/krx-fixtures.ts` (`baseInfoFixture` 에 `LIST_SHRS` 추가)
- Test: `tests/unit/krx-contract.test.ts` (기존 파일에 케이스 추가; 없으면 생성)

**Interfaces:**
- Produces: `KrxIssueBaseInfoRow.listedShares: string | null` — 10진 정수 문자열.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
it('LIST_SHRS 를 listedShares 정수 문자열로 파싱한다', () => {
  const rows = parseBaseInfoRows([{ ...baseInfoFixture(), LIST_SHRS: '5,969,782,550' }]);
  expect(rows[0]!.listedShares).toBe('5969782550');
});

it('LIST_SHRS 가 없거나 - 이면 null 이다', () => {
  const rows = parseBaseInfoRows([{ ...baseInfoFixture(), LIST_SHRS: '-' }]);
  expect(rows[0]!.listedShares).toBeNull();
});
```

- [ ] **Step 2: 실행해 실패 확인** — Expected: FAIL, `listedShares` 프로퍼티 없음(타입 오류).

- [ ] **Step 3: 구현**

`krx-universe-types.ts` — `KrxIssueBaseInfoRow` 에 추가:

```typescript
  /** LIST_SHRS — 상장주식수. 콤마 없는 10진 정수 문자열, 알 수 없으면 null 이다. */
  readonly listedShares: string | null;
```

`krx-contract.ts`:

```typescript
const baseInfoRowSchema = z.object({
  // ...기존 필드...
  LIST_SHRS: z.string().nullable().optional(),
}).loose();

// parseBaseInfoRows 반환 객체에:
      listedShares: (() => {
        const shares = parseNullableInt64(row.LIST_SHRS, 'LIST_SHRS');
        return shares === null ? null : shares.toString();
      })(),
```

`krx-fixtures.ts` — `baseInfoFixture` 기본값에 `LIST_SHRS: '1,000,000'` 추가.

- [ ] **Step 4: 전체 단위 테스트 통과 확인** — Run: `pnpm vitest run tests/unit` → PASS (기존 소비처 회귀 없음 확인)

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/domain/krx-universe-types.ts src/server/modules/market-data/infrastructure/krx/krx-contract.ts tests/helpers/krx-fixtures.ts tests/unit/krx-contract.test.ts
git commit -m "feat(krx): 기본정보 계약에 상장주식수를 추가한다"
```

---

### Task 5: SymbolMasterService — 체크포인트 저장·재구성

**Files:**
- Create: `src/server/modules/market-data/application/symbol-master-service.ts`
- Test: `tests/unit/symbol-master-service.test.ts`

**Interfaces:**
- Consumes: Task 1 테이블, Task 2·3 도메인 함수
- Produces:

```typescript
export interface SymbolMasterServiceDeps {
  readonly db: AppDatabase;            // container 의 drizzle 인스턴스 타입
  readonly source: KrxHistoricalUniverseSource;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class SymbolMasterService {
  constructor(deps: SymbolMasterServiceDeps);
  saveCheckpoint(date: string, state: UniverseState, verified: boolean,
    mismatch?: object): string;        // checkpoint id 반환
  getUniverseAsOf(date: string): UniverseState;  // 체크포인트 + 이벤트 재구성
  coverageRanges(): { startDate: string; endDate: string }[];
  isCovered(date: string): boolean;
  listEvents(from: string, to: string): SymbolMasterEventRow[]; // DB row + id
}
```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// tests/unit/symbol-master-service.test.ts
// createTestApp 으로 인메모리 DB 확보, source 는 이 태스크에선 미사용(더미 전달).
describe('getUniverseAsOf', () => {
  it('체크포인트 이후 날짜: 순방향 이벤트 적용', async () => {
    const t = await createTestApp();
    const svc = makeService(t); // deps 조립 헬퍼 — source 는 더미
    svc.saveCheckpoint('2023-01-02', state(entry()), true);
    insertEvent(t, { effectiveDate: '2023-01-03', eventType: 'SHARES_CHANGED',
      standardCode: 'KR7005930003', oldValue: '"100"', newValue: '"90"',
      observedSpanStart: '2023-01-02' });
    expect(svc.getUniverseAsOf('2023-01-03').get('KR7005930003')!.sharesOutstanding)
      .toBe('90');
    // 이벤트 이전 날짜는 체크포인트 그대로
    expect(svc.getUniverseAsOf('2023-01-02').get('KR7005930003')!.sharesOutstanding)
      .toBe('100');
    await t.close();
  });

  it('체크포인트 이전 날짜: 역방향 적용', async () => {
    // 체크포인트 2023-04-03, 이벤트 2023-02-01 SHARES 100→90 이면
    // getUniverseAsOf('2023-01-15') 는 100 이어야 한다
  });

  it('가장 가까운 체크포인트를 고른다 — 두 체크포인트 사이 날짜', async () => {
    // cp 2023-01-02, cp 2023-04-03. date=2023-03-01 → 1월 cp 에서 순방향
  });
});
```

역방향·최근접 케이스도 첫 케이스와 같은 구조로 전체 코드를 작성한다(체크포인트 2개 저장 → 이벤트 삽입 → 기대 상태 단언).

- [ ] **Step 2: 실행해 실패 확인** — Expected: FAIL, 모듈 없음.

- [ ] **Step 3: 구현**

```typescript
export class SymbolMasterService {
  constructor(private readonly deps: SymbolMasterServiceDeps) {}

  saveCheckpoint(date: string, state: UniverseState, verified: boolean,
    mismatch?: object): string {
    const id = crypto.randomUUID();
    const now = this.deps.clock.now().getTime();
    this.deps.db.transaction((tx) => {
      tx.insert(symbolMasterCheckpoints).values({
        id, checkpointDate: date, source: 'KRX',
        verifiedAtMs: verified ? now : null,
        mismatchJson: mismatch ? JSON.stringify(mismatch) : null,
        createdAtMs: now,
      }).run();
      const rows = [...state.values()].map((e) => ({ checkpointId: id, ...e }));
      // SQLite 변수 한도를 피하려 500개 단위로 나눠 넣는다
      for (let i = 0; i < rows.length; i += 500) {
        tx.insert(symbolMasterCheckpointSymbols).values(rows.slice(i, i + 500)).run();
      }
    });
    return id;
  }

  getUniverseAsOf(date: string): UniverseState {
    const cp = this.nearestCheckpoint(date);
    if (!cp) throw new SymbolMasterNotCoveredError(date);
    const symbols = this.deps.db.select().from(symbolMasterCheckpointSymbols)
      .where(eq(symbolMasterCheckpointSymbols.checkpointId, cp.id)).all();
    const base: UniverseState = new Map(symbols.map((s) => [s.standardCode, {
      standardCode: s.standardCode, shortCode: s.shortCode, name: s.name,
      market: s.market as KrxMarket, sharesOutstanding: s.sharesOutstanding,
      instrumentType: s.instrumentType as SymbolMasterInstrumentType,
      listedDate: s.listedDate,
    }]));
    if (date >= cp.checkpointDate) {
      const events = this.eventsBetween(afterDate(cp.checkpointDate), date); // (cp, date]
      return applyEventsForward(base, events);
    }
    const events = this.eventsBetween(afterDate(date), cp.checkpointDate);   // (date, cp]
    return applyEventsBackward(base, events);
  }
  // nearestCheckpoint: |checkpointDate - date| 최소. 동률이면 과거 쪽.
  // eventsBetween: effectiveDate 오름차순, id 오름차순 정렬 — 같은 날 이벤트 순서 보존.
}

export class SymbolMasterNotCoveredError extends Error {
  constructor(readonly date: string) {
    super(`종목 마스터가 ${date} 를 커버하지 않는다`);
    this.name = 'SymbolMasterNotCoveredError';
  }
}
```

`afterDate(iso)` 는 lexicographic 비교를 위한 `iso + ' '` 트릭 대신 `gt()` 조건으로 처리한다 — drizzle `and(gt(effectiveDate, from), lte(effectiveDate, to))`.

coverageRanges/isCovered/listEvents 는 단순 select — coverage 는 startDate 오름차순 정렬로 반환한다.

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/unit/symbol-master-service.test.ts` → PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/symbol-master-service.ts tests/unit/symbol-master-service.test.ts
git commit -m "feat(symbol-master): 체크포인트 저장과 시점 재구성을 추가한다"
```

---

### Task 6: SymbolMasterService.ingestDate

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts`
- Test: `tests/unit/symbol-master-ingest.test.ts`

**Interfaces:**
- Consumes: `KrxHistoricalUniverseSource.fetchIssueBaseInfo/fetchDailyTrades`, `classifyKrxIssue`, Task 5 메서드
- Produces:

```typescript
export type IngestResult =
  | { readonly kind: 'TRADING_DAY'; readonly eventCount: number; readonly checkpointSaved: boolean }
  | { readonly kind: 'HOLIDAY' }
  | { readonly kind: 'ALREADY_COVERED' };

async ingestDate(date: string): Promise<IngestResult>;
```

동작 규약:
1. 이미 coverage 안이면 `ALREADY_COVERED` — KRX 호출 없음.
2. KOSPI·KOSDAQ 일별매매 조회 — 두 시장 모두 0행이면 휴장: coverage 만 확장하고 `HOLIDAY`.
3. 거래일이면 기본정보 조회 → `classifyKrxIssue` 로 instrumentType 부여(모든 종목 저장, 분류 불가면 오류 전파) → `UniverseState` 구성. `listedShares` null 이면 `'0'` 대신 그대로 실패시키지 않고 `'-1'` 도 아니다 — `sharesOutstanding` 은 null 허용이 아니므로 `'0'` 으로 넣고 warn 로그를 남긴다(과거 응답 누락 방어).
4. 직전 커버일이 없으면(최초 수집) 체크포인트로 저장, 이벤트 없음.
5. 있으면 `diffUniverse(getUniverseAsOf(직전 커버일), fetched, {effectiveDate: date, observedSpanStart: 직전 커버일})` → 이벤트 삽입.
6. **갭 메우기 재계산**: date 보다 뒤의 커버 구간이 있으면, 그 구간 첫 거래일 D2 의 기존 이벤트를 지우고 `diffUniverse(fetched, getUniverseAsOf(D2), {effectiveDate: D2, observedSpanStart: date})` 로 재삽입 — 중복 이벤트가 피드에 남지 않게 한다. (재구성 정확성 자체는 절대값 멱등성으로 이미 보장된다.)
7. coverage 구간 병합(인접 [a,date-1]·[date+1,b] 와 합치기 — 날짜 산술은 `kst-date.ts` 의 유틸 재사용, 없으면 `addDaysIso()` 헬퍼 추가).
8. 분기 경계 체크포인트: Task 7.

- [ ] **Step 1: 실패하는 테스트 작성**

`startKrxFakeServer()` + `createConfiguredSource` 패턴(기존 `krx-historical-universe-source.test.ts` 참고)으로 작성한다. 핵심 케이스:

```typescript
it('최초 수집은 체크포인트를 만들고 이벤트가 없다', async () => {
  // fake: 2023-01-02 에 삼성전자 1종목 응답
  const result = await svc.ingestDate('2023-01-02');
  expect(result).toMatchObject({ kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: true });
  expect(svc.getUniverseAsOf('2023-01-02').size).toBe(1);
});

it('둘째 날 상장주식수 변경은 SHARES_CHANGED 하나를 만든다', async () => {
  // 01-02 수집 후 fake 응답의 LIST_SHRS 를 바꾸고 01-03 수집
  const result = await svc.ingestDate('2023-01-03');
  expect(result).toMatchObject({ kind: 'TRADING_DAY', eventCount: 1 });
});

it('두 시장 모두 빈 응답이면 휴장 — coverage 는 늘고 이벤트는 없다', async () => {
  expect(await svc.ingestDate('2023-01-01')).toEqual({ kind: 'HOLIDAY' });
  expect(svc.isCovered('2023-01-01')).toBe(true);
});

it('이미 커버된 날짜는 KRX 를 부르지 않는다', async () => {
  await svc.ingestDate('2023-01-02');
  const before = fake.requests.length;
  expect(await svc.ingestDate('2023-01-02')).toEqual({ kind: 'ALREADY_COVERED' });
  expect(fake.requests.length).toBe(before);
});

it('갭 메우기: 사이 날짜 수집이 다음 커버일 이벤트를 재계산한다', async () => {
  // 01-02 수집 → 01-05 수집(01-03~04 갭, 01-05 이벤트 span=01-02)
  // → 01-03 온디맨드 수집 후 01-05 이벤트의 observedSpanStart 가 01-03 으로 바뀐다
});
```

각 케이스는 fake 서버 `setResponse(path, basDd, response)` 로 날짜별 응답을 세팅해 전체 코드로 작성한다.

- [ ] **Step 2: 실행해 실패 확인** — Expected: FAIL, `ingestDate` 없음.

- [ ] **Step 3: 구현** — 동작 규약 1~7 순서대로. 이벤트 삽입과 coverage 갱신은 한 트랜잭션.

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/unit/symbol-master-ingest.test.ts` → PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/symbol-master-service.ts tests/unit/symbol-master-ingest.test.ts
git commit -m "feat(symbol-master): KRX 일별 ingest 와 갭 재계산을 추가한다"
```

---

### Task 7: 분기 체크포인트 검증

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts` (`ingestDate` 내부 확장)
- Test: `tests/unit/symbol-master-checkpoint.test.ts`

**Interfaces:**
- Produces: `ingestDate` 가 분기 경계에서 체크포인트를 저장하고 `checkpointSaved: true` 를 반환한다. 검증 결과는 `verifiedAtMs`/`mismatchJson` 에 남는다.

동작 규약: `ingestDate(date)` 성공 시, `quarterOf(date) !== quarterOf(직전 커버 거래일)` 이거나 이 분기에 체크포인트가 없으면:
1. `reconstructed = getUniverseAsOf(date)` — 방금 넣은 이벤트 포함 체인 재구성.
2. `fetched` (이번 ingest 의 KRX 실측) 와 비교.
3. 일치 → `saveCheckpoint(date, fetched, true)`.
4. 불일치 → `saveCheckpoint(date, fetched, false, {added, removed, changed})` + `logger.warn`. 이후 재구성은 이 체크포인트에서 시작하므로 오류가 전파되지 않는다.

`quarterOf(iso)` 는 `'2023-Q2'` 형식 문자열을 만드는 순수 함수 — `symbol-master.ts` 도메인에 둔다.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
it('분기 경계를 넘는 ingest 가 체크포인트를 만든다', async () => {
  // 03-31 수집(1분기) → 04-03 수집(2분기) → checkpoints 에 04-03 존재, verifiedAtMs 채워짐
});

it('저장 손상 시 mismatch 를 기록하고 실측으로 교정한다', async () => {
  // 04-03 ingest 직전에 이벤트 한 행을 직접 UPDATE 로 오염
  // → mismatchJson 채워지고, 이후 getUniverseAsOf('2023-04-03') 은 실측과 같다
});
```

두 케이스 모두 fake 서버 세팅 포함 전체 코드로 작성한다.

- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: PASS 확인**

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/symbol-master-service.ts src/server/modules/market-data/domain/symbol-master.ts tests/unit/symbol-master-checkpoint.test.ts
git commit -m "feat(symbol-master): 분기 경계 체크포인트 검증을 추가한다"
```

---

### Task 8: 시총 랭킹 레이지 캐시

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts`
- Test: `tests/unit/symbol-master-market-caps.test.ts`

**Interfaces:**
- Produces:

```typescript
/** date 의 시총 맵 (standardCode → marketCapKrw 문자열). 캐시 미스면 KRX 조회 후 저장. */
async getMarketCapsAt(date: string): Promise<ReadonlyMap<string, string>>;
```

동작 규약:
1. `symbolMasterMarketCaps` 에 date 행이 있으면 그대로 반환 — KRX 호출 없음.
2. 미스면 KOSPI·KOSDAQ `fetchDailyTrades(date)` (2호출). 일별 행의 `shortCode` 를 `getUniverseAsOf(date)` 의 shortCode→standardCode 매핑으로 변환한다 — 마스터에 없는 단축코드는 건너뛴다(경고 로그). `marketCapRaw` null 도 건너뛴다.
3. 결과를 캐시 테이블에 저장 후 반환. date 가 커버 밖이면 `SymbolMasterNotCoveredError`.

- [ ] **Step 1: 실패하는 테스트 작성** — 캐시 미스 1회 조회 → 같은 date 재호출 시 fake 서버 요청 수 불변 단언. 미커버 날짜 오류 단언. 전체 코드로 작성.

- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: PASS**

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/symbol-master-service.ts tests/unit/symbol-master-market-caps.test.ts
git commit -m "feat(symbol-master): 시총 레이지 캐시를 추가한다"
```

---

### Task 9: 백필 러너

**Files:**
- Create: `src/server/modules/market-data/application/symbol-master-backfill.ts`
- Test: `tests/unit/symbol-master-backfill.test.ts`

**Interfaces:**
- Consumes: `SymbolMasterService.ingestDate/coverageRanges`, `KrxHistoricalUniverseSource.todayCallCount`
- Produces:

```typescript
export interface BackfillStatus {
  readonly state: 'IDLE' | 'RUNNING' | 'BUDGET_EXHAUSTED' | 'FAILED';
  readonly cursorDate: string | null;   // 다음 수집 대상
  readonly targetStartDate: string | null;
  readonly error: string | null;
}

export class SymbolMasterBackfill {
  constructor(deps: { service: SymbolMasterService; source: KrxHistoricalUniverseSource;
    clock: Clock; logger: Logger; dailyCallBudget: number });  // 기본 8000
  start(fromDate: string): void;   // 이미 RUNNING 이면 무시. 비동기 루프 시작.
  status(): BackfillStatus;
  stop(): void;                    // 진행 중 루프를 다음 날짜 경계에서 멈춘다
}
```

동작 규약:
- 루프: `cursor = fromDate` 부터 오늘(KST)까지 오름차순. 이미 커버된 날짜는 `ALREADY_COVERED` 로 통과(호출 없음) — 재개가 공짜다.
- 매 날짜 전에 `source.todayCallCount() + 4 > dailyCallBudget` 이면 `BUDGET_EXHAUSTED` 로 정지. 다음 `start()` (스케줄러가 매일 부른다) 가 이어간다.
- `KrxQuotaError` (429) 도 `BUDGET_EXHAUSTED` 처리. 그 외 오류는 `FAILED` + error 저장.
- 상태는 메모리 싱글턴 — 진행 위치는 coverage 가 이미 영속하므로 별도 저장이 없다.
- 날짜 사이 지연은 `RestClient` 의 `groupMinIntervalMs` (250ms) 가 이미 담당한다.

- [ ] **Step 1: 실패하는 테스트 작성** — fake 서버로 3영업일 범위 백필 완주, 예산 소진 정지(`dailyCallBudget: 4` 로 두 날짜째에서 멈춤) 후 `start()` 재개 완주, 429 응답 시 `BUDGET_EXHAUSTED`. 루프 종료 대기는 `await vi.waitFor(() => expect(runner.status().state).toBe('IDLE'))` 패턴.

- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: PASS**

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/symbol-master-backfill.ts tests/unit/symbol-master-backfill.test.ts
git commit -m "feat(symbol-master): 호출 예산 기반 백필 러너를 추가한다"
```

---

### Task 10: 일일 동기화 스케줄러

**Files:**
- Create: `src/server/modules/market-data/application/symbol-master-scheduler.ts`
- Test: `tests/unit/symbol-master-scheduler.test.ts`

**Interfaces:**
- Produces:

```typescript
export class SymbolMasterScheduler {
  constructor(deps: { service: SymbolMasterService; backfill: SymbolMasterBackfill;
    clock: Clock; logger: Logger });
  /** JobOrchestrator 처럼 외부 타이머가 주기 호출한다 (server 부트스트랩에서 1시간 간격) */
  async tick(): Promise<void>;
}
```

동작 규약:
- KST 18:00 이전이면 아무것도 안 한다 (장 마감·KRX 집계 여유).
- 마지막 커버일 < 어제(KST) 이면 그 다음날부터 어제까지 `ingestDate` 순차 실행 — 갭 자동 보정.
- 백필이 `BUDGET_EXHAUSTED` 면 `backfill.start(원래 fromDate)` 재호출 — 날짜가 바뀌어 예산이 리셋됐을 때 이어가게 한다.
- 오늘 이미 돌았으면(마지막 커버일 == 어제) no-op.

- [ ] **Step 1: 실패하는 테스트 작성** — 가짜 Clock 으로 17시(no-op)·19시(ingest 호출) 분기, 갭 3일 보정, no-op 멱등성. `service` 는 vi.fn 스텁.

- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: PASS**

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/symbol-master-scheduler.ts tests/unit/symbol-master-scheduler.test.ts
git commit -m "feat(symbol-master): 일일 동기화 스케줄러를 추가한다"
```

---

### Task 11: DTO·라우트·컨테이너 배선

**Files:**
- Create: `src/shared/schemas/symbol-master.ts`
- Create: `src/server/modules/market-data/presentation/symbol-master-routes.ts`
- Modify: `src/server/bootstrap/container.ts` (서비스·백필·스케줄러 생성)
- Modify: `src/server/bootstrap/server.ts` (라우트 등록 + 스케줄러 타이머)
- Test: `tests/integration/symbol-master-routes.test.ts`

**Interfaces:**
- Produces (zod DTO):

```typescript
// src/shared/schemas/symbol-master.ts
export const symbolMasterEntryDtoSchema = z.object({
  standardCode: z.string(), shortCode: z.string(), name: z.string(),
  market: z.enum(['KOSPI', 'KOSDAQ']), sharesOutstanding: z.string(),
  instrumentType: z.string(), listedDate: z.string().nullable(),
});
export const symbolMasterUniverseDtoSchema = z.object({
  date: z.string(), covered: z.boolean(),
  symbols: z.array(symbolMasterEntryDtoSchema),   // covered=false 면 빈 배열
});
export const symbolMasterCoverageDtoSchema = z.object({
  ranges: z.array(z.object({ startDate: z.string(), endDate: z.string() })),
  checkpoints: z.array(z.object({
    checkpointDate: z.string(), verified: z.boolean(), mismatch: z.boolean(),
  })),
  lastSyncedAtMs: z.number().nullable(),
  backfill: z.object({
    state: z.enum(['IDLE', 'RUNNING', 'BUDGET_EXHAUSTED', 'FAILED']),
    cursorDate: z.string().nullable(), error: z.string().nullable(),
  }),
});
export const symbolMasterEventDtoSchema = z.object({
  id: z.number(), effectiveDate: z.string(), standardCode: z.string(),
  eventType: z.string(), oldValue: z.string().nullable(),
  newValue: z.string().nullable(), observedSpanStart: z.string(),
});
// 대응하는 z.infer 타입도 export
```

- Produces (라우트 — 전부 requireAuth, `/api/v1` prefix 는 server.ts 가 담당):

| Method | Path | 동작 |
|---|---|---|
| GET | `/symbol-master/universe?date=` | 재구성. 미커버면 `covered:false` + 빈 배열 (200) |
| GET | `/symbol-master/coverage` | 구간·체크포인트·백필 상태 |
| GET | `/symbol-master/events?from=&to=` | 이벤트 목록 (최대 500행, effectiveDate 내림차순) |
| POST | `/symbol-master/sync` body `{date}` | 온디맨드 `ingestDate`. 결과 IngestResult 반환. KrxQuotaError → 429, KrxNotConfiguredError → 503 |
| POST | `/symbol-master/backfill` body `{fromDate}` | `backfill.start` 후 status 반환 (202) |

registerSymbolMasterRoutes 시그니처는 기존 `registerUniverseRoutes` 패턴을 따른다:

```typescript
export function registerSymbolMasterRoutes(
  app: FastifyInstance,
  deps: { service: SymbolMasterService; backfill: SymbolMasterBackfill },
  requireAuth: preHandlerHookHandler,
): void;
```

- [ ] **Step 1: 실패하는 통합 테스트 작성** — `createTestApp` + fake KRX 서버(환경변수로 baseUrl 주입, 기존 테스트 선례 참고). 케이스: sync → universe 조회 왕복, 미커버 universe `covered:false`, coverage 형태, events 반환, 인증 없는 요청 401. 전체 코드로 작성.

- [ ] **Step 2: 실패 확인** — Expected: FAIL 404.

- [ ] **Step 3: 구현** — 라우트 + container 배선(`SymbolMasterService`/`SymbolMasterBackfill`/`SymbolMasterScheduler` 생성, `dailyCallBudget` 은 env `KRX_DAILY_CALL_BUDGET` 기본 8000) + server.ts 등록. 스케줄러 타이머는 JobOrchestrator 타이머와 같은 위치에서 `setInterval(() => scheduler.tick(), 3_600_000)` — 서버 종료 훅에서 clear.

- [ ] **Step 4: PASS 확인** — Run: `pnpm vitest run tests/integration/symbol-master-routes.test.ts && pnpm typecheck && pnpm lint`

- [ ] **Step 5: 커밋**

```bash
git add src/shared/schemas/symbol-master.ts src/server/modules/market-data/presentation/symbol-master-routes.ts src/server/bootstrap tests/integration/symbol-master-routes.test.ts
git commit -m "feat(symbol-master): API 라우트와 컨테이너 배선을 추가한다"
```

---

## 완료 기준

- `pnpm test && pnpm lint && pnpm typecheck` 전부 통과.
- fake KRX 로 최초 수집→이벤트→분기 체크포인트→재구성 왕복이 통합 테스트로 입증됨.
- 기존 datasets/universeSnapshots 경로는 아직 그대로 동작(제거는 backtest 계획).
